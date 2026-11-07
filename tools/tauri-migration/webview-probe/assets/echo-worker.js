async function reply(port, message) {
  const details = {
    message,
    origin: self.location.origin,
    nativeIPC: typeof self.__TAURI_INTERNALS__?.invoke === 'function',
    secureContext: self.isSecureContext,
    crypto: typeof self.crypto?.randomUUID,
    indexedDB: typeof self.indexedDB,
  };
  try {
    details.database = await new Promise((resolve, reject) => {
      const request = self.indexedDB.open('worker-diagnostic', 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => request.result.createObjectStore('test');
      request.onsuccess = () => {
        const db = request.result;
        const write = db.transaction('test', 'readwrite');
        write.objectStore('test').put(new Uint8Array([0, 127, 255]), 'bytes');
        write.onerror = () => {
          db.close();
          reject(write.error);
        };
        write.oncomplete = () => {
          const read = db.transaction('test').objectStore('test').get('bytes');
          read.onerror = () => {
            db.close();
            reject(read.error);
          };
          read.onsuccess = () => {
            details.databaseBytes = Array.from(read.result);
            db.close();
            resolve(JSON.stringify(details.databaseBytes) === '[0,127,255]');
          };
        };
      };
    });
  } catch (error) {
    details.databaseError = String(error);
  }
  port.postMessage(details);
}
if ('onconnect' in self) {
  self.onconnect = event => {
    const port = event.ports[0];
    port.onmessage = event => reply(port, event.data);
    port.start();
  };
} else {
  self.onmessage = event => reply(self, event.data);
}
