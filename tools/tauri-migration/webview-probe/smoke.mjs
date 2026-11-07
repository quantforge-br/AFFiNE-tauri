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
async function waitForClickable(selector) {
  await until(
    'const element = document.querySelector(' +
      JSON.stringify(selector) +
      ');' +
      'if (!element) return false;' +
      'const rect = element.getBoundingClientRect();' +
      'const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;' +
      'const target = document.elementFromPoint(x, y);' +
      'return rect.width > 0 && rect.height > 0 && (target === element || element.contains(target));',
    'clickable ' + selector
  );
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
  await until(
    'return !!document.querySelector("doc-title .inline-editor")',
    'initial editor loaded'
  );
  await waitForClickable('[data-testid="sidebar-new-page-button"]');
  const previousDocument = await evaluate('return location.pathname');
  await click('css selector', '[data-testid="sidebar-new-page-button"]');
  await until(
    'const title = document.querySelector("doc-title"); return location.pathname !== ' +
      JSON.stringify(previousDocument) +
      ' && !!title?.querySelector(".inline-editor") && title.doc?.id === location.pathname.split("/")[3]',
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
  const persisted = await command('POST', '/execute/async', {
    script: `
      const done = arguments[arguments.length - 1];
      const workspace = window.currentWorkspace;
      const [, , workspaceId, docId] = location.pathname.split('/');
      if (!workspace || !workspaceId || !docId) {
        done({saved: false, error: 'workspace engine unavailable'});
      } else {
        Promise.all([workspaceId, 'db$docProperties', docId].map(id =>
          workspace.engine.doc.waitForSynced(id, AbortSignal.timeout(25000))
        )).then(() => done({saved: true}), error => done({saved: false, error: String(error)}));
      }
    `,
    args: [],
  });
  assert.equal(persisted.saved, true, JSON.stringify(persisted));
  checks.push({ name: 'local-storage-write-completed', passed: true });
  const previousTimeOrigin = await evaluate('return performance.timeOrigin');
  // Immediate location.reload() discards WKWebView's evaluation callback in tauri-wd 0.1.11.
  // Schedule a real navigation after the command returns, then require a new document.
  await evaluate('setTimeout(() => location.reload(), 50); return true');
  await until(
    'return performance.timeOrigin !== ' + previousTimeOrigin,
    'new document after reload'
  );
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
    'return {workers:window.__probeWorkers,userAgent:navigator.userAgent,url:location.href,secureContext:isSecureContext,indexedDB:typeof indexedDB,worker:typeof Worker,canvas:!!document.createElement("canvas").getContext("2d")}'
  );
  assert.equal(runtime.secureContext, true);
  assert.equal(runtime.indexedDB, 'object');
  assert.equal(runtime.worker, 'function');
  assert.equal(runtime.canvas, true);
  assert.ok(
    runtime.workers?.some(
      worker => worker.kind === 'Worker' && worker.url.includes('/nbstore-')
    )
  );
  assert.ok(!runtime.workers?.some(worker => worker.kind === 'SharedWorker'));
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
  // Architecture-level API exercise, not end-user tab or drag/drop acceptance.
  const originalView = await evaluate(
    'return {id:window.workbench.activeView$.value.id,location:window.workbench.activeView$.value.location$.value}'
  );
  await evaluate(
    'window.__probeEditorHost = document.querySelector("affine-edgeless-root"); window.workbench.createView("tail", "/all", false); return true'
  );
  await until(
    'return document.querySelectorAll("[data-testid=split-view-panel]").length === 2',
    'two real workbench panels'
  );
  assert.equal(
    await evaluate('return window.__probeEditorHost.isConnected'),
    true
  );
  const routes = await evaluate(
    'return window.workbench.views$.value.map(view => ({id:view.id,path:view.location$.value.pathname}))'
  );
  assert.equal(routes.length, 2);
  assert.equal(routes[0].id, originalView.id);
  assert.equal(routes[0].path, originalView.location.pathname);
  assert.equal(routes[1].path, '/all');
  await evaluate(
    'window.workbench.views$.value[1].push("/journal"); return true'
  );
  await until(
    'return window.workbench.views$.value[1].location$.value.pathname === "/journal"',
    'independent secondary view history'
  );
  assert.equal(
    await evaluate(
      'return window.workbench.views$.value[0].location$.value.pathname'
    ),
    originalView.location.pathname
  );
  assert.equal(
    await evaluate('return window.__probeEditorHost.isConnected'),
    true
  );
  await evaluate(
    'window.workbench.close(window.workbench.views$.value[1]); delete window.__probeEditorHost; return true'
  );
  await until(
    'return document.querySelectorAll("[data-testid=split-view-panel]").length === 1',
    'secondary workbench view disposal'
  );
  checks.push({
    name: 'multi-view-routing-feasibility',
    passed: true,
    scope: 'public workbench API; no tabs, focus changes or drag/drop',
    routes,
  });
  if (process.env.PROBE_BUNDLED_FRONTEND === '1') {
    const policy = await evaluate(
      'return {origin:location.origin,csp:window.__probeCspViolations}'
    );
    assert.ok(
      ['tauri://localhost', 'http://tauri.localhost'].includes(policy.origin)
    );
    assert.ok(Array.isArray(policy.csp), 'CSP instrumentation is required');
    assert.deepEqual(
      policy.csp.filter(item => item.directive.startsWith('script-src')),
      [],
      'bundled scripts must not violate enforced CSP'
    );
    await evaluate(
      'const script = document.createElement("script"); script.src = "/__probe-csp.js"; document.head.append(script); return true;'
    );
    const dynamicScript = await until(
      'return window.__probePageCsp',
      'page-context CSP negative check'
    );
    assert.equal(
      dynamicScript.blocked,
      true,
      'enforced CSP must reject dynamic JavaScript compilation'
    );
    assert.equal(dynamicScript.context, 'page-script');
    policy.dynamicScript = dynamicScript;
    checks.push({ name: 'native-origin-script-csp', passed: true, ...policy });
  }
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
        'return {errors:window.__probeErrors,workers:window.__probeWorkers,focused:document.hasFocus(),visibility:document.visibilityState,workspace:window.currentWorkspace?{id:window.currentWorkspace.id,flavour:window.currentWorkspace.flavour}:null,url:location.href,viewport:[innerWidth,innerHeight],text:document.body.innerText.slice(0,1800),title:document.querySelector("doc-title .inline-editor")?.textContent,editor:!!document.querySelector("affine-page-root"),edgeless:!!document.querySelector("affine-edgeless-root")}'
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
