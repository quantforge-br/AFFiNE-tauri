import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const read = relative => readFile(path.join(root, relative), 'utf8');
const assetDir = 'packages/frontend/component/src/ui/lottie/';
const sha256 = content =>
  createHash('sha256').update(content.replaceAll('\r\n', '\n')).digest('hex');
const evidence = JSON.parse(
  await read('docs/tauri-migration/evidence/lottie-keyframes.json')
);
function expressions(value, trail = [], result = []) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'x' && typeof child === 'string') result.push(trail.join('.'));
    else expressions(child, [...trail, key], result);
  }
  return result;
}
for (const name of ['collections-icon', 'delete-icon']) {
  test(
    name + ' keeps the reference source and verified generated asset',
    async () => {
      const source = await read(assetDir + name + '.json');
      const output = await read(assetDir + name + '.keyframes.json');
      const baseline = JSON.parse(source);
      const candidate = JSON.parse(output);
      const result = evidence.results.find(result => result.name === name);
      assert.ok(result);
      assert.equal(sha256(source), result.sourceSha256);
      assert.equal(sha256(output), result.outputSha256);
      assert.ok(
        expressions(baseline).length > 0,
        'retain original expressions as authoring input'
      );
      assert.deepEqual(
        expressions(candidate),
        [],
        'no runtime expression evaluation'
      );
      for (const key of ['fr', 'ip', 'op', 'w', 'h', 'v', 'markers'])
        assert.deepEqual(candidate[key], baseline[key]);
      assert.deepEqual(result.directions, ['forward', 'reverse']);
      assert.ok(
        result.validationStep < result.sampleStep,
        'validate between source samples'
      );
      assert.ok(result.maxDesignPixelError < 0.02);
      assert.ok(
        result.frameChecksPerDirection >=
          (baseline.op - baseline.ip) / result.validationStep
      );
      const stripped = structuredClone(baseline);
      for (const expressionPath of expressions(stripped)) {
        const property = expressionPath
          .split('.')
          .reduce((value, key) => value[key], stripped);
        delete property.x;
      }
      if (name === 'collections-icon') {
        for (let index = 0; index < 2; index++) {
          stripped.assets[0].layers[index].ks.p = structuredClone(
            candidate.assets[0].layers[index].ks.p
          );
        }
      }
      assert.deepEqual(
        candidate,
        stripped,
        'preserve all unrelated animation data'
      );
      const component = await read(assetDir + name + '.tsx');
      assert.ok(component.includes("from './" + name + ".keyframes.json'"));
      assert.ok(component.includes('lottie.setDirection(-1)'));
      assert.ok(component.includes('lottie.setDirection(1)'));
      if (name === 'collections-icon') {
        for (const [index, layer] of candidate.assets[0].layers.entries()) {
          if (index > 1) break;
          assert.equal(layer.ks.p.a, 1);
          assert.ok(
            layer.ks.p.k.length > 2,
            'preserve spring motion, not flattened endpoints'
          );
          const keys = layer.ks.p.k;
          assert.equal(keys[0].t, baseline.ip);
          assert.equal(keys.at(-1).t, baseline.op);
          for (let i = 0; i < keys.length; i++) {
            assert.ok(keys[i].s.every(Number.isFinite));
            if (i) assert.ok(keys[i].t > keys[i - 1].t);
          }
        }
      }
    }
  );
}
test('embedded probe enforces CSP without dynamic JavaScript evaluation or privileges', async () => {
  const config = JSON.parse(
    await read('tools/tauri-migration/webview-probe/tauri.bundled.conf.json')
  );
  assert.deepEqual(config.app.security.capabilities, []);
  const policy = config.app.security.csp;
  assert.equal(typeof policy, 'string');
  assert.ok(policy.includes("script-src 'self' 'wasm-unsafe-eval'"));
  assert.ok(!policy.includes("'unsafe-eval'"));
  const main = await read('tools/tauri-migration/webview-probe/src/main.rs');
  assert.ok(
    !main.includes('enableTelemetry:false'),
    'no diagnostic preference changes'
  );
});
