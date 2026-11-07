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
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  await request('POST', '/session/' + sessionId + '/timeouts', {
    script: 5000,
  });
  const deadline = Date.now() + 120000;
  const documents = new Set();
  const transientErrors = [];
  do {
    try {
      evidence = await request(
        'POST',
        '/session/' + sessionId + '/execute/sync',
        { script: 'return window.__storageResults', args: [] }
      );
    } catch (error) {
      // The real reload replaces the document while this poll is in flight; each error is recorded.
      transientErrors.push(String(error).slice(0, 300));
      evidence = undefined;
      await delay(300);
      continue;
    }
    if (typeof evidence?.timeOrigin === 'number')
      documents.add(evidence.timeOrigin);
    if (evidence?.done) break;
    await delay(300);
  } while (Date.now() < deadline);
  assert.ok(transientErrors.length <= 20, 'Too many transient poll errors');
  assert.equal(
    evidence?.done,
    true,
    'native storage diagnostic did not finish'
  );
  evidence.documentTimeOrigins = [...documents];
  evidence.transientPollErrors = transientErrors;
  // The first document may live shorter than one poll interval, so polling is informational only.
  assert.equal(evidence.failure, undefined);
  assert.deepEqual(evidence.violations, []);
  for (const name of [
    'native-document-ticket',
    'forged-native-ticket-denied',
    'native-authority-fields-denied',
    'ungranted-native-command-denied',
    'worker-private-port-rust-sqlite-roundtrip',
    'awaited-dispose-closes-native-session',
    'sqlite-session-reopen',
    'cancelled-external-waiter-after-real-native-write',
    'worker-termination-explicit-disposal',
    'uncertain-write-reconciled-after-reopen',
    'session-left-open-for-document-replacement',
    'real-reload-revokes-previous-document-storage',
    'previous-document-session-drained-by-replacement',
    'persisted-data-after-real-reload',
    'persisted-cancelled-write-after-real-reload',
  ]) {
    assert.equal(
      evidence.checks.find(check => check.name === name)?.passed,
      true,
      name
    );
  }
  const replacement = evidence.checks.find(
    check => check.name === 'real-reload-revokes-previous-document-storage'
  );
  assert.equal(replacement.navigationType, 'reload');
  assert.ok(replacement.generation > replacement.previousGeneration);
  assert.ok(replacement.timeOriginDeltaMs > 0);
  assert.equal(replacement.stale, 'UNAUTHORIZED');
  assert.equal(replacement.unclaimed, 'UNAUTHORIZED');
  assert.equal(
    evidence.checks.find(
      check => check.name === 'previous-document-session-drained-by-replacement'
    )?.drainedPrevious,
    true
  );
  evidence.acceptance =
    'Disposable native Worker/private-port/production bridge/Rust session/SQLite diagnostic only';
} catch (error) {
  evidence ??= {};
  evidence.failure ??= String(error);
  evidence.collectorFailure = String(error);
  process.exitCode = 1;
} finally {
  evidence = {
    scope:
      'Native storage fixture, not production authorization, lifecycle, editor integration or desktop parity',
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
