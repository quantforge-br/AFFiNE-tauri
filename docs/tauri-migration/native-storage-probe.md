# Native storage diagnostic (disposable)

This diagnostic exercises one real path inside a native WebView: **dedicated Worker → private MessagePort → production `@affine/tauri-bridge` → Tauri IPC → Rust `StorageSession` → real SQLite**. It is a disposable architecture probe. It is not the production command boundary, not editor integration and not evidence of desktop parity.

## Scope and gates

- Mode `storage-probe` implies `authority-probe`, requires the `e2e` feature (compile error otherwise) and is debug-only through the authority guards.
- The storage root is `tauri_wd::automation_profile_dir()/rust-storage`. Ordinary launches have no such profile and cannot open the fixture.
- One fixed space (`disposable-probe` / workspace / `fixed-fixture`). Read and write travel as raw binary IPC bodies whose only application header is the per-document ticket; any other `x-affine-*` header, a JSON body or a repeated ticket is rejected. Close and reopen use `deny_unknown_fields` ticket requests. None can carry owner, path, handle, window label, peer or space.
- Commands `storage_read`, `storage_write`, `storage_close` and `storage_reopen` are granted to the local `probe` WebView only. Each calls `authority::authorize`, which derives the WebView label and complete current URL natively and validates the per-document ticket, a bearer token that stays valid until the document is replaced. The trusted document in this mode is `/storage.html`.
- Application CSP: `script-src 'self'`, `worker-src 'self'`, `frame-src 'none'`, no `unsafe-eval`, no inline script or style. The bundle is a classic deferred IIFE script; a module script raced the native ticket evaluation (see failed attempts in the evidence).
- The fixture lives in `packages/frontend/tauri-bridge/test/native-fixture/` and reuses the production `bindStoragePort` and `WorkerStorageClient` unchanged. The native-side `TrustedStorageSession` is a fixture that maps the four commands and awaits all pending native invokes before `storage_close`.

## What the Linux run demonstrates

Nineteen checks pass with empty CSP violations and no Tauri IPC fallback warning (see `evidence/linux-native-storage.json`):

1. The native document ticket reaches only the main document; a forged ticket, injected authority fields and an ungranted registered command are denied.
2. A real Worker with no Tauri bootstrap globals round-trips a Unicode Yjs document and a 256-byte payload through the private port into SQLite; malformed CRDT input is rejected and leaves the stored document intact.
3. Awaited disposal closes the native session; a later request returns `CLOSED`; a reopened session reads the persisted document.
4. A native write is accepted while the external waiter is cancelled (`CANCELLED`); Worker termination plus explicit host disposal waits for the native work; the uncertain write is reconciled after reopen and found persisted.
5. An 8 MiB Yjs document (all byte values, Unicode identifier) round-trips through the Worker, private port, raw IPC and SQLite and is verified byte-for-byte again after a real reload; a 16 MiB + 1 byte frame sent directly to the command, bypassing the bridge, is rejected with `INVALID_INPUT` and leaves storage unchanged.
6. A dedicated Worker that was deliberately given the real ticket, as if it had leaked, builds ten raw IPC requests by hand (no credentials, no invoke key, six guessed invoke keys, a JSON ping, the ungranted command). None succeeds, the native ping counter shows that none reached a command, and the document it tried to write does not exist afterwards. Tauri answers a missing invoke key with a 500 and answers a wrong key with nothing at all, so those fetches stay pending until the fixture timeout.
7. A real reload replaces the document: the old ticket and the new document's unclaimed ticket are both `UNAUTHORIZED` for the old session, the generation advances, `navigationType` is `reload`, and the new document's `storage_reopen` drains the previous idle session before the data is read back.

## Not demonstrated

- Production authorization. The ticket is a bearer token, not frame identity; same-origin code in the renderer realm can use granted commands. `frame-src 'none'` narrows exposure and does not prove content isolation.
- A Worker that obtains the invoke key, same-origin frames and service workers (the Worker attack covers only hand-built requests without the key), navigation races, failed navigation, crash, BFCache, window close and flood behaviour.
- Native lifecycle wiring: the replacement document drains the old session by itself. Nothing in Rust closes the session when the page navigates away.
- Accepted-but-pending work across document replacement, close failure, disk or flush failure.
- Production resource budgets. The native write path copies the body once more, the 16 MiB bound is enforced by the core after the whole body is received, and browser structured-clone allocation, aggregate queues and read-side budgets are not measured. One 8 MiB document does not establish large-document compatibility.
- Snapshot/subscription transport, blobs, indexing, sync, awareness, telemetry, editor connection and legacy migration.
- Windows and macOS results for this exact version. The first CI run of the earlier JSON-array variant passed on macOS, and its Windows job failed earlier in the authority collector (see the evidence); a later run is required.

## Findings that production must act on

- The ACL does not stop a Worker. Its Origin is the local document origin, so the WebView label and URL checks pass. The invoke key (held by the page-side Tauri script) and the document ticket are the only barriers, and the ticket is just a bearer token.
- On every invoke-key mismatch Tauri 2.11.5 prints the expected per-process key to standard error. The renderer cannot read it. Production must not collect standard error into logs, diagnostics, reports or uploads that a user or the renderer could expose, and the logging design must treat that stream as secret.
- A request with a wrong key is never answered. A hostile same-origin Worker can leave many such fetches pending; that is a renderer resource concern to bound, not an authorization bypass.

## Reproduce

```sh
node tools/tauri-migration/webview-probe/storage-build.mjs
TAURI_CONFIG="$(cat tools/tauri-migration/webview-probe/tauri.storage.conf.json)" cargo build \
  --manifest-path tools/tauri-migration/webview-probe/Cargo.toml --locked --features e2e,storage-probe
PROBE_MODE=storage PROBE_OUTPUT_DIR=/tmp/storage-probe node tools/tauri-migration/webview-probe/run.mjs
```
