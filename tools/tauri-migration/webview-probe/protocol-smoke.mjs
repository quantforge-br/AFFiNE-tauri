import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const base = process.env.WEBDRIVER_URL ?? 'http://127.0.0.1:4460';
let sessionId;
let evidence;
async function request(method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error)
    throw new Error(JSON.stringify(result));
  return result.value;
}
try {
  assert.ok(process.env.PROBE_BINARY);
  sessionId = (
    await request('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'tauri:options': { application: process.env.PROBE_BINARY },
        },
      },
    })
  ).sessionId;
  const deadline = Date.now() + 40000;
  do {
    evidence = await request(
      'POST',
      '/session/' + sessionId + '/execute/sync',
      { script: 'return window.__protocolResults', args: [] }
    );
    if (evidence?.done) break;
    await delay(300);
  } while (Date.now() < deadline);
  assert.equal(evidence?.done, true, 'protocol diagnostic did not finish');
  assert.equal(evidence.failure, undefined);
  assert.equal(evidence.secureContext, true);
  for (const name of [
    'native-history-roundtrip',
    'fetch-worker-asset',
    'indexeddb-roundtrip',
    'dedicated-native-url',
    'dedicated-fetched-blob',
  ]) {
    const check = evidence.checks.find(check => check.name === name);
    assert.equal(check?.passed, true, name + ' transport failed');
    if (name.startsWith('dedicated'))
      assert.equal(check.databasePassed, true, name + ' storage failed');
  }
  evidence.sharedWorkerStorageSupported = evidence.checks
    .filter(check => check.name.startsWith('shared-'))
    .every(check => check.passed && check.databasePassed);
  evidence.acceptance =
    'Dedicated Worker transport and storage required; SharedWorker results are diagnostic only';
} catch (error) {
  evidence = { ...evidence, failure: String(error) };
  process.exitCode = 1;
} finally {
  evidence = {
    scope: 'Minimal native-scheme reproduction, not AFFiNE or desktop parity',
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
