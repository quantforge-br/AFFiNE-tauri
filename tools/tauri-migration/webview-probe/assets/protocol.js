// This diagnostic does not import AFFiNE or grant native capabilities.
window.__protocolResults = {
  origin: location.origin,
  secureContext: isSecureContext,
  checks: [],
  done: false,
};
const results = window.__protocolResults;
const render = () =>
  (document.querySelector('#results').textContent = JSON.stringify(
    results,
    null,
    2
  ));
async function workerCheck(kind, url) {
  return new Promise(resolve => {
    let worker;
    let endpoint;
    const timer = setTimeout(
      () => finish({ passed: false, error: 'worker response timeout' }),
      6000
    );
    function finish(result) {
      clearTimeout(timer);
      if (kind === 'shared') endpoint?.close();
      else worker?.terminate();
      resolve(result);
    }
    try {
      worker =
        kind === 'shared'
          ? new SharedWorker(url, { name: crypto.randomUUID() })
          : new Worker(url);
      endpoint = kind === 'shared' ? worker.port : worker;
      worker.onerror = event =>
        finish({
          passed: false,
          error: String(event.message || 'worker error'),
        });
      endpoint.onmessage = event =>
        finish({
          passed:
            event.data.message === 'protocol-test' &&
            event.data.nativeIPC === false,
          databasePassed:
            event.data.database === true &&
            event.data.databaseError === undefined,
          response: event.data,
        });
      if (kind === 'shared') endpoint.start();
      endpoint.postMessage('protocol-test');
    } catch (error) {
      finish({ passed: false, error: String(error) });
    }
  });
}
async function check(name, action) {
  try {
    results.checks.push({ name, ...(await action()) });
  } catch (error) {
    results.checks.push({ name, passed: false, error: String(error) });
  }
  render();
}
(async () => {
  await check('fetch-worker-asset', async () => {
    const response = await fetch('echo-worker.js');
    results.workerSource = await response.text();
    return {
      passed: response.ok && results.workerSource.includes('onconnect'),
      status: response.status,
      type: response.headers.get('content-type'),
    };
  });
  await check(
    'indexeddb-roundtrip',
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('native-protocol-diagnostic', 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore('test');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const write = db.transaction('test', 'readwrite');
          write.objectStore('test').put(new Uint8Array([0, 127, 255]), 'bytes');
          write.onerror = () => {
            db.close();
            reject(write.error);
          };
          write.oncomplete = () => {
            const read = db
              .transaction('test')
              .objectStore('test')
              .get('bytes');
            read.onerror = () => {
              db.close();
              reject(read.error);
            };
            read.onsuccess = () => {
              const bytes = Array.from(read.result);
              db.close();
              resolve({
                passed: JSON.stringify(bytes) === '[0,127,255]',
                bytes,
              });
            };
          };
        };
      })
  );
  for (const kind of ['dedicated', 'shared']) {
    if (kind === 'shared' && typeof SharedWorker !== 'function') {
      results.checks.push({
        name: 'shared-worker-availability',
        passed: false,
      });
      continue;
    }
    await check(kind + '-native-url', () =>
      workerCheck(kind, 'echo-worker.js')
    );
    const blob = URL.createObjectURL(
      new Blob([results.workerSource], { type: 'text/javascript' })
    );
    await check(kind + '-fetched-blob', () => workerCheck(kind, blob));
    URL.revokeObjectURL(blob);
  }
  await check('native-history-roundtrip', async () => {
    const previous = location.pathname;
    history.pushState({ diagnostic: true }, '', '/workspace/protocol/document');
    const matched = location.pathname === '/workspace/protocol/document';
    history.replaceState(null, '', previous);
    return { passed: matched && location.pathname === previous };
  });
  delete results.workerSource;
  results.done = true;
  render();
})().catch(error => {
  results.failure = String(error);
  results.done = true;
  render();
});
