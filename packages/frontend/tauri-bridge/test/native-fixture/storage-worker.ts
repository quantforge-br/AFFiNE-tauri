import * as Y from 'yjs';

import { WorkerStorageClient } from '../../src/worker';

// Disposable native-WebView fixture. It uses the production Worker client against a directly transferred port.
interface FixtureScope {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
    options?: { once: boolean }
  ): void;
}
const scope = self as unknown as FixtureScope;
const text = 'Native session café 東京 🦀';
const expected = Uint8Array.from({ length: 256 }, (_, index) => index);
const LARGE_ID = 'large café 東京';
const LARGE_BYTES = 8 * 1024 * 1024;
const ATTEMPT_TIMEOUT_MS = 4000;
const ATTACK_ID = 'worker-raw-attack';
interface RawIpcOptions {
  ticket: string;
  ipc: string;
}
interface Attempt {
  label: string;
  outcome: string;
  tauriResponse?: string | null;
  body?: string;
}

function writeFrame(docId: string, data: Uint8Array) {
  const id = new TextEncoder().encode(docId);
  const frame = new Uint8Array(4 + id.length + data.length);
  new DataView(frame.buffer).setUint32(0, id.length, true);
  frame.set(id, 4);
  frame.set(data, 4 + id.length);
  return frame;
}
// A request built by hand, as a hostile Worker would, without any helper Tauri injects into a page.
async function attempt(
  label: string,
  url: string,
  init: {
    headers: Record<string, string>;
    body: Uint8Array<ArrayBuffer> | string;
  }
): Promise<Attempt> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    return {
      label,
      outcome: 'status:' + response.status,
      tauriResponse: response.headers.get('Tauri-Response'),
      body: (await response.text()).slice(0, 100),
    };
  } catch (error) {
    const name = (error as { name?: string }).name ?? 'Error';
    return {
      label,
      // The timeout signal is the only abort source, so an AbortError means no reply arrived in time.
      outcome:
        name === 'TimeoutError' || name === 'AbortError'
          ? 'no-response'
          : 'rejected:' + name,
    };
  }
}
async function rawIpcAttack({ ticket, ipc }: RawIpcOptions) {
  const doc = new Y.Doc();
  doc.getText('text').insert(0, 'written by a hostile Worker');
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  const frame = writeFrame(ATTACK_ID, update);
  const octet = { 'content-type': 'application/octet-stream' };
  const full = {
    ...octet,
    'tauri-callback': '1',
    'tauri-error': '2',
    'x-affine-ticket': ticket,
  };
  const guesses = [
    '',
    'undefined',
    'null',
    '0',
    'tauri',
    '__TAURI_INVOKE_KEY__',
  ];
  const json = JSON.stringify({
    request: { ticket, challenge: 'worker-raw-ipc' },
  });
  // The ticket is deliberately handed to this Worker to model a leak, so the remaining barrier is
  // the per-process invoke key that only the page-side Tauri script holds.
  const results = await Promise.all([
    attempt('no-credentials', ipc + 'storage_write', {
      headers: octet,
      body: frame,
    }),
    attempt('leaked-ticket-without-invoke-key', ipc + 'storage_write', {
      headers: full,
      body: frame,
    }),
    ...guesses.map(guess =>
      attempt(
        'leaked-ticket-guessed-key:' + (guess || 'empty'),
        ipc + 'storage_write',
        {
          headers: { ...full, 'tauri-invoke-key': guess },
          body: frame,
        }
      )
    ),
    attempt('leaked-ticket-ping', ipc + 'authority_ping', {
      headers: {
        'content-type': 'application/json',
        'tauri-callback': '1',
        'tauri-error': '2',
        'tauri-invoke-key': 'guess',
      },
      body: json,
    }),
    attempt('ungranted-command', ipc + 'authority_forbidden', {
      headers: {
        'content-type': 'application/json',
        'tauri-callback': '1',
        'tauri-error': '2',
        'tauri-invoke-key': 'guess',
      },
      body: '{}',
    }),
  ]);
  const succeeded = results.filter(
    item => item.outcome === 'status:200' || item.tauriResponse === 'ok'
  );
  assert(succeeded.length === 0, 'A hand-built Worker request succeeded');
  const names = Object.getOwnPropertyNames(self).filter(name =>
    /tauri|ipc/i.test(name)
  );
  assert(names.length === 0, 'Worker exposes Tauri globals: ' + names.join());
  return { results, tauriGlobals: names, attackId: ATTACK_ID };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function code(error: unknown) {
  return (error as { code?: string }).code ?? String(error);
}
function inspect(data: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, data);
  assert(doc.getText('text').toString() === text, 'Unicode CRDT text changed');
  const bytes = doc.getMap('fixture').get('bytes');
  assert(
    bytes instanceof Uint8Array &&
      bytes.length === 256 &&
      bytes.every((byte, index) => byte === expected[index]),
    'Binary CRDT payload changed'
  );
  doc.destroy();
}

function largePayload() {
  const payload = new Uint8Array(LARGE_BYTES);
  for (let index = 0; index < payload.length; index += 1)
    payload[index] = (index * 31 + (index >>> 8)) & 255;
  return payload;
}
function inspectLarge(data: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, data);
  const stored = doc.getMap('fixture').get('large');
  assert(
    stored instanceof Uint8Array && stored.length === LARGE_BYTES,
    'Large binary CRDT payload changed size'
  );
  const payload = largePayload();
  for (let index = 0; index < payload.length; index += 1)
    if (stored[index] !== payload[index])
      throw new Error('Large payload differs at byte ' + index);
  doc.destroy();
}

async function run(port: MessagePort, phase: string, extra: unknown) {
  const client = new WorkerStorageClient(port);
  const nativeGlobals = '__TAURI_INTERNALS__' in self || '__TAURI__' in self;
  assert(!nativeGlobals, 'Worker received native bootstrap');
  if (phase === 'initial') {
    assert((await client.getDoc('roundtrip')) === null, 'Fixture is not empty');
    const doc = new Y.Doc();
    doc.getText('text').insert(0, text);
    doc.getMap('fixture').set('bytes', expected);
    const update = Y.encodeStateAsUpdate(doc);
    const retained = new Uint8Array(update);
    const clock = await client.pushUpdate('roundtrip', update);
    assert(
      clock.docId === 'roundtrip' && Number.isSafeInteger(clock.timestampMs),
      'Invalid native write clock'
    );
    assert(
      update.length === retained.length &&
        update.every((byte, index) => byte === retained[index]),
      'Client detached or changed caller input'
    );
    const stored = await client.getDoc('roundtrip');
    assert(stored, 'Native write not readable');
    inspect(stored.data);
    let denial = '';
    try {
      await client.pushUpdate('roundtrip', new Uint8Array([255]));
    } catch (error) {
      denial = code(error);
    }
    assert(
      denial === 'INVALID_INPUT',
      'Malformed CRDT update was not rejected'
    );
    const unchanged = await client.getDoc('roundtrip');
    assert(unchanged, 'Malformed input removed document');
    inspect(unchanged.data);
    doc.destroy();
    scope.postMessage({
      phase,
      passed: true,
      nativeGlobals,
      bytes: 256,
      text,
      denial,
    });
  } else if (phase === 'reopen') {
    const stored = await client.getDoc('roundtrip');
    assert(stored, 'Awaited close/reopen lost the real SQLite document');
    inspect(stored.data);
    scope.postMessage({ phase, passed: true, nativeGlobals });
  } else if (phase === 'cancel') {
    const doc = new Y.Doc();
    doc.getText('text').insert(0, 'accepted despite external cancellation');
    const controller = new AbortController();
    // The trusted host aborts only after the real native operation completed, while its reply is gated.
    scope.addEventListener(
      'message',
      event => {
        if ((event.data as { abort?: boolean }).abort === true)
          controller.abort();
      },
      { once: true }
    );
    let denial = '';
    try {
      await client.pushUpdate(
        'uncertain',
        Y.encodeStateAsUpdate(doc),
        controller.signal
      );
    } catch (error) {
      denial = code(error);
    }
    assert(
      denial === 'CANCELLED',
      'External waiter did not observe cancellation'
    );
    doc.destroy();
    scope.postMessage({ phase, passed: true, denial });
  } else if (phase === 'large') {
    const doc = new Y.Doc();
    doc.getMap('fixture').set('large', largePayload());
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const started = performance.now();
    const clock = await client.pushUpdate(LARGE_ID, update);
    const written = performance.now();
    const stored = await client.getDoc(LARGE_ID);
    const read = performance.now();
    assert(
      clock.docId === LARGE_ID && stored?.docId === LARGE_ID,
      'Unicode document identifier changed'
    );
    inspectLarge(stored.data);
    scope.postMessage({
      phase,
      passed: true,
      updateBytes: update.length,
      storedBytes: stored.data.length,
      writeMs: Math.round(written - started),
      readMs: Math.round(read - written),
    });
  } else if (phase === 'large-persisted') {
    const stored = await client.getDoc(LARGE_ID);
    assert(stored, 'Large document was not persisted');
    inspectLarge(stored.data);
    scope.postMessage({ phase, passed: true, storedBytes: stored.data.length });
  } else if (phase === 'raw-ipc') {
    scope.postMessage({
      phase,
      passed: true,
      ...(await rawIpcAttack(extra as RawIpcOptions)),
    });
  } else if (phase === 'reconcile') {
    const stored = await client.getDoc('uncertain');
    assert(stored, 'Accepted cancelled write was not persisted');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, stored.data);
    assert(
      doc.getText('text').toString() ===
        'accepted despite external cancellation',
      'Reconciliation failed'
    );
    doc.destroy();
    scope.postMessage({ phase, passed: true });
  } else {
    throw new Error('Unknown fixture phase');
  }
}
scope.addEventListener(
  'message',
  event => {
    const data = event.data as { port?: unknown; phase?: string };
    const extra = event.data;
    if (data.port instanceof MessagePort && typeof data.phase === 'string') {
      const phase = data.phase;
      run(data.port, phase, extra).catch((error: unknown) =>
        scope.postMessage({ phase, passed: false, failure: String(error) })
      );
    }
  },
  { once: true }
);
