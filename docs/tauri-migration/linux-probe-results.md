# Linux architecture probe results

## Scope and revisions

Reference application revision: ef401b20cb2a5960278a8e7ab2c0e96d8f759aeb. The probe sources are in tools/tauri-migration/webview-probe. This is compatibility evidence only: the probe loads the existing web frontend from a local development server and is **not** the completed native desktop application. Its persistence check uses the reference browser storage, not a new Tauri SQLite adapter.

The original reproducible Linux run is recorded in [evidence/linux-webview-smoke.json](evidence/linux-webview-smoke.json). The runner starts/stops its own processes and rejects occupied ports. Subsequent [third CI evidence](evidence/ci-webview-probe-third.json) records nine passing editor checks on Linux, Windows and macOS, plus passing minimal native-protocol dedicated Worker storage diagnostics. The first and second failed CI runs remain preserved.

## Verified results

| Check                                   | Result                            | Scope                                                                                                                                  |
| --------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline IPC inventory                  | 5 tests passed, 0 failures        | 177 unique members, deterministic regeneration, source locations, no fabricated implementation status                                  |
| Native storage library cargo check      | Passed                            | affine_nbstore with use-as-lib, locked reference dependencies                                                                          |
| Native storage library cargo test       | 31 tests passed, 0 failures       | Documents, blobs, sync clocks, schema validation/migrations, index persistence; no Node process needed to run the Rust test executable |
| Electron reference unit suite           | 122 tests passed, 14 files passed | Actual Linux @affine/native binding built; BUILD_TYPE=canary; reference test fixtures only                                             |
| Tauri probe build                       | Passed                            | Tauri 2.11.5, tauri-wd 0.1.11 behind optional e2e feature, Linux x86_64                                                                |
| Native decoration state at construction | False                             | Rust is_decorated assertion passed; native app emitted AFFINE_PROBE_WINDOW decorations=false                                           |
| Real frontend creates a document        | Passed                            | WebKitGTK in isolated X11 display, W3C element click                                                                                   |
| Real editor text input                  | Passed                            | Character-by-character W3C element input, not direct document/model mutation                                                           |
| Switch to edgeless                      | Passed                            | Existing mode-switch control creates affine-edgeless-root                                                                              |
| Reload persistence                      | Passed                            | Typed title and edgeless mode survive WebView reload; no mock persistence                                                              |
| Canvas/IndexedDB/Worker/secure context  | Available                         | Queried inside the actual native WebView                                                                                               |
| Worker/MessagePort binary transport     | Passed                            | Actual Worker returns transferred bytes 0/1/127/128/255, sender buffer detached, no Worker native IPC                                  |
| Remote native command authorization     | Denied as expected                | Invoking core window.set_title from the localhost content returns a permission error; not a complete IPC security audit                |

## Commands

The host has an incomplete explicit Rust 1.97.1 directory, but the 1.97 alias runs rustc/cargo 1.97.1. Per-command overrides avoid editing the original checkout or global defaults.

    RUSTUP_TOOLCHAIN=1.97 CARGO_TARGET_DIR=/tmp/affine-tauri-build/native-target cargo check -p affine_nbstore --features use-as-lib --locked
    RUSTUP_TOOLCHAIN=1.97 CARGO_TARGET_DIR=/tmp/affine-tauri-build/native-target CARGO_PROFILE_DEV_DEBUG=0 cargo test -p affine_nbstore --features use-as-lib --locked --lib

After installing workspace dependencies with Node 22.23.4 and checked-in Yarn 4.18.0, run the existing templates build and start the reference frontend:

    node .yarn/releases/yarn-4.18.0.cjs workspace @affine/templates build
    node .yarn/releases/yarn-4.18.0.cjs affine dev -p @affine/web

In tools/tauri-migration/webview-probe:

    RUSTUP_TOOLCHAIN=1.97 CARGO_TARGET_DIR=/tmp/affine-tauri-build/probe-target CARGO_PROFILE_DEV_DEBUG=0 cargo build --locked --features e2e
    cargo install tauri-wd --version 0.1.11 --locked --root /tmp/affine-tauri-build/driver

Start a dedicated driver in a virtual display, not the user's desktop:

    env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a -s '-screen 0 1600x1000x24' /tmp/affine-tauri-build/driver/bin/tauri-wd --port 4460

From the repository root:

    WEBDRIVER_URL=http://127.0.0.1:4460 PROBE_BINARY=/tmp/affine-tauri-build/probe-target/debug/affine-webview-probe PROBE_EVIDENCE_FILE=/tmp/affine-tauri-build/webkit-smoke.json node tools/tauri-migration/webview-probe/smoke.mjs

The script deletes its WebDriver session in finally unless PROBE_KEEP_SESSION=1 is explicitly requested for diagnosis. It never uses a real user's workspace or credentials. The probe identifier is separate from AFFiNE. System package versions observed: GTK 3.24.52, WebKitGTK 2.54.2.

## Issues found and resolved in the probe

- Dependency resolution originally combined Tauri 2.11.5 with incompatible newer runtime/codegen releases. The checked-in probe lockfile pins the matching runtime 2.11.3, runtime-wry 2.11.4, macros/codegen/plugin 2.6.3 and utils 2.9.3. Do not regenerate it indiscriminately.
- The reference template JSON/assets must be generated before bundling; missing generated templates were setup omissions, not Tauri regressions.
- The native driver originally inherited WAYLAND_DISPLAY and attached to the real compositor despite Xvfb. Explicit X11 isolation avoids that and gives deterministic geometry.
- The reference open-in-app banner may be offscreen. The test dismisses it only if visible rather than treating a hidden banner as an editor failure.
- Bulk send-keys only inserted the first character into the reactive editor with this driver. Separate W3C key commands and an inter-character delay work; this is a test-driver limitation, not evidence of a production keyboard defect.
- The initial Electron reference run had 115 passing / 7 failing tests because @affine/native had not been built. After building the actual Linux Node binding, all 122 tests passed in all 14 files with BUILD_TYPE=canary. No test mocks or application source changes were needed to resolve those seven failures. The build regenerated platform-specific binding declarations/loaders; those generated tracked files were restored before committing, while the ignored local binary remained available for the reference tests.

## Still unverified

Cold process restart persistence, SQLite-to-Tauri integration, full offline asset packaging, native auth/sync, complete IPC security, clipboard/import/export, tabs, real split-view lifecycle, cross-window worker ownership, media, signed updates, window-control transitions and other parity items remain open. Third CI run 42382266355 passes the nine-check development-origin editor smoke on all three systems, resolving the earlier Windows reload/Linux interaction failures through stronger document identity/interaction sequencing. This does not establish full embedded-native-origin application execution or production desktop parity.
