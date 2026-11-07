import {
  bytes,
  clock,
  type DocClock,
  type DocRecord,
  type ErrorCode,
  errorCode,
  exactKeys,
  identifier,
  MAX_IN_FLIGHT,
  MAX_QUEUED_BYTES,
  PROTOCOL_VERSION,
  record,
  type Request,
  requestId,
  StorageBridgeError,
} from './protocol';

type Pending = {
  op: 'getDoc' | 'pushUpdate';
  docId: string;
  cost: number;
  resolve(value: DocRecord | DocClock | null): void;
  reject(error: StorageBridgeError): void;
  cleanup(): void;
};

/** No native globals or window messaging. Authority is the directly transferred private port. */
export class WorkerStorageClient {
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private queuedBytes = 0;
  private closed = false;

  constructor(
    private readonly port: MessagePort,
    private readonly timeoutMs = 30_000
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 300_000
    )
      throw new StorageBridgeError('INVALID_INPUT');
    port.addEventListener('message', this.onMessage);
    port.addEventListener('messageerror', this.onMessageError);
    port.start();
  }

  getDoc(docId: string, signal?: AbortSignal): Promise<DocRecord | null> {
    return this.call(
      'getDoc',
      docId,
      undefined,
      signal
    ) as Promise<DocRecord | null>;
  }
  pushUpdate(
    docId: string,
    data: Uint8Array,
    signal?: AbortSignal
  ): Promise<DocClock> {
    return this.call('pushUpdate', docId, data, signal) as Promise<DocClock>;
  }

  dispose(reason: ErrorCode = 'CLOSED') {
    if (this.closed) return;
    this.closed = true;
    try {
      this.port.postMessage({
        version: PROTOCOL_VERSION,
        type: 'close',
      } satisfies Request);
    } catch {
      /* Already disconnected. */
    }
    this.port.removeEventListener('message', this.onMessage);
    this.port.removeEventListener('messageerror', this.onMessageError);
    for (const id of this.pending.keys())
      this.finish(id, new StorageBridgeError(reason));
    this.port.close();
  }

  private call(
    op: Pending['op'],
    docId: string,
    data?: Uint8Array,
    signal?: AbortSignal
  ): Promise<DocRecord | DocClock | null> {
    if (this.closed) return Promise.reject(new StorageBridgeError('CLOSED'));
    if (
      !identifier(docId) ||
      (op === 'pushUpdate' && (!bytes(data) || data.byteLength === 0))
    )
      return Promise.reject(new StorageBridgeError('INVALID_INPUT'));
    if (signal?.aborted)
      return Promise.reject(new StorageBridgeError('CANCELLED'));
    const cost = data?.byteLength ?? 0;
    if (
      this.pending.size >= MAX_IN_FLIGHT ||
      this.queuedBytes + cost > MAX_QUEUED_BYTES
    )
      return Promise.reject(new StorageBridgeError('RESOURCE_LIMIT'));
    if (this.nextId >= Number.MAX_SAFE_INTEGER) {
      this.dispose('PROTOCOL');
      return Promise.reject(new StorageBridgeError('PROTOCOL'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!this.pending.has(id)) return;
        try {
          this.port.postMessage({
            version: PROTOCOL_VERSION,
            type: 'cancel',
            id,
          } satisfies Request);
        } catch {
          this.dispose('PROTOCOL');
        }
        this.finish(id, new StorageBridgeError('CANCELLED'));
      };
      const timer = setTimeout(cancel, this.timeoutMs);
      this.pending.set(id, {
        op,
        docId,
        cost,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
        },
      });
      this.queuedBytes += cost;
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (op === 'getDoc') {
          this.port.postMessage({
            version: PROTOCOL_VERSION,
            type: 'call',
            id,
            op,
            docId,
          } satisfies Request);
        } else {
          // Copy before transfer: callers may retain the original CRDT update for reconciliation.
          if (!data) throw new StorageBridgeError('INVALID_INPUT');
          const copy = new Uint8Array(data);
          this.port.postMessage(
            {
              version: PROTOCOL_VERSION,
              type: 'call',
              id,
              op,
              docId,
              data: copy,
            } satisfies Request,
            [copy.buffer]
          );
        }
      } catch {
        this.dispose('PROTOCOL');
      }
    });
  }

  private finish(
    id: number,
    error?: StorageBridgeError,
    value?: DocRecord | DocClock | null
  ) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.queuedBytes -= entry.cost;
    entry.cleanup();
    if (error) entry.reject(error);
    else entry.resolve(value ?? null);
  }
  private readonly onMessageError = () => {
    this.dispose('PROTOCOL');
  };
  private readonly onMessage = (event: MessageEvent<unknown>) => {
    for (const port of event.ports ?? []) port.close();
    if (event.ports?.length) {
      this.dispose('PROTOCOL');
      return;
    }
    const message = event.data;
    if (!record(message) || message.version !== PROTOCOL_VERSION) {
      this.dispose('PROTOCOL');
      return;
    }
    if (
      message.type === 'closed' &&
      exactKeys(message, ['version', 'type', 'error']) &&
      errorCode(message.error)
    ) {
      this.dispose(message.error);
      return;
    }
    if (
      message.type !== 'result' ||
      !requestId(message.id) ||
      typeof message.ok !== 'boolean'
    ) {
      this.dispose('PROTOCOL');
      return;
    }
    const entry = this.pending.get(message.id);
    // A cancelled request can legitimately complete later. Never reuse request IDs.
    if (!entry) {
      if (message.id > this.nextId) this.dispose('PROTOCOL');
      return;
    }
    if (!message.ok) {
      if (
        !exactKeys(message, ['version', 'type', 'id', 'ok', 'error']) ||
        !errorCode(message.error)
      ) {
        this.dispose('PROTOCOL');
        return;
      }
      this.finish(message.id, new StorageBridgeError(message.error));
      return;
    }
    if (!exactKeys(message, ['version', 'type', 'id', 'ok', 'value'])) {
      this.dispose('PROTOCOL');
      return;
    }
    const value = message.value;
    if (entry.op === 'getDoc' && value === null) {
      this.finish(message.id, undefined, null);
      return;
    }
    if (!clock(value, entry.docId) || !record(value)) {
      this.dispose('PROTOCOL');
      return;
    }
    if (entry.op === 'getDoc') {
      if (
        !exactKeys(value, ['docId', 'timestampMs', 'data']) ||
        !bytes(value.data)
      ) {
        this.dispose('PROTOCOL');
        return;
      }
      this.finish(message.id, undefined, {
        docId: entry.docId,
        timestampMs: value.timestampMs,
        data: value.data,
      });
    } else {
      if (!exactKeys(value, ['docId', 'timestampMs'])) {
        this.dispose('PROTOCOL');
        return;
      }
      this.finish(message.id, undefined, {
        docId: entry.docId,
        timestampMs: value.timestampMs,
      });
    }
  };
}
