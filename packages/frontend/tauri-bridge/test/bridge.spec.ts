import { MessageChannel } from 'node:worker_threads';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindStoragePort, type TrustedStorageSession } from '../src/main';
import { MAX_UPDATE_BYTES, StorageBridgeError } from '../src/protocol';
import { WorkerStorageClient } from '../src/worker';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function channel() {
  const channel = new MessageChannel();
  cleanups.push(() => {
    channel.port1.close();
    channel.port2.close();
  });
  return {
    main: channel.port1 as unknown as MessagePort,
    worker: channel.port2 as unknown as MessagePort,
  };
}
function session(
  overrides: Partial<TrustedStorageSession> = {}
): TrustedStorageSession {
  return {
    getDoc: vi.fn(async () => null),
    pushUpdate: vi.fn(async docId => ({ docId, timestampMs: 42 })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}
function pair(native = session(), timeoutMs = 1000) {
  const ports = channel();
  const host = bindStoragePort(ports.main, native);
  const client = new WorkerStorageClient(ports.worker, timeoutMs);
  cleanups.push(async () => {
    client.dispose();
    await host.dispose();
  });
  return { ...ports, host, client, native };
}
function next(port: MessagePort): Promise<unknown> {
  return new Promise(resolve => {
    port.addEventListener('message', event => resolve(event.data), {
      once: true,
    });
    port.start();
  });
}
const call = (id: number, extras: Record<string, unknown> = {}) => ({
  version: 1,
  type: 'call',
  id,
  op: 'getDoc',
  docId: 'doc',
  ...extras,
});

// Session methods are deliberate test doubles. These tests prove transport behavior, not native persistence.
describe('private storage port', () => {
  it('round-trips all byte values without detaching caller or native cached buffers', async () => {
    const original = Uint8Array.from({ length: 256 }, (_, index) => index);
    const cached = original.slice();
    const native = session({
      getDoc: vi.fn(async docId => ({ docId, timestampMs: 42, data: cached })),
    });
    const { client } = pair(native);
    expect(await client.pushUpdate('doc', original)).toEqual({
      docId: 'doc',
      timestampMs: 42,
    });
    expect(native.pushUpdate).toHaveBeenCalledWith(
      'doc',
      original,
      expect.any(AbortSignal)
    );
    const result = await client.getDoc('doc');
    expect(result?.data).toEqual(original);
    expect(original.byteLength).toBe(256);
    expect(cached.byteLength).toBe(256);
    expect(await pair().client.getDoc('missing')).toBeNull();
  });

  it.each([
    { owner: 'forged' },
    { handle: 'forged' },
    { path: '/tmp/escape.db' },
    { windowLabel: 'main' },
    { op: 'connect' },
    { op: 'constructor' },
    { version: 2 },
    { id: -1 },
    { docId: 'line\nbreak' },
    { docId: 'é'.repeat(1025) },
    { op: 'pushUpdate', data: new Uint8Array() },
    { op: 'pushUpdate', data: new Uint8Array(new SharedArrayBuffer(1)) },
  ])('rejects forged authority or malformed operation %#', async extras => {
    const ports = channel();
    const native = session();
    const host = bindStoragePort(ports.main, native);
    cleanups.push(() => host.dispose());
    const response = next(ports.worker);
    ports.worker.postMessage(call(1, extras));
    expect(await response).toEqual({
      version: 1,
      type: 'closed',
      error: 'PROTOCOL',
    });
    expect(native.getDoc).not.toHaveBeenCalled();
    expect(native.pushUpdate).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(native.close).toHaveBeenCalledTimes(1));
  });

  it('rejects duplicate or reused IDs without starting a second host operation', async () => {
    const ports = channel();
    const native = session();
    const host = bindStoragePort(ports.main, native);
    cleanups.push(() => host.dispose());
    let response = next(ports.worker);
    ports.worker.postMessage(call(1));
    expect(await response).toMatchObject({ ok: true });
    response = next(ports.worker);
    ports.worker.postMessage(call(1));
    expect(await response).toMatchObject({ type: 'closed', error: 'PROTOCOL' });
    expect(native.getDoc).toHaveBeenCalledTimes(1);
  });

  it('sanitizes raw host errors and preserves only explicit safe error codes', async () => {
    const native = session({
      getDoc: vi
        .fn()
        .mockRejectedValueOnce(
          new Error('token=SECRET SQL /private/profile.db')
        )
        .mockRejectedValueOnce(new StorageBridgeError('UNAUTHORIZED')),
    });
    const { client } = pair(native);
    await expect(client.getDoc('doc')).rejects.toMatchObject({
      code: 'STORAGE',
      message: 'STORAGE',
    });
    await expect(client.getDoc('doc')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('does not expose a different document from a malformed native response', async () => {
    const { client } = pair(
      session({
        getDoc: async () => ({
          docId: 'other',
          timestampMs: 42,
          data: new Uint8Array([99]),
        }),
      })
    );
    await expect(client.getDoc('doc')).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });

  it('cancels delivery but keeps accepted native work accounted until it settles', async () => {
    const held = deferred<{ docId: string; timestampMs: number }>();
    let observed: AbortSignal | undefined;
    const native = session({
      pushUpdate: vi.fn((_id, _data, signal) => {
        observed = signal;
        return held.promise;
      }),
    });
    const { client, host } = pair(native);
    const abort = new AbortController();
    const result = client.pushUpdate(
      'doc',
      new Uint8Array([0, 0]),
      abort.signal
    );
    const rejected = expect(result).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await vi.waitFor(() => expect(native.pushUpdate).toHaveBeenCalledTimes(1));
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(observed?.aborted).toBe(true));
    held.resolve({ docId: 'doc', timestampMs: 42 });
    expect(await client.getDoc('doc')).toBeNull();
    await host.dispose();
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it('bounds host operations even when the peer bypasses the client and cancels every request', async () => {
    const held = deferred<null>();
    const ports = channel();
    const native = session({ getDoc: vi.fn(() => held.promise) });
    const host = bindStoragePort(ports.main, native);
    cleanups.push(() => host.dispose());
    for (let id = 1; id <= 64; id++) {
      ports.worker.postMessage(call(id));
      ports.worker.postMessage({ version: 1, type: 'cancel', id });
    }
    await vi.waitFor(() => expect(native.getDoc).toHaveBeenCalledTimes(64));
    const response = next(ports.worker);
    ports.worker.postMessage(call(65));
    expect(await response).toMatchObject({
      id: 65,
      ok: false,
      error: 'RESOURCE_LIMIT',
    });
    held.resolve(null);
  });

  it('counts the entire backing buffer against the host byte budget', async () => {
    const held = deferred<{ docId: string; timestampMs: number }>();
    const ports = channel();
    const native = session({ pushUpdate: vi.fn(() => held.promise) });
    const host = bindStoragePort(ports.main, native);
    cleanups.push(() => host.dispose());
    for (let id = 1; id <= 4; id++) {
      const backing = new ArrayBuffer(MAX_UPDATE_BYTES);
      const data = new Uint8Array(backing, 0, 1);
      ports.worker.postMessage(call(id, { op: 'pushUpdate', data }), [backing]);
    }
    await vi.waitFor(() => expect(native.pushUpdate).toHaveBeenCalledTimes(4));
    const response = next(ports.worker);
    ports.worker.postMessage(
      call(5, { op: 'pushUpdate', data: new Uint8Array([1]) })
    );
    expect(await response).toMatchObject({ id: 5, error: 'RESOURCE_LIMIT' });
    held.resolve({ docId: 'doc', timestampMs: 42 });
  });

  it('times out locally, rejects after disposal, and never sends a pre-aborted request', async () => {
    const held = deferred<null>();
    const native = session({ getDoc: vi.fn(() => held.promise) });
    const { client } = pair(native, 15);
    const abort = new AbortController();
    abort.abort();
    await expect(client.getDoc('doc', abort.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(native.getDoc).not.toHaveBeenCalled();
    await expect(client.getDoc('doc')).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    client.dispose();
    await expect(client.getDoc('doc')).rejects.toMatchObject({
      code: 'CLOSED',
    });
    held.resolve(null);
  });

  it('rejects malformed replies and settles every pending client call', async () => {
    const ports = channel();
    const client = new WorkerStorageClient(ports.worker);
    cleanups.push(() => client.dispose());
    const pending = client.getDoc('doc');
    const failed = expect(pending).rejects.toMatchObject({ code: 'PROTOCOL' });
    await next(ports.main);
    ports.main.postMessage({
      version: 1,
      type: 'result',
      id: 1,
      ok: true,
      value: { docId: 'other', timestampMs: 42, data: new Uint8Array([1]) },
    });
    await failed;
    await expect(client.getDoc('doc')).rejects.toMatchObject({
      code: 'CLOSED',
    });
  });

  it('rejects unexpected transferred ports instead of accepting alternate authority', async () => {
    const ports = channel();
    const alternate = channel();
    const native = session();
    const host = bindStoragePort(ports.main, native);
    cleanups.push(() => host.dispose());
    const response = next(ports.worker);
    ports.worker.postMessage({ ...call(1), port: alternate.worker }, [
      alternate.worker,
    ]);
    expect(await response).toMatchObject({ type: 'closed', error: 'PROTOCOL' });
    expect(native.getDoc).not.toHaveBeenCalled();
  });
  it('copies Buffer-backed payloads instead of detaching or aliasing caller/cache data', async () => {
    const original = Buffer.from([0, 1, 127, 128, 255]);
    const cached = Buffer.from(original);
    const native = session({
      getDoc: vi.fn(async docId => ({ docId, timestampMs: 42, data: cached })),
    });
    const { client } = pair(native);
    await client.pushUpdate('doc', original);
    const received = vi.mocked(native.pushUpdate).mock.calls[0][1];
    received[0] = 99;
    expect(original[0]).toBe(0);
    const result = await client.getDoc('doc');
    expect(result?.data).toEqual(new Uint8Array(original));
    result!.data[0] = 55;
    expect(cached[0]).toBe(0);
    expect(original.byteLength).toBe(5);
    expect(cached.byteLength).toBe(5);
  });

  it('sanitizes an invalid error code even on a StorageBridgeError instance', async () => {
    const invalid = new StorageBridgeError('STORAGE');
    Object.defineProperty(invalid, 'code', { value: '/private/token=SECRET' });
    const { client } = pair(
      session({ getDoc: vi.fn().mockRejectedValue(invalid) })
    );
    await expect(client.getDoc('doc')).rejects.toMatchObject({
      code: 'STORAGE',
      message: 'STORAGE',
    });
  });

  it('settles all pending calls and closes the trusted session exactly once on host disposal', async () => {
    const held = deferred<null>();
    const native = session({ getDoc: vi.fn(() => held.promise) });
    const { client, host } = pair(native);
    const pending = [client.getDoc('one'), client.getDoc('two')];
    const rejected = pending.map(promise =>
      expect(promise).rejects.toMatchObject({ code: 'CLOSED' })
    );
    await vi.waitFor(() => expect(native.getDoc).toHaveBeenCalledTimes(2));
    const first = host.dispose();
    expect(host.dispose()).toBe(first);
    await Promise.all(rejected);
    expect(
      vi.mocked(native.getDoc).mock.calls.every(([, signal]) => signal.aborted)
    ).toBe(true);
    held.resolve(null);
    await first;
    expect(native.close).toHaveBeenCalledTimes(1);
    await expect(client.getDoc('after')).rejects.toMatchObject({
      code: 'CLOSED',
    });
  });

  it('reports close failure to the trusted caller without sending private details to the peer', async () => {
    const ports = channel();
    const native = session({
      close: vi
        .fn()
        .mockRejectedValue(new Error('/private/profile.db token=SECRET')),
    });
    const host = bindStoragePort(ports.main, native);
    const response = next(ports.worker);
    const first = host.dispose();
    expect(host.dispose()).toBe(first);
    await expect(first).rejects.toThrow('/private/profile.db token=SECRET');
    expect(await response).toEqual({
      version: 1,
      type: 'closed',
      error: 'CLOSED',
    });
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it('reclaims host capacity only after accepted cancelled work settles', async () => {
    const held = deferred<null>();
    const native = session({ getDoc: vi.fn(() => held.promise) });
    const { main, worker } = channel();
    const host = bindStoragePort(main, native);
    cleanups.push(() => host.dispose());
    // Use the raw Worker side to bypass client-side request bounds.
    for (let id = 1; id <= 64; id++) {
      worker.postMessage(call(id));
      worker.postMessage({ version: 1, type: 'cancel', id });
    }
    await vi.waitFor(() => expect(native.getDoc).toHaveBeenCalledTimes(64));
    let response = next(worker);
    worker.postMessage(call(65));
    expect(await response).toMatchObject({ id: 65, error: 'RESOURCE_LIMIT' });
    held.resolve(null);
    await vi.waitFor(() =>
      expect(vi.mocked(native.getDoc).mock.settledResults).toHaveLength(64)
    );
    response = next(worker);
    worker.postMessage(call(66));
    expect(await response).toMatchObject({ id: 66, ok: true, value: null });
    expect(native.getDoc).toHaveBeenCalledTimes(65);
    await host.dispose();
    main.close();
  });
});
