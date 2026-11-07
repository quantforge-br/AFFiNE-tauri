import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
);
const output = path.resolve(
  process.env.PROBE_OUTPUT_DIR ?? path.join(root, '.coverage/tauri-probe')
);
const children = [];
const handles = [];
const windows = process.platform === 'win32';
const target = path.resolve(
  process.env.CARGO_TARGET_DIR ??
    path.join(root, 'tools/tauri-migration/webview-probe/target')
);
const binary = path.join(
  target,
  'debug',
  'affine-webview-probe' + (windows ? '.exe' : '')
);

async function requireFreePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  );
}
async function start(command, args, logfile, env = process.env) {
  const handle = await open(path.join(output, logfile), 'w');
  handles.push(handle);
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: ['ignore', handle.fd, handle.fd],
    detached: !windows,
  });
  children.push(child);
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return child;
}
async function waitFor(url, child, label, accept) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(label + ' exited before becoming ready');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok && (await accept(response))) return;
    } catch {
      /* Retry only local readiness probes within the bounded startup deadline. */
    }
    await delay(500);
  }
  throw new Error(label + ' readiness timed out');
}
async function stop(child) {
  if (!child.pid) return;
  if (windows) {
    await new Promise(resolve => {
      const killer = spawn(
        'taskkill',
        ['/pid', String(child.pid), '/T', '/F'],
        { stdio: 'ignore' }
      );
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* Already exited. */
    }
  }
}

await mkdir(output, { recursive: true });
try {
  // Do not accidentally test an unrelated process already listening on these ports.
  await requireFreePort(8080);
  await requireFreePort(4460);
  if (
    process.env.PROBE_BUNDLED_FRONTEND !== '1' &&
    process.env.PROBE_MODE !== 'protocol'
  ) {
    const frontend = await start(
      process.execPath,
      ['.yarn/releases/yarn-4.18.0.cjs', 'affine', 'dev', '-p', '@affine/web'],
      'frontend.log',
      { ...process.env, NODE_OPTIONS: '--max-old-space-size=6144' }
    );
    await waitFor(
      'http://localhost:8080/',
      frontend,
      'reference frontend',
      async response => (await response.text()).includes('<html')
    );
  }
  const driver = await start(
    process.env.PROBE_DRIVER ?? 'tauri-wd',
    ['--port', '4460'],
    'driver.log'
  );
  await waitFor(
    'http://127.0.0.1:4460/status',
    driver,
    'native WebDriver',
    async response => (await response.json()).value?.ready === true
  );
  const smoke = await start(
    process.execPath,
    [
      process.env.PROBE_MODE === 'protocol'
        ? 'tools/tauri-migration/webview-probe/protocol-smoke.mjs'
        : 'tools/tauri-migration/webview-probe/smoke.mjs',
    ],
    'smoke.log',
    {
      ...process.env,
      WEBDRIVER_URL: 'http://127.0.0.1:4460',
      PROBE_BINARY: binary,
      PROBE_EVIDENCE_FILE: path.join(output, 'smoke.json'),
    }
  );
  const status = await Promise.race([
    new Promise((resolve, reject) => {
      if (smoke.exitCode !== null) return resolve(smoke.exitCode);
      smoke.once('exit', resolve);
      smoke.once('error', reject);
    }),
    delay(240_000, undefined, { ref: false }).then(() => {
      throw new Error('native editor smoke timed out');
    }),
  ]);
  if (status !== 0)
    throw new Error('native editor smoke failed; see ' + output);
  console.log('Native editor smoke passed; evidence: ' + output);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) await stop(child);
  for (const handle of handles) await handle.close();
}
