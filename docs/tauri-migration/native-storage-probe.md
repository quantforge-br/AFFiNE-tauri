# Native storage diagnostic (disposable)

This diagnostic exercises one real path inside a native WebView: **dedicated Worker → private MessagePort → production `@affine/tauri-bridge` → Tauri IPC → Rust `StorageSession` → real SQLite**. It is a disposable architecture probe. It is not the production command boundary, not editor integration and not evidence of desktop parity.

## Scope and gates

- Mode `storage-probe` implies `authority-probe`, requires the `e2e` feature (compile error otherwise) and is debug-only through the authority guards.
- The storage root is `tauri_wd::automation_profile_dir()/rust-storage`. Ordinary launches have no such profile and cannot open the fixture.
- One fixed space (`disposable-probe` / workspace / `fixed-fixture`). Requests use `deny_unknown_fields` and cannot carry owner, path, handle, window label, peer or space.
- Commands `storage_read`, `storage_write`, `storage_close` and `storage_reopen` are granted to the local `probe` WebView only. Each calls `authority::authorize`, which derives the WebView label and complete current URL natively and validates the one-shot document ticket. The trusted document in this mode is `/storage.html`.
- Application CSP: `script-src 'self'`, `worker-src 'self'`, `frame-src 'none'`, no `unsafe-eval`, no inline script or style. The bundle is a classic deferred IIFE script; a module script raced the native ticket evaluation (see failed attempts in the evidence).
- The fixture lives in `packages/frontend/tauri-bridge/test/native-fixture/` and reuses the production `bindStoragePort` and `WorkerStorageClient` unchanged. The native-side `TrustedStorageSession` is a fixture that maps the four commands and awaits all pending native invokes before `storage_close`.

## What the Linux run demonstrates

Fifteen checks pass with empty CSP violations (see `evidence/linux-native-storage.json`):

1. The native document ticket reaches only the main document; a forged ticket, injected authority fields and an ungranted registered command are denied.
2. A real Worker with no Tauri bootstrap globals round-trips a Unicode Yjs document and a 256-byte payload through the private port into SQLite; malformed CRDT input is rejected and leaves the stored document intact.
3. Awaited disposal closes the native session; a later request returns `CLOSED`; a reopened session reads the persisted document.
4. A native write is accepted while the external waiter is cancelled (`CANCELLED`); Worker termination plus explicit host disposal waits for the native work; the uncertain write is reconciled after reopen and found persisted.
5. A real reload replaces the document: the old ticket and the new document's unclaimed ticket are both `UNAUTHORIZED` for the old session, the generation advances, `navigationType` is `reload`, and the new document's `storage_reopen` drains the previous idle session before the data is read back.

## Not demonstrated

- Production authorization. The ticket is a bearer token, not frame identity; same-origin code in the renderer realm can use granted commands. `frame-src 'none'` narrows exposure and does not prove content isolation.
- Worker raw IPC, navigation races, failed navigation, crash, BFCache, window close and flood behaviour.
- Native lifecycle wiring: the replacement document drains the old session by itself. Nothing in Rust closes the session when the page navigates away.
- Accepted-but-pending work across document replacement, close failure, disk or flush failure.
- Binary transport. Bytes travel as JSON number arrays here; production requires raw IPC bytes, with measured throughput, memory and large-document behaviour.
- Snapshot/subscription transport, blobs, indexing, sync, awareness, telemetry, editor connection and legacy migration.
- Windows and macOS results (pending the CI stage).

## Reproduce

```sh
node tools/tauri-migration/webview-probe/storage-build.mjs
TAURI_CONFIG="$(cat tools/tauri-migration/webview-probe/tauri.storage.conf.json)" cargo build \
  --manifest-path tools/tauri-migration/webview-probe/Cargo.toml --locked --features e2e,storage-probe
PROBE_MODE=storage PROBE_OUTPUT_DIR=/tmp/storage-probe node tools/tauri-migration/webview-probe/run.mjs
```
