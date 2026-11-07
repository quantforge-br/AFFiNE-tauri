import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Authoring only: original expressions run in an unprivileged local browser.
// This server and dynamic expression evaluation are never desktop runtime dependencies.
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const assetDir = path.join(root, 'packages/frontend/component/src/ui/lottie');
const names = ['collections-icon', 'delete-icon'];
const checkOnly = process.argv.includes('--check');
const sourceHashes = {
  'collections-icon':
    'acd0beb1eb4542f1818517f8d7861e1114136292ae21cc8d045ffad9381a4598',
  'delete-icon':
    'c1470ca2673d7a9ba050cec3f12bf50a5b86397d281269aacbce46c7a62b4ad8',
};
function formattedJson(value, filename) {
  return execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules/oxfmt/bin/oxfmt'),
      '--stdin-filepath',
      filename,
    ],
    {
      input: JSON.stringify(value),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    }
  );
}
async function emit(filename, content) {
  if (checkOnly)
    assert.equal(
      await readFile(filename, 'utf8'),
      content,
      'Stale generated file: ' + filename
    );
  else await writeFile(filename, content);
}
const inputs = Object.fromEntries(
  await Promise.all(
    names.map(async name => [
      name,
      await readFile(path.join(assetDir, name + '.json'), 'utf8'),
    ])
  )
);
for (const name of names)
  assert.equal(
    createHash('sha256').update(inputs[name]).digest('hex'),
    sourceHashes[name],
    'Review changed animation source before converting: ' + name
  );
const player = await readFile(
  path.join(root, 'node_modules/lottie-web/build/player/lottie.js')
);
const playerVersion = JSON.parse(
  await readFile(
    path.join(root, 'node_modules/lottie-web/package.json'),
    'utf8'
  )
).version;
const routes = new Map([
  [
    '/',
    [
      'text/html',
      '<!doctype html><html lang="en"><head><title>Local animation authoring</title><script src="/lottie.js"></script></head><body></body></html>',
    ],
  ],
  ['/lottie.js', ['text/javascript', player]],
  ...names.map(name => [
    '/' + name + '.json',
    ['application/json', inputs[name]],
  ]),
]);
const server = createServer((req, res) => {
  const route = routes.get(req.url);
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  res
    .writeHead(200, { 'content-type': route[0], 'cache-control': 'no-store' })
    .end(route[1]);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const session = 'affine-tauri-bake-' + process.pid;
async function browser(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'agent-browser',
      ['--session', session, '--json', ...args],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
        killSignal: 'SIGKILL',
      }
    );
    let output = '',
      error = '';
    child.stdout.on('data', data => {
      output += data;
    });
    child.stderr.on('data', data => {
      error += data;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(error + output));
        return;
      }
      try {
        const result = JSON.parse(output);
        assert.equal(result.success, true);
        resolve(result.data);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(input);
  });
}
try {
  await browser(['open', 'http://127.0.0.1:' + server.address().port]);
  const response = await browser(
    ['eval', '--stdin'],
    '(' +
      async function bake() {
        const names = ['collections-icon', 'delete-icon'];
        const output = [];
        const step = 1 / 32;
        const tolerance = 0.00015;
        const clone = value => JSON.parse(JSON.stringify(value));
        const walk = (value, visit, trail = []) => {
          if (!value || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            if (key === 'x' && typeof child === 'string') visit(value, trail);
            else walk(child, visit, [...trail, key]);
          }
        };
        const load = async data => {
          const container = document.createElement('div');
          document.body.append(container);
          const animation = lottie.loadAnimation({
            container,
            renderer: 'svg',
            autoplay: false,
            loop: false,
            animationData: clone(data),
          });
          await new Promise((resolve, reject) => {
            animation.addEventListener('DOMLoaded', resolve);
            animation.addEventListener('data_failed', reject);
          });
          return animation;
        };
        const errorAt = (start, end, sample) => {
          const ratio = (sample.t - start.t) / (end.t - start.t);
          return Math.max(
            ...sample.s.map((value, i) =>
              Math.abs(value - (start.s[i] + ratio * (end.s[i] - start.s[i])))
            )
          );
        };
        function simplify(samples, start = 0, end = samples.length - 1) {
          let max = tolerance,
            split = -1;
          for (let i = start + 1; i < end; i++) {
            const error = errorAt(samples[start], samples[end], samples[i]);
            if (error > max) {
              max = error;
              split = i;
            }
          }
          if (split === -1) return [samples[start], samples[end]];
          return [
            ...simplify(samples, start, split).slice(0, -1),
            ...simplify(samples, split, end),
          ];
        }
        for (const name of names) {
          const data = await (await fetch('/' + name + '.json')).json();
          const original = await load(data);
          const candidate = clone(data),
            properties = [];
          walk(candidate, (property, trail) => {
            if (property.x === 'var $bm_rt;\n$bm_rt = clamp(value, 0, 100);') {
              if (
                property.a !== 0 ||
                typeof property.k !== 'number' ||
                property.k < 0 ||
                property.k > 100
              )
                throw new Error('Unexpected clamp property');
            } else {
              if (
                name !== 'collections-icon' ||
                !/^assets\.0\.layers\.[01]\.ks\.p$/.test(trail.join('.'))
              )
                throw new Error('Unknown expression: ' + trail.join('.'));
              const layerIndex = Number(trail[3]);
              properties.push({ property, layerIndex, samples: [] });
            }
            delete property.x;
          });
          const sampleFrames = new Set();
          for (let frame = data.ip; frame <= data.op; frame += step)
            sampleFrames.add(frame);
          for (const item of properties)
            for (const key of item.property.k) {
              if (key.t >= data.ip && key.t <= data.op) {
                sampleFrames.add(key.t);
                if (key.t > data.ip) sampleFrames.add(key.t - 0.0000001);
                if (key.t < data.op) sampleFrames.add(key.t + 0.0000001);
              }
            }
          for (const frame of [...sampleFrames].sort((a, b) => a - b)) {
            original.goToAndStop(Math.min(frame, data.op - 0.00001), true);
            for (const item of properties)
              item.samples.push({
                t: frame,
                s: Array.from(
                  original.renderer.elements[1].elements[item.layerIndex]
                    .finalTransform.mProp.p.v
                ),
              });
          }
          for (const item of properties) {
            item.property.k = simplify(item.samples).map(key => ({
              ...key,
              i: { x: 1, y: 1 },
              o: { x: 0, y: 0 },
            }));
            item.property.a = 1;
          }
          const baked = await load(candidate);
          let maxPropertyError = 0,
            worst;
          const frameChecks = Math.ceil((data.op - data.ip) / step) * 2;
          // Check between source samples, then traverse backwards as hover animation does.
          for (const direction of [1, -1])
            for (let index = 0; index < frameChecks; index++) {
              const frame =
                data.ip +
                ((direction === 1 ? index : frameChecks - 1 - index) * step) /
                  2;
              original.goToAndStop(frame, true);
              baked.goToAndStop(frame, true);
              for (const item of properties) {
                const a =
                  original.renderer.elements[1].elements[item.layerIndex]
                    .finalTransform.mProp.p.v;
                const b =
                  baked.renderer.elements[1].elements[item.layerIndex]
                    .finalTransform.mProp.p.v;
                const error = Math.max(
                  ...a.map((value, i) => Math.abs(value - b[i]))
                );
                if (error > maxPropertyError) {
                  maxPropertyError = error;
                  worst = {
                    frame,
                    direction,
                    layer: item.layerIndex,
                    a: Array.from(a),
                    b: Array.from(b),
                  };
                }
              }
              if (name === 'delete-icon')
                for (let i = 0; i < original.renderer.elements.length; i++) {
                  const a =
                    original.renderer.elements[i].finalTransform.mat.props;
                  const b = baked.renderer.elements[i].finalTransform.mat.props;
                  maxPropertyError = Math.max(
                    maxPropertyError,
                    ...a.map((value, j) => Math.abs(value - b[j]))
                  );
                }
            }
          // Largest composition scale is 12.46: require less than 0.02 px at 300px.
          if (maxPropertyError * 12.46 >= 0.02)
            throw new Error(
              name +
                ' exceeds geometry tolerance: ' +
                JSON.stringify({ maxPropertyError, worst })
            );
          output.push({
            name,
            data: candidate,
            validation: {
              sampleStep: step,
              validationStep: step / 2,
              directions: ['forward', 'reverse'],
              frameChecksPerDirection: frameChecks,
              maxPropertyError,
              maxDesignPixelError: maxPropertyError * 12.46,
              keyframes: properties.map(item => ({
                layerIndex: item.layerIndex,
                count: item.property.k.length,
              })),
            },
          });
          original.destroy();
          baked.destroy();
        }
        return output;
      }.toString() +
      ')()'
  );
  const results = response.result;
  assert.equal(results.length, names.length);
  const evidence = {
    scope: 'Authoring-time numerical validation, not native visual parity',
    playerVersion,
    sourceSampleStep: 1 / 32,
    results: [],
  };
  for (const result of results) {
    const content = formattedJson(result.data, result.name + '.keyframes.json');
    const filename = result.name + '.keyframes.json';
    await emit(path.join(assetDir, filename), content);
    evidence.results.push({
      name: result.name,
      sourceSha256: createHash('sha256')
        .update(inputs[result.name])
        .digest('hex'),
      outputSha256: createHash('sha256').update(content).digest('hex'),
      ...result.validation,
    });
  }
  await emit(
    path.join(root, 'docs/tauri-migration/evidence/lottie-keyframes.json'),
    formattedJson(evidence, 'lottie-keyframes.json')
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser(['close']).catch(() => {});
  await new Promise(resolve => server.close(resolve));
}
