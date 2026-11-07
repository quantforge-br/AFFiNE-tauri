# Private Worker storage transport

Status: **transport foundation, not a Rust session implementation, native WebView integration or desktop parity claim**.

This package has no Electron, Node or Tauri runtime imports. Its main-side binder and Worker-side client exchange versioned messages over a directly transferred private MessagePort. Node modules, esbuild and simulated sessions are test-only dependencies.

## Authority contract

A trusted host creates one TrustedStorageSession scoped to one authorized owner/space, then calls bindStoragePort(port, session). The port payload never chooses a native owner, storage handle, window, path or command name. Do not discover these ports through a global window-message listener or accept ports from remote/untrusted content.

WorkerStorageClient exposes only getDoc and pushUpdate. Its Worker entry point imports no native globals. The trusted session is intentionally an interface: no Rust/Tauri binding is provided, and no editor storage implementation is switched by this package.

Exact schemas reject unknown fields, malformed operations, reused/decreasing IDs, unexpected transferred ports, invalid document identities and unsafe errors. Response buffers and request updates are copied before transfer so caller/cache buffers are not detached; this also handles Node Buffer subclasses in tests. SharedArrayBuffer-backed updates are rejected. Unknown internal errors become STORAGE rather than leaking SQL, paths or secrets.

## Lifecycle and cancellation

Keep the binding object and await host.dispose() when its trusted owner is revoked, navigates, reloads, closes, or its Worker terminates. Browser MessagePort has no portable peer-closure notification that reliably revokes authority. WorkerStorageClient.dispose() sends a close message but cannot replace native lifecycle enforcement.

Disposal is idempotent, aborts active signals, closes the port, and calls session.close() exactly once. Its Promise preserves close failures for the trusted caller; peer-initiated close suppresses unhandled Promise rejection, not the underlying failure. A production host must observe disposal and report/recover native close failures. The session's close/revocation implementation must serialize behind already accepted native work and drain it; the transport does not implement this native guarantee.

Cancellation and the default 30-second timeout reject local delivery, not an accepted commit. Host accounting remains charged until the underlying session Promise settles, even if its signal was aborted. Do not interpret CANCELLED as rollback or blindly retry uncertain writes. A future snapshot/event protocol must reconcile uncertain completion before editor adoption.

## Resource controls and unfinished gates

Per port: 64 accepted operations, 64 MiB retained update backing buffers, 16 MiB per update/backing buffer or returned document, and 2048 UTF-8 bytes per non-control document identifier. The client timeout configuration accepts 1–300,000 ms. Request IDs are positive monotonically increasing safe integers and are never reused.

These controls are **not approved product-size reductions** or total memory/CPU bounds. Structured-clone deserialization and browser message queues occur before JavaScript validation. Global owner/port budgets, read/response budgets, renderer/native serialization costs, stored growth, chunking/pagination, large-document compatibility and native backpressure remain gates before renderer exposure. Arbitrarily flooding the underlying port is not made safe by limiting accepted session calls.

Not implemented: snapshot/subscription/revision streams, blobs, indexing/search, sync/awareness/telemetry, full StoreManager semantics, trusted main-frame ownership, native command capabilities, navigation isolation and the Rust session binding. No successful no-op stands in for these operations.

## Verification

From the repository root after the immutable Yarn install:

    node node_modules/typescript/bin/tsc6 --version
    node node_modules/typescript/bin/tsc6 -p packages/frontend/tauri-bridge/tsconfig.json --pretty false
    node node_modules/oxlint/bin/oxlint --deny-warnings packages/frontend/tauri-bridge
    node node_modules/oxfmt/bin/oxfmt --check packages/frontend/tauri-bridge

From packages/frontend/tauri-bridge:

    node ../../../node_modules/vitest/vitest.mjs run

The repository aliases TypeScript 6 through @typescript/typescript6. Use its real tsc6 entry rather than assuming the generic tsc shim runs that compiler. The installed compiler version is recorded separately from the alias wrapper's package version.

The suite has 27 real MessageChannel transport cases and one real Node Worker case. Session methods are deliberate test doubles throughout. The Node Worker case executes the unchanged production client in another thread, transfers all byte values and explicitly disposes the host after termination. It does **not** prove browser Worker privilege isolation, Tauri permissions, Rust persistence or native WebView behavior. tauri-bridge.yml runs this transport suite separately from the Rust and native WebView workflows; a configured CI matrix is not passing evidence.
