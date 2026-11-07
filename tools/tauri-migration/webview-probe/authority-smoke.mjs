import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.WEBDRIVER_URL ?? 'http://127.0.0.1:4460';
let sessionId;
let evidence = {
  scope:
    'Disposable native command authority diagnostic; no storage or production frontend',
};
async function request(method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45_000),
  });
  const value = await response.json();
  if (!response.ok || value.value?.error)
    throw new Error(JSON.stringify(value));
  return value.value;
}
const execute = script =>
  request('POST', '/session/' + sessionId + '/execute/sync', {
    script,
    args: [],
  });
const transientScriptTimeouts = [];
// WebView2 can lose the callback of a script that is pending while the document is replaced. Only
// that exact timeout is retried, each one is recorded, and acceptance still needs the page evidence.
async function poll(script) {
  try {
    return await execute(script);
  } catch (error) {
    if (
      !String(error).includes('script timeout') ||
      transientScriptTimeouts.length >= 12
    )
      throw error;
    transientScriptTimeouts.push({
      at: new Date().toISOString(),
      script: script.slice(0, 60),
    });
    return undefined;
  }
}
try {
  sessionId = (
    await request('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'tauri:options': { application: process.env.PROBE_BINARY },
        },
      },
    })
  ).sessionId;
  evidence.transientScriptTimeouts = transientScriptTimeouts;
  await request('POST', '/session/' + sessionId + '/timeouts', {
    script: 5_000,
  });
  const handles = await request(
    'GET',
    '/session/' + sessionId + '/window/handles'
  );
  let main;
  let blocked;
  for (const handle of handles) {
    await request('POST', '/session/' + sessionId + '/window', { handle });
    const path = await execute('return location.pathname');
    if (path === '/authority.html') main = handle;
    if (path === '/authority-blocked.html') blocked = handle;
  }
  assert.ok(main, 'main diagnostic WebView missing');
  assert.ok(blocked, 'capability-denied WebView missing');
  await request('POST', '/session/' + sessionId + '/window', {
    handle: blocked,
  });
  let denied;
  const deadline = Date.now() + 45_000;
  do {
    denied = await execute('return window.__blockedAuthority');
    if (denied?.done) break;
    await delay(250);
  } while (Date.now() < deadline);
  assert.equal(denied?.done, true, 'denied WebView did not finish');
  assert.equal(denied.authorized, false);
  assert.match(denied.denial, /not allowed/);
  evidence.blockedWebview = denied;
  await request('POST', '/session/' + sessionId + '/window', { handle: main });
  let result;
  do {
    result = await poll('return window.__authorityResults');
    if (result?.done) break;
    await delay(250);
  } while (Date.now() < deadline);
  evidence = { ...evidence, ...result };
  assert.equal(result?.done, true, 'main authority diagnostic did not finish');
  assert.equal(result.failure, undefined);
  for (const name of [
    'host-ticket-main-document',
    'forged-ticket-denied',
    'renderer-authority-fields-denied',
    'ungranted-app-command-denied',
    'untrusted-opaque-sandbox-denied',
    'untrusted-cross-origin-denied',
    'same-origin-forged-ticket-denied',
    'worker-has-no-native-bootstrap',
    'real-reload-revokes-previous-document',
  ])
    assert.equal(
      result.checks.find(check => check.name === name)?.passed,
      true,
      name
    );
  assert.deepEqual(result.violations, []);
  await execute(
    "setTimeout(() => { location.href = 'http://127.0.0.1:8080/frame.html?tag=remote-navigation'; }, 0); return true;"
  );
  let remote;
  const remoteDeadline = Date.now() + 45_000;
  do {
    remote = await poll('return window.__frameAuthorityOutcome');
    if (remote?.tag === 'remote-navigation') break;
    await delay(250);
  } while (Date.now() < remoteDeadline);
  evidence.remoteNavigation = remote;
  assert.equal(
    remote?.tag,
    'remote-navigation',
    'remote navigation fixture did not execute'
  );
  assert.equal(remote.authorized, false);
  assert.equal(
    remote.invokeSource,
    'frame',
    'remote fixture did not attempt native IPC'
  );
  assert.match(remote.denial, /not allowed/);
  assert.equal(remote.ticketCallback, false);
  assert.equal(remote.origin, 'http://127.0.0.1:8080');
  evidence.checks.push({
    name: 'remote-navigation-native-command-denied',
    passed: true,
  });
} catch (error) {
  evidence.failure ??= String(error);
  evidence.collectorFailure = String(error);
  process.exitCode = 1;
} finally {
  evidence = {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    ...evidence,
  };
  console.log(JSON.stringify(evidence, null, 2));
  if (process.env.PROBE_EVIDENCE_FILE)
    await writeFile(
      process.env.PROBE_EVIDENCE_FILE,
      JSON.stringify(evidence, null, 2) + '\n'
    );
  if (sessionId)
    await request('DELETE', '/session/' + sessionId).catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
}
