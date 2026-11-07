import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const files = new Map([
  [
    '/frame.html',
    await readFile(new URL('./assets/authority-frame.html', import.meta.url)),
  ],
  [
    '/authority-frame.js',
    await readFile(new URL('./assets/authority-frame.js', import.meta.url)),
  ],
]);
// Only an untrusted frame test fixture. No app assets, native authority, user files or production server.
const server = createServer((request, response) => {
  console.log(request.method, request.url);
  const path = new URL(request.url, 'http://127.0.0.1:8080').pathname;
  const body = files.get(path);
  response.writeHead(body ? 200 : 404, {
    'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html',
    'content-security-policy':
      "default-src 'none'; script-src http://127.0.0.1:8080; connect-src ipc: http://ipc.localhost; frame-ancestors tauri://localhost http://tauri.localhost",
    'cache-control': 'no-store',
  });
  response.end(body ?? 'Not found');
});
server.listen(8080, '127.0.0.1', () =>
  console.log('Untrusted frame fixture ready')
);
