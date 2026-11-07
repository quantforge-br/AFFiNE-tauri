# AFFiNE WebView compatibility probe

This is a disposable development tool for the architecture milestone, not an implementation of desktop services or evidence of desktop parity. Frontend/protocol modes register no application IPC commands and grant no remote native capabilities. A separate debug-only authority-probe mode registers diagnostic commands and no storage APIs. A further storage-probe mode, which requires the disposable e2e profile, adds four fixed-scope storage commands for a fixture only. Automation uses disposable per-session profiles on Linux/Windows and ephemeral WKWebView stores on macOS. Ordinary launches use a probe-specific identifier. Do not distribute this executable.

Start the reference frontend on localhost:8080 after generating templates and installing workspace dependencies. From this directory:

    cargo run

To enable native WebDriver automation, use the explicit test-only e2e feature:

    cargo build --features e2e
    cargo install tauri-wd --version 0.1.11 --locked
    tauri-wd

Use a W3C WebDriver session with tauri:options.application pointing to the built executable. The optional driver plugin must never be enabled in release artifacts. Native WKWebView/WebView2/WebKitGTK runs are required; a Chromium browser pass is not a substitute.

The nested Cargo workspace keeps probe/test dependencies out of the production workspace while the architecture is under evaluation. Build output can be redirected with CARGO_TARGET_DIR. The Cargo.lock pins the test tool once resolved.

## Reproducible smoke test

The workflow at .github/workflows/tauri-webview-probe.yml builds and runs the same test on Linux, Windows and macOS. It uploads logs and JSON evidence; a configured workflow is not a passing result.

After installing the driver and building with --features e2e, run from the repository root:

    node tools/tauri-migration/webview-probe/run.mjs

The runner starts the reference frontend and local WebDriver, executes the editor smoke and terminates the processes it created. On Linux use an isolated X11 display:

    env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a -s '-screen 0 1600x1000x24' node tools/tauri-migration/webview-probe/run.mjs

PROBE_DRIVER and CARGO_TARGET_DIR can point to non-default driver/build locations. PROBE_OUTPUT_DIR selects the evidence directory. The smoke validates document creation, real editor input, edgeless switching and persistence across reload. It does not claim process-restart or native SQLite parity.

## Native-origin diagnostic and embedded frontend experiment

The editor probe selects the reference frontend's existing dedicated-Worker path. This is a compatibility test, not the Rust broker. See docs/tauri-migration/worker-transport-decision.md.

To test native-scheme assets independently of AFFiNE, build with e2e,protocol-probe and TAURI_CONFIG containing tauri.protocol.conf.json, then set PROBE_MODE=protocol when invoking run.mjs. The required checks cover asset fetch, main-thread IndexedDB and dedicated-Worker storage. SharedWorker echo and storage results are reported separately; a successful echo must not be represented as storage support. Native capabilities remain empty.

The bundled-frontend feature embeds the reference web dist with tauri.bundled.conf.json. Build that frontend with PUBLIC_PATH=/ before compiling. PROBE_BUNDLED_FRONTEND=1 skips the development server. Linux now passes the ten-check smoke under enforced CSP after built-in animation expressions were converted to validated keyframes; see docs/tauri-migration/lottie-csp.md and evidence/linux-bundled-csp.json. Earlier failures remain preserved. The CI also builds/runs this mode on Windows/macOS; configuration alone is not a passing result. The native-origin-script-csp check requires no script violations. This is not production offline packaging or a Rust storage adapter. Ordinary development-origin runs require rebuilding without bundled-frontend and without the bundled TAURI_CONFIG.

## Isolated document-authority diagnostic

Build with e2e,authority-probe and TAURI_CONFIG containing tauri.authority.conf.json, then run with PROBE_MODE=authority. This mode cannot be combined with frontend/protocol modes or compiled into release builds. The runner serves only two adversarial fixture files on 127.0.0.1:8080 and terminates that server after the test. Production still uses embedded assets, not a localhost server.

The only granted command is authority_ping on the local probe WebView. A second local WebView and the registered authority_forbidden command have no grants. Rust issues a fresh random ticket for each completed trusted document and evaluates delivery into the main document, not a Windows subframe initialization script. The page deletes its one-shot callback and retains the ticket in a closure. A disposable sessionStorage fixture preserves an old ticket solely for the real-reload rejection test; it is not an application credential persistence design. Tickets are excluded from evidence and postMessage payloads.

The smoke requires page-script execution in same-origin, cross-origin and opaque sandbox frames, a dedicated Worker, real reload and remote top-level navigation. A same-origin frame can access and modify the parent realm: its rejected fake ticket is not proof of frame isolation or resistance to a pre-bootstrap callback/prototype attack. Worker absence of globals proves absence of bootstrap, not inability to construct raw IPC traffic.

Load-event timing is platform-specific. In locked Wry 0.55.1, Linux Started corresponds to WebKit Committed, not every attempted/failed navigation. Reload rejection does not prove immediate attempted-navigation revocation, storage drain, BFCache/crash/window-close cleanup or storage ownership. Those gates remain open. The diagnostic does not bind TrustedStorageSession or expose affine_tauri_core. See docs/tauri-migration/native-authority-probe.md.

## Disposable native storage diagnostic

Run `node storage-build.mjs`, then build with `e2e,storage-probe` and TAURI_CONFIG containing tauri.storage.conf.json, then run with PROBE_MODE=storage. The feature reuses the authority ticket, registers `storage_read`, `storage_write`, `storage_close` and `storage_reopen` on the local probe WebView only, and opens a real Rust `StorageSession` in the driver's disposable automation profile. The fixture is bundled from packages/frontend/tauri-bridge/test/native-fixture and uses the production bridge. It is a fixed-space fixture, not the production command boundary, and it moves bytes as JSON number arrays. See docs/tauri-migration/native-storage-probe.md.
