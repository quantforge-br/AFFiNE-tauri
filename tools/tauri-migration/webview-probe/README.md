# AFFiNE WebView compatibility probe

This is a disposable development tool for the architecture milestone. It loads the existing local web frontend, not an implementation of desktop services. It cannot establish desktop parity. There are no application IPC commands and no remote native capabilities. Automation uses a disposable per-session WebView profile on Linux/Windows and an ephemeral WKWebView store on macOS; ordinary launches use a probe-specific identifier. Do not distribute this executable.

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
