import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, Worker } from 'node:worker_threads';

import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';

import { bindStoragePort, type TrustedStorageSession } from '../src/main';

it('runs the production client on a real Node Worker and disposes host authority after termination', async () => {
  const output = await build({
    entryPoints: [
      fileURLToPath(new URL('./fixtures/storage-worker.ts', import.meta.url)),
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
  });
  const directory = await mkdtemp(
    join(tmpdir(), 'affine-tauri-bridge-worker-')
  );
  const path = join(directory, 'worker.mjs');
  await writeFile(path, output.outputFiles[0].contents);
  const worker = new Worker(path);
  const channel = new MessageChannel();
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  let release!: (value: null) => void;
  let heldSignal: AbortSignal | undefined;
  const held = new Promise<null>(resolve => {
    release = resolve;
  });
  // Deliberate session test double: no Rust/Tauri persistence is claimed here.
  const session: TrustedStorageSession = {
    pushUpdate: vi.fn(async docId => ({ docId, timestampMs: 42 })),
    getDoc: vi.fn(async (docId, signal) => {
      if (docId === 'held') {
        heldSignal = signal;
        return held;
      }
      return { docId, timestampMs: 42, data: bytes };
    }),
    close: vi.fn(async () => {}),
  };
  const host = bindStoragePort(
    channel.port1 as unknown as MessagePort,
    session
  );
  try {
    const reply = once(worker, 'message');
    worker.postMessage({ port: channel.port2 }, [channel.port2]);
    expect((await reply)[0]).toEqual({
      type: 'roundtrip',
      clock: { docId: 'worker-doc', timestampMs: 42 },
      record: { docId: 'worker-doc', timestampMs: 42, data: bytes },
      retainedInput: Array.from(bytes),
      nativeGlobals: [],
    });
    expect(session.pushUpdate).toHaveBeenCalledWith(
      'worker-doc',
      bytes,
      expect.any(AbortSignal)
    );
    await vi.waitFor(() => expect(heldSignal).toBeDefined());
    await worker.terminate();
    // Browsers do not provide a reliable peer-port close event. Trusted lifecycle must dispose explicitly.
    expect(session.close).not.toHaveBeenCalled();
    await host.dispose();
    expect(heldSignal!.aborted).toBe(true);
    expect(session.close).toHaveBeenCalledTimes(1);
    release(null);
  } finally {
    release(null);
    await worker.terminate();
    await host.dispose();
    channel.port1.close();
    channel.port2.close();
    await rm(directory, { recursive: true, force: true });
  }
});
