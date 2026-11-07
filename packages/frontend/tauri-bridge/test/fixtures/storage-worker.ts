import { parentPort } from 'node:worker_threads';

import { WorkerStorageClient } from '../../src/worker';

// Node Worker fixture only: native session methods still live in the test host.
if (!parentPort) throw new Error('This fixture requires a Node Worker');
const parent = parentPort;
parent.once('message', ({ port }: { port: MessagePort }) => {
  void roundtrip(port).catch(error => {
    parent.postMessage({ type: 'failed', error: String(error) });
  });
});

async function roundtrip(port: MessagePort) {
  const client = new WorkerStorageClient(port);
  try {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const clock = await client.pushUpdate('worker-doc', bytes);
    const record = await client.getDoc('worker-doc');
    parent.postMessage({
      type: 'roundtrip',
      clock,
      record,
      retainedInput: Array.from(bytes),
      nativeGlobals: ['__TAURI__', '__TAURI_INTERNALS__'].filter(
        key => key in globalThis
      ),
    });
    await client.getDoc('held');
  } catch (error) {
    parent.postMessage({ type: 'failed', error: String(error) });
  } finally {
    client.dispose();
  }
}
