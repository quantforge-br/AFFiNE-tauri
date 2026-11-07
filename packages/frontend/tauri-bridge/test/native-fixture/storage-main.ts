import { bindStoragePort, type TrustedStorageSession } from '../../src/main';
import {
  type DocClock,
  type DocRecord,
  StorageBridgeError,
} from '../../src/protocol';

// Disposable native-WebView fixture. Production authority and lifecycle wiring are not implemented here.
const CODES = [
  'INVALID_INPUT',
  'UNAUTHORIZED',
  'INVALID_HANDLE',
  'RESOURCE_LIMIT',
  'STORAGE',
  'RESYNC_REQUIRED',
  'CANCELLED',
  'CLOSED',
  'PROTOCOL',
] as const;
type NativeCode = (typeof CODES)[number];
interface Results {
  done: boolean;
  checks: unknown[];
  origin: string;
  timeOrigin: number;
  violations: unknown[];
  warnings: string[];
  stage: string;
  failure?: string;
}
interface Previous {
  ticket: string;
  generation: number;
  timeOrigin: number;
  lifetimeMs: number;
  checks: unknown[];
}
declare global {
  interface Window {
    __TAURI_INTERNALS__: {
      invoke<T>(
        command: string,
        payload?: unknown,
        options?: { headers?: Record<string, string> }
      ): Promise<T>;
    };
    __acceptAuthorityTicket?: (ticket: string, generation: number) => void;
    __storageResults: Results;
  }
}
// Deliberate disposable stale-ticket fixture, never an application credential persistence design.
const RELOAD_KEY = 'storage-reload-fixture';
const previous = JSON.parse(
  sessionStorage.getItem(RELOAD_KEY) ?? 'null'
) as Previous | null;
sessionStorage.removeItem(RELOAD_KEY);
const result: Results = (window.__storageResults = {
  done: false,
  checks: previous?.checks ?? [],
  origin: location.origin,
  timeOrigin: performance.timeOrigin,
  violations: [],
  warnings: [],
  stage: 'waiting-for-native-ticket',
});
// Tauri logs a warning and silently switches to postMessage when its custom-protocol IPC fails.
const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  result.warnings.push(args.map(String).join(' ').slice(0, 240));
  originalWarn(...args);
};
window.addEventListener('securitypolicyviolation', event =>
  result.violations.push({
    directive: event.effectiveDirective,
    blockedURI: event.blockedURI,
  })
);
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const record = (name: string, detail: object = {}) =>
  result.checks.push({ name, passed: true, ...detail });
const encoder = new TextEncoder();
const MAX_UPDATE = 16 * 1024 * 1024;
const FRAME_HEADER = 9;
// Write frame: u32 little-endian identifier length, UTF-8 identifier, update bytes.
function encodeWrite(docId: string, data: Uint8Array) {
  const id = encoder.encode(docId);
  const frame = new Uint8Array(4 + id.length + data.length);
  new DataView(frame.buffer).setUint32(0, id.length, true);
  frame.set(id, 4);
  frame.set(data, 4 + id.length);
  return frame;
}
// Read frame: status byte, i64 little-endian clock, document bytes.
function decodeRecord(docId: string, response: unknown): DocRecord | null {
  assert(response instanceof ArrayBuffer, 'Native read did not return binary');
  assert(response.byteLength >= FRAME_HEADER, 'Truncated native record');
  const view = new DataView(response);
  const status = view.getUint8(0);
  if (status === 0) return null;
  assert(status === 1, 'Unknown native record status');
  return {
    docId,
    timestampMs: Number(view.getBigInt64(1, true)),
    data: new Uint8Array(response.slice(FRAME_HEADER)),
  };
}
function bridgeError(error: unknown) {
  const known = CODES.find((code: NativeCode) => code === error);
  return new StorageBridgeError(known ?? 'STORAGE');
}

async function run(ticket: string, generation: number): Promise<boolean> {
  const invoke = <T>(command: string, fields: object = {}) =>
    window.__TAURI_INTERNALS__.invoke<T>(command, {
      request: { ticket, ...fields },
    });
  // Raw binary body; the only application header is the per-document ticket.
  const invokeRaw = <T>(
    command: string,
    body: Uint8Array | object,
    headers: Record<string, string> = {}
  ) =>
    window.__TAURI_INTERNALS__.invoke<T>(command, body, {
      headers: { 'x-affine-ticket': ticket, ...headers },
    });
  const readRaw = async (docId: string, headers: Record<string, string> = {}) =>
    decodeRecord(
      docId,
      await invokeRaw<unknown>('storage_read', encoder.encode(docId), headers)
    );
  const denied = async (
    operation: () => Promise<unknown>,
    expected: RegExp
  ) => {
    try {
      await operation();
    } catch (error) {
      assert(
        expected.test(String(error)),
        'Unexpected native denial: ' + String(error)
      );
      return String(error);
    }
    throw new Error('Unauthorized fixture request succeeded');
  };
  let release: (() => void) | undefined;
  let observed: (() => void) | undefined;
  const accepted = new Promise<void>(resolve => {
    observed = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const makeSession = (gated = false): TrustedStorageSession => {
    const pending = new Set<Promise<unknown>>();
    let closing: Promise<void> | undefined;
    const track = <T>(operation: () => Promise<T>): Promise<T> => {
      if (closing) return Promise.reject(new StorageBridgeError('CLOSED'));
      const work = operation().catch((error: unknown) => {
        throw bridgeError(error);
      });
      pending.add(work);
      work.then(
        () => pending.delete(work),
        () => pending.delete(work)
      );
      return work;
    };
    return {
      getDoc(docId, signal) {
        if (signal.aborted)
          return Promise.reject(new StorageBridgeError('CANCELLED'));
        return track(() => readRaw(docId));
      },
      pushUpdate(docId, data, signal) {
        if (signal.aborted)
          return Promise.reject(new StorageBridgeError('CANCELLED'));
        return track(async () => {
          const value = await invokeRaw<DocClock>(
            'storage_write',
            encodeWrite(docId, data)
          );
          if (gated) {
            observed?.();
            await gate;
          }
          return value;
        });
      },
      close() {
        // Keep native invoke accounting until actual completion, not the cancelled external waiter.
        closing ??= Promise.allSettled(pending).then(() =>
          invoke<void>('storage_close')
        );
        return closing;
      },
    };
  };
  function start(
    phase: string,
    gated = false,
    timeoutMs = 20000,
    extra: object = {}
  ) {
    const worker = new Worker('/storage-worker.js');
    const channel = new MessageChannel();
    const host = bindStoragePort(channel.port1, makeSession(gated));
    const outcome = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Worker fixture timed out: ' + phase)),
        timeoutMs
      );
      worker.onmessage = event => {
        clearTimeout(timer);
        const data = event.data as Record<string, unknown>;
        if (data.passed === true) resolve(data);
        else reject(new Error(JSON.stringify(data)));
      };
      worker.onerror = event => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
    });
    worker.postMessage({ port: channel.port2, phase, ...extra }, [
      channel.port2,
    ]);
    return { worker, host, outcome };
  }
  // Each Worker phase ends by terminating the Worker and awaiting trusted native disposal.
  const phase = async (
    name: string,
    check: string,
    gated = false,
    timeoutMs = 20000
  ) => {
    const active = start(name, gated, timeoutMs);
    try {
      record(check, await active.outcome);
    } finally {
      active.worker.terminate();
      await active.host.dispose();
    }
  };

  result.stage = 'ping-pending';
  const ping = await invoke<{ generation: number }>('authority_ping', {
    challenge: previous ? 'after-reload' : 'storage-main',
  });
  assert(ping.generation === generation, 'Ticket generation changed');

  if (previous) {
    assert(
      performance.timeOrigin !== previous.timeOrigin,
      'Reload did not replace the document'
    );
    assert(
      generation > previous.generation,
      'Native generation did not advance'
    );
    const stale = await denied(
      () => readRaw('roundtrip', { 'x-affine-ticket': previous.ticket }),
      /^UNAUTHORIZED$/
    );
    // A valid new ticket still cannot use the session that belongs to the previous document.
    const unclaimed = await denied(
      () => readRaw('roundtrip'),
      /^UNAUTHORIZED$/
    );
    record('real-reload-revokes-previous-document-storage', {
      generation,
      previousGeneration: previous.generation,
      timeOriginChanged: true,
      previousLifetimeMs: previous.lifetimeMs,
      timeOriginDeltaMs: performance.timeOrigin - previous.timeOrigin,
      navigationType: (
        performance.getEntriesByType('navigation')[0] as
          | PerformanceNavigationTiming
          | undefined
      )?.type,
      stale,
      unclaimed,
    });
    const replacement = await invoke<{ drainedPrevious: boolean }>(
      'storage_reopen'
    );
    assert(
      replacement.drainedPrevious === true,
      'Replacement did not drain the previous open session'
    );
    record('previous-document-session-drained-by-replacement', replacement);
    await phase('reopen', 'persisted-data-after-real-reload');
    await invoke('storage_reopen');
    await phase('reconcile', 'persisted-cancelled-write-after-real-reload');
    await invoke('storage_reopen');
    await phase(
      'large-persisted',
      'large-document-persisted-after-real-reload',
      false,
      60000
    );
    assert(result.violations.length === 0, 'Unexpected enforced CSP violation');
    assert(
      !result.warnings.some(warning =>
        warning.includes('IPC custom protocol failed')
      ),
      'Native IPC fell back from the custom protocol'
    );
    result.stage = 'complete';
    return false;
  }

  record('native-document-ticket', { generation });
  record('forged-native-ticket-denied', {
    denial: await denied(
      () =>
        readRaw('roundtrip', {
          'x-affine-ticket': '00000000-0000-4000-8000-000000000000',
        }),
      /^UNAUTHORIZED$/
    ),
  });
  const fields = ['owner', 'path', 'handle', 'window', 'space'];
  for (const key of fields) {
    // Raw commands refuse any other application header; JSON commands refuse unknown fields.
    await denied(
      () => readRaw('roundtrip', { ['x-affine-' + key]: 'forged' }),
      /^INVALID_INPUT$/
    );
    await denied(
      () =>
        invokeRaw(
          'storage_write',
          encodeWrite('roundtrip', new Uint8Array([0])),
          { ['x-affine-' + key]: 'forged' }
        ),
      /^INVALID_INPUT$/
    );
    await denied(
      () => invoke('storage_close', { [key]: 'forged' }),
      /unknown field/
    );
  }
  // A structured JSON body is never accepted as storage input.
  await denied(
    () => invokeRaw('storage_read', { docId: 'roundtrip' }),
    /^INVALID_INPUT$/
  );
  record('native-authority-fields-denied', { fields });
  await denied(() => invoke('authority_forbidden', {}), /not allowed/);
  record('ungranted-native-command-denied');

  // A Worker builds raw IPC requests by hand, holding even a leaked ticket. The native ping counter
  // proves whether any such request reached a command, and storage must be unchanged.
  const before = await invoke<{ sequence: number }>('authority_ping', {
    challenge: 'before-worker-raw-ipc',
  });
  const hostile = start('raw-ipc', false, 30000, {
    ticket,
    ipc:
      location.protocol === 'http:'
        ? 'http://ipc.localhost/'
        : 'ipc://localhost/',
  });
  try {
    const attack = await hostile.outcome;
    const after = await invoke<{ sequence: number }>('authority_ping', {
      challenge: 'after-worker-raw-ipc',
    });
    assert(
      after.sequence === before.sequence + 1,
      'A Worker-built request reached a native command'
    );
    assert(
      (await readRaw(String(attack.attackId))) === null,
      'A Worker-built write changed storage'
    );
    record('worker-constructed-raw-ipc-denied', {
      ...attack,
      sequenceBefore: before.sequence,
      sequenceAfter: after.sequence,
    });
  } finally {
    hostile.worker.terminate();
    await hostile.host.dispose();
  }
  await invoke('storage_reopen');
  // Bypass the bridge on purpose: the native boundary must enforce its own bound.
  const oversized = await denied(
    () =>
      invokeRaw(
        'storage_write',
        encodeWrite('oversized', new Uint8Array(MAX_UPDATE + 1))
      ),
    /^INVALID_INPUT$/
  );
  assert(
    (await readRaw('roundtrip')) === null &&
      (await readRaw('oversized')) === null,
    'Rejected oversized update changed storage'
  );
  record('oversized-raw-update-rejected-without-state-change', {
    bytes: MAX_UPDATE + 1,
    denial: oversized,
  });

  await phase('initial', 'worker-private-port-rust-sqlite-roundtrip');
  await denied(() => readRaw('roundtrip'), /^CLOSED$/);
  record('awaited-dispose-closes-native-session');
  await invoke('storage_reopen');
  await phase('reopen', 'sqlite-session-reopen');
  await invoke('storage_reopen');
  await phase('large', 'large-document-raw-ipc-roundtrip', false, 60000);
  await invoke('storage_reopen');
  const active = start('cancel', true);
  try {
    await accepted;
    active.worker.postMessage({ abort: true });
    record(
      'cancelled-external-waiter-after-real-native-write',
      await active.outcome
    );
    active.worker.terminate();
    const disposal = active.host.dispose();
    release?.();
    await disposal;
    record('worker-termination-explicit-disposal');
  } finally {
    release?.();
    active.worker.terminate();
    await active.host.dispose();
  }
  await invoke('storage_reopen');
  await phase('reconcile', 'uncertain-write-reconciled-after-reopen');
  assert(result.violations.length === 0, 'Unexpected enforced CSP violation');

  // Leave a native session open without any Worker, then replace the whole document.
  await invoke('storage_reopen');
  record('session-left-open-for-document-replacement');
  sessionStorage.setItem(
    RELOAD_KEY,
    JSON.stringify({
      ticket,
      generation,
      timeOrigin: performance.timeOrigin,
      lifetimeMs: performance.now(),
      checks: result.checks,
    } satisfies Previous)
  );
  result.stage = 'reloading';
  setTimeout(() => location.reload(), 0);
  return true;
}
window.__acceptAuthorityTicket = (ticket, generation) => {
  result.stage = 'ticket-received';
  delete window.__acceptAuthorityTicket;
  let reloading = false;
  run(ticket, generation)
    .then(value => {
      reloading = value;
    })
    .catch((error: unknown) => {
      result.failure = String(error);
    })
    .finally(() => {
      if (reloading && result.failure === undefined) return;
      result.done = true;
      const output = document.getElementById('results');
      if (output) output.textContent = JSON.stringify(result, null, 2);
    });
};
