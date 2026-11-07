import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

// Bundle the unchanged production port/client with a disposable native-session fixture.
const fixture = name =>
  fileURLToPath(
    new URL(
      `../../../packages/frontend/tauri-bridge/test/native-fixture/${name}`,
      import.meta.url
    )
  );
await build({
  entryPoints: [fixture('storage-main.ts'), fixture('storage-worker.ts')],
  outdir: fileURLToPath(new URL('./assets', import.meta.url)),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: false,
});
