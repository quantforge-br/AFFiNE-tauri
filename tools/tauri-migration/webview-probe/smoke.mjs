import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.WEBDRIVER_URL ?? 'http://127.0.0.1:4459';
const record = process.env.PROBE_SESSION_FILE;
let sessionId = record
  ? JSON.parse(await readFile(record, 'utf8')).value.sessionId
  : undefined;
const checks = [];

async function request(method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error)
    throw new Error(JSON.stringify(result));
  return result.value;
}
async function command(method, route, body) {
  return request(method, '/session/' + sessionId + route, body);
}
const evaluate = (script, args = []) =>
  command('POST', '/execute/sync', { script, args });
async function until(script, description) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const value = await evaluate(script);
    if (value) return value;
    await delay(300);
  }
  throw new Error('Timed out: ' + description);
}
async function element(using, value) {
  const result = await command('POST', '/element', { using, value });
  return result['element-6066-11e4-a52e-4f735466cecf'];
}
async function click(using, value) {
  const id = await element(using, value);
  return command('POST', '/element/' + id + '/click', {});
}

try {
  if (!sessionId) {
    assert.ok(
      process.env.PROBE_BINARY,
      'PROBE_BINARY is required for a new session'
    );
    sessionId = (
      await request('POST', '/session', {
        capabilities: {
          alwaysMatch: {
            'tauri:options': { application: process.env.PROBE_BINARY },
          },
        },
      })
    ).sessionId;
  }
  await until(
    'return !!document.querySelector("[data-testid=sidebar-new-page-button]")',
    'workspace load'
  );
  const hasDismiss = await evaluate(
    'return [...document.querySelectorAll("button")].some(e=>{const r=e.getBoundingClientRect();return e.textContent.trim()==="Dismiss" && r.width>0 && r.height>0 && r.top>=0 && r.bottom<=innerHeight})'
  );
  if (hasDismiss)
    await click('xpath', '//button[normalize-space(.)="Dismiss"]');
  await click('css selector', '[data-testid="sidebar-new-page-button"]');
  await until(
    'return !!document.querySelector("doc-title .inline-editor")',
    'document editor'
  );
  checks.push({ name: 'create-document', passed: true });
  const title = await element('css selector', 'doc-title .inline-editor');
  await command('POST', '/element/' + title + '/click', {});
  await command('POST', '/element/' + title + '/clear', {});
  const marker = 'Tauri WebView persistence ' + Date.now();
  for (const character of marker) {
    const currentTitle = await element(
      'css selector',
      'doc-title .inline-editor'
    );
    await command('POST', '/element/' + currentTitle + '/value', {
      text: character,
    });
    await delay(60);
  }
  await until(
    'return document.querySelector("doc-title .inline-editor")?.textContent.includes(' +
      JSON.stringify(marker) +
      ')',
    'typed title'
  );
  await evaluate('document.activeElement?.blur(); return true');
  checks.push({ name: 'native-text-input', passed: true, marker });
  const url = await command('GET', '/url');
  const modeSelector = '[data-testid="switch-edgeless-mode-button"]';
  await until(
    'return !!document.querySelector(' + JSON.stringify(modeSelector) + ')',
    'mode switch'
  );
  await click('css selector', modeSelector);
  await until(
    'return !!document.querySelector("affine-edgeless-root")',
    'edgeless editor'
  );
  checks.push({ name: 'switch-edgeless', passed: true });
  await command('POST', '/refresh', {});
  await until(
    'return document.querySelector("doc-title .inline-editor")?.textContent.includes(' +
      JSON.stringify(marker) +
      ')',
    'title persistence after reload'
  );
  await until(
    'return !!document.querySelector("affine-edgeless-root")',
    'edgeless persistence after reload'
  );
  checks.push({ name: 'reload-persistence', passed: true, url });
  const runtime = await evaluate(
    'return {userAgent:navigator.userAgent,url:location.href,secureContext:isSecureContext,indexedDB:typeof indexedDB,worker:typeof Worker,canvas:!!document.createElement("canvas").getContext("2d")}'
  );
  assert.equal(runtime.secureContext, true);
  assert.equal(runtime.indexedDB, 'object');
  assert.equal(runtime.worker, 'function');
  assert.equal(runtime.canvas, true);
  checks.push({ name: 'required-web-platform-apis', passed: true });
  const workerTransport = await command('POST', '/execute/async', {
    script: `
      const done = arguments[arguments.length - 1];
      const bytes = new Uint8Array([0, 1, 127, 128, 255]);
      const channel = new MessageChannel();
      const source = 'self.onmessage = ({data}) => { const {port, buffer} = data; port.postMessage({buffer, nativeIPC: typeof self.__TAURI_INTERNALS__?.invoke === "function"}, [buffer]); };';
      const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
      const worker = new Worker(url);
      const timer = setTimeout(() => finish({error: 'worker transfer timed out'}), 10000);
      function finish(result) {
        clearTimeout(timer);
        worker.terminate();
        channel.port1.close();
        channel.port2.close();
        URL.revokeObjectURL(url);
        done(result);
      }
      worker.onerror = event => finish({error: event.message});
      channel.port1.onmessage = event => finish({
        bytes: Array.from(new Uint8Array(event.data.buffer)),
        detached: bytes.byteLength === 0,
        workerNativeIPC: event.data.nativeIPC,
      });
      worker.postMessage({port: channel.port2, buffer: bytes.buffer}, [channel.port2, bytes.buffer]);
    `,
    args: [],
  });
  assert.deepEqual(workerTransport.bytes, [0, 1, 127, 128, 255]);
  assert.equal(workerTransport.detached, true);
  assert.equal(workerTransport.workerNativeIPC, false);
  checks.push({
    name: 'worker-message-port-binary-transfer',
    passed: true,
    workerTransport,
  });
  const nativeAccess = await command('POST', '/execute/async', {
    script: `
      const done = arguments[arguments.length - 1];
      if (typeof window.__TAURI_INTERNALS__?.invoke !== 'function') {
        done({error: 'native IPC transport missing; cannot verify authorization'});
      } else {
        window.__TAURI_INTERNALS__.invoke('plugin:window|set_title', {label: 'probe', title: 'UNAUTHORIZED'})
          .then(() => done({allowed: true}), error => done({allowed: false, reason: String(error)}));
      }
    `,
    args: [],
  });
  assert.equal(nativeAccess.allowed, false, JSON.stringify(nativeAccess));
  assert.match(nativeAccess.reason, /not allowed|not permitted|denied/i);
  checks.push({
    name: 'remote-native-command-denied',
    passed: true,
    reason: nativeAccess.reason,
  });
  const evidence = {
    scope: 'reference frontend in isolated Tauri WebView; not desktop parity',
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    checks,
    runtime,
  };
  if (process.env.PROBE_EVIDENCE_FILE)
    await writeFile(
      process.env.PROBE_EVIDENCE_FILE,
      JSON.stringify(evidence, null, 2) + '\n'
    );
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const diagnostic = sessionId
    ? await evaluate(
        'return {url:location.href,viewport:[innerWidth,innerHeight],text:document.body.innerText.slice(0,1800),title:document.querySelector("doc-title .inline-editor")?.textContent,editor:!!document.querySelector("affine-page-root"),edgeless:!!document.querySelector("affine-edgeless-root")}'
      ).catch(String)
    : null;
  const failure = { checks, failure: String(error), diagnostic, sessionId };
  if (process.env.PROBE_EVIDENCE_FILE)
    await writeFile(
      process.env.PROBE_EVIDENCE_FILE,
      JSON.stringify(failure, null, 2) + '\n'
    );
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
} finally {
  if (sessionId && process.env.PROBE_KEEP_SESSION !== '1') {
    await command('DELETE', '').catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
