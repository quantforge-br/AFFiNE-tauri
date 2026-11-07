import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Authoring-only, loopback-only comparison. Never part of application packaging.
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const player = await readFile(
  path.join(root, 'node_modules/lottie-web/build/player/lottie.js')
);
const names = ['collections-icon', 'delete-icon'];
const routes = new Map([['/lottie.js', ['text/javascript', player]]]);
for (const name of names)
  for (const suffix of ['', '.keyframes']) {
    const filename = name + suffix + '.json';
    routes.set('/' + filename, [
      'application/json',
      await readFile(
        path.join(root, 'packages/frontend/component/src/ui/lottie', filename)
      ),
    ]);
  }
const html =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Animation comparison</title><script src="/lottie.js"></script><style>body{margin:0;background:white}#gallery{display:grid;grid-template-columns:repeat(6,150px);width:900px}.cell{width:150px;height:170px;font:12px sans-serif;text-align:center}.animation{width:150px;height:150px}</style></head><body><div id="gallery"></div><script src="/gallery.js"></script></body></html>';
for (const mode of ['reference', 'candidate'])
  routes.set('/' + mode + '.html', ['text/html', html]);
routes.set('/gallery.js', [
  'text/javascript',
  '(' +
    async function gallery() {
      window.__violations = [];
      document.addEventListener('securitypolicyviolation', event =>
        window.__violations.push({
          directive: event.effectiveDirective,
          blockedURI: event.blockedURI,
        })
      );
      try {
        const candidate = location.pathname.includes('candidate');
        for (const name of ['collections-icon', 'delete-icon'])
          for (const frame of [0, 12, 24, 29.875, 42, 60]) {
            const cell = document.createElement('div');
            cell.className = 'cell';
            const label = document.createElement('div');
            label.textContent = name + ' - ' + frame;
            const container = document.createElement('div');
            container.className = 'animation';
            cell.append(container, label);
            document.querySelector('#gallery').append(cell);
            const data = await (
              await fetch(
                '/' + name + (candidate ? '.keyframes' : '') + '.json'
              )
            ).json();
            const animation = lottie.loadAnimation({
              container,
              renderer: 'svg',
              loop: false,
              autoplay: false,
              animationData: data,
            });
            await new Promise((resolve, reject) => {
              animation.addEventListener('DOMLoaded', resolve);
              animation.addEventListener('data_failed', reject);
            });
            animation.goToAndStop(frame, true);
          }
        window.__galleryReady = true;
      } catch (error) {
        window.__galleryError = String(error);
      }
    }.toString() +
    ')();',
]);
const server = createServer((req, res) => {
  const route = routes.get(req.url);
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  const headers = { 'content-type': route[0], 'cache-control': 'no-store' };
  if (req.url === '/candidate.html')
    headers['content-security-policy'] =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'";
  res.writeHead(200, headers).end(route[1]);
});
server.listen(
  Number(process.env.LOTTIE_GALLERY_PORT ?? 8083),
  '127.0.0.1',
  () =>
    console.log(
      'Authoring gallery: http://127.0.0.1:' +
        server.address().port +
        '/{reference,candidate}.html'
    )
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => server.close());
