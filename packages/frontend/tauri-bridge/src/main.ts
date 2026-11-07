import {
  bytes,
  clock,
  type DocClock,
  type DocRecord,
  type ErrorCode,
  exactKeys,
  MAX_IN_FLIGHT,
  MAX_QUEUED_BYTES,
  parseRequest,
  PROTOCOL_VERSION,
  record,
  type Response,
  sanitizeError,
  StorageBridgeError,
} from './protocol';

/** A trusted host creates this session for one owner/space. None of its authority comes from port messages. */
export interface TrustedStorageSession {
  getDoc(docId: string, signal: AbortSignal): Promise<DocRecord | null>;
  pushUpdate(
    docId: string,
    data: Uint8Array,
    signal: AbortSignal
  ): Promise<DocClock>;
  close(): Promise<void>;
}

/** Bind only a directly transferred, host-created Worker port. This is not a window-message listener. */
export function bindStoragePort(
  port: MessagePort,
  session: TrustedStorageSession
) {
  const running = new Map<
    number,
    { controller: AbortController; cancelled: boolean }
  >();
  let closed = false;
  let lastId = 0;
  let queuedBytes = 0;
  let closing: Promise<void> | undefined;
  const send = (response: Response, transfer: Transferable[] = []) => {
    if (closed) return;
    try {
      port.postMessage(response, transfer);
    } catch {
      void dispose('PROTOCOL', false).catch(() => {});
    }
  };
  const dispose = (
    reason: ErrorCode = 'CLOSED',
    notify = true
  ): Promise<void> => {
    if (closing) return closing;
    if (notify) {
      try {
        port.postMessage({
          version: PROTOCOL_VERSION,
          type: 'closed',
          error: reason,
        } satisfies Response);
      } catch {
        /* Peer is already disconnected. */
      }
    }
    closed = true;
    port.removeEventListener('message', onMessage);
    port.removeEventListener('messageerror', onMessageError);
    for (const entry of running.values()) {
      entry.cancelled = true;
      entry.controller.abort();
    }
    port.close();
    // Native close/revocation must serialize behind already accepted writes. Cancellation is not rollback.
    closing = Promise.resolve().then(() => session.close());
    // Avoid an unhandled rejection if disposal was initiated by a peer; callers can still await closing.
    void closing.catch(() => {});
    return closing;
  };
  const onMessageError = () => {
    void dispose('PROTOCOL').catch(() => {});
  };
  const onMessage = (event: MessageEvent<unknown>) => {
    for (const transferred of event.ports ?? []) transferred.close();
    if (event.ports?.length) {
      void dispose('PROTOCOL').catch(() => {});
      return;
    }
    const request = parseRequest(event.data);
    if (!request) {
      void dispose('PROTOCOL').catch(() => {});
      return;
    }
    if (request.type === 'close') {
      void dispose().catch(() => {});
      return;
    }
    if (request.type === 'cancel') {
      const entry = running.get(request.id);
      if (entry) {
        entry.cancelled = true;
        entry.controller.abort();
      }
      return;
    }
    if (request.id <= lastId) {
      void dispose('PROTOCOL').catch(() => {});
      return;
    }
    lastId = request.id;
    const cost =
      request.op === 'pushUpdate' ? request.data.buffer.byteLength : 0;
    if (
      running.size >= MAX_IN_FLIGHT ||
      queuedBytes + cost > MAX_QUEUED_BYTES
    ) {
      send({
        version: PROTOCOL_VERSION,
        type: 'result',
        id: request.id,
        ok: false,
        error: 'RESOURCE_LIMIT',
      });
      return;
    }
    const entry = { controller: new AbortController(), cancelled: false };
    running.set(request.id, entry);
    queuedBytes += cost;
    void (async () => {
      try {
        const value =
          request.op === 'getDoc'
            ? await session.getDoc(request.docId, entry.controller.signal)
            : await session.pushUpdate(
                request.docId,
                request.data,
                entry.controller.signal
              );
        if (entry.cancelled || closed) return;
        if (request.op === 'getDoc') {
          if (value === null) {
            send({
              version: PROTOCOL_VERSION,
              type: 'result',
              id: request.id,
              ok: true,
              value: null,
            });
          } else {
            if (
              !clock(value, request.docId) ||
              !record(value) ||
              !exactKeys(value, ['docId', 'timestampMs', 'data']) ||
              !bytes(value.data)
            )
              throw new StorageBridgeError('PROTOCOL');
            // Do not detach native cache/shared application buffers when replying to an unprivileged Worker.
            const data = new Uint8Array(value.data);
            send(
              {
                version: PROTOCOL_VERSION,
                type: 'result',
                id: request.id,
                ok: true,
                value: {
                  docId: request.docId,
                  timestampMs: value.timestampMs,
                  data,
                },
              },
              [data.buffer]
            );
          }
        } else {
          if (
            !clock(value, request.docId) ||
            !record(value) ||
            !exactKeys(value, ['docId', 'timestampMs'])
          )
            throw new StorageBridgeError('PROTOCOL');
          send({
            version: PROTOCOL_VERSION,
            type: 'result',
            id: request.id,
            ok: true,
            value: { docId: request.docId, timestampMs: value.timestampMs },
          });
        }
      } catch (error) {
        if (!entry.cancelled)
          send({
            version: PROTOCOL_VERSION,
            type: 'result',
            id: request.id,
            ok: false,
            error: sanitizeError(error),
          });
      } finally {
        running.delete(request.id);
        queuedBytes -= cost;
      }
    })().catch(() => dispose('PROTOCOL').catch(() => {}));
  };
  port.addEventListener('message', onMessage);
  port.addEventListener('messageerror', onMessageError);
  port.start();
  return { dispose };
}
