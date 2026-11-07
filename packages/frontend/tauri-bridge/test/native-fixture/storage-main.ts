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
      invoke<T>(command: string, payload: unknown): Promise<T>;
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
  stage: 'waiting-for-native-ticket',
});
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
function bridgeError(error: unknown) {
  const known = CODES.find((code: NativeCode) => code === error);
  return new StorageBridgeError(known ?? 'STORAGE');
}

async function run(ticket: string, generation: number): Promise<boolean> {
  const invoke = <T>(command: string, fields: object = {}) =>
    window.__TAURI_INTERNALS__.invoke<T>(command, {
      request: { ticket, ...fields },
    });
  const denied = async (command: string, fields: object, expected: RegExp) => {
    try {
      await invoke(command, fields);
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
        return track(async () => {
          // Diagnostic transport only: production must use raw IPC bytes, not JSON number arrays.
          const value = await invoke<
            (Omit<DocRecord, 'data'> & { data: number[] }) | null
          >('storage_read', { docId });
          return value === null
            ? null
            : { ...value, data: new Uint8Array(value.data) };
        });
      },
      pushUpdate(docId, data, signal) {
        if (signal.aborted)
          return Promise.reject(new StorageBridgeError('CANCELLED'));
        return track(async () => {
          const value = await invoke<DocClock>('storage_write', {
            docId,
            data: Array.from(data),
          });
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
  function start(phase: string, gated = false) {
    const worker = new Worker('/storage-worker.js');
    const channel = new MessageChannel();
    const host = bindStoragePort(channel.port1, makeSession(gated));
    const outcome = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Worker fixture timed out: ' + phase)),
        20000
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
    worker.postMessage({ port: channel.port2, phase }, [channel.port2]);
    return { worker, host, outcome };
  }
  // Each Worker phase ends by terminating the Worker and awaiting trusted native disposal.
  const phase = async (name: string, check: string, gated = false) => {
    const active = start(name, gated);
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
      'storage_read',
      { ticket: previous.ticket, docId: 'roundtrip' },
      /^UNAUTHORIZED$/
    );
    // A valid new ticket still cannot use the session that belongs to the previous document.
    const unclaimed = await denied(
      'storage_read',
      { docId: 'roundtrip' },
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
    assert(result.violations.length === 0, 'Unexpected enforced CSP violation');
    result.stage = 'complete';
    return false;
  }

  record('native-document-ticket', { generation });
  record('forged-native-ticket-denied', {
    denial: await denied(
      'storage_read',
      { ticket: '00000000-0000-4000-8000-000000000000', docId: 'roundtrip' },
      /^UNAUTHORIZED$/
    ),
  });
  for (const key of ['owner', 'path', 'handle', 'windowLabel', 'space'])
    await denied(
      'storage_read',
      { docId: 'roundtrip', [key]: 'forged' },
      /unknown field/
    );
  record('native-authority-fields-denied');
  await denied('authority_forbidden', {}, /not allowed/);
  record('ungranted-native-command-denied');

  await phase('initial', 'worker-private-port-rust-sqlite-roundtrip');
  await denied('storage_read', { docId: 'roundtrip' }, /^CLOSED$/);
  record('awaited-dispose-closes-native-session');
  await invoke('storage_reopen');
  await phase('reopen', 'sqlite-session-reopen');
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
