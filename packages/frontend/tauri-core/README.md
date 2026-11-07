# Host-owned Tauri storage core

Status: **library foundation, not a production IPC surface or desktop parity claim**.

This crate reuses affine_nbstore's real SQLite migrations and Yjs Update V1 encodings without N-API, Node, Electron, a WebView or Tauri command registration. It is deliberately not connected to the editor yet. No Electron profile is opened or migrated.

## Authority and lifecycle

The trusted native host creates one StorageBroker with an app-private directory and registers OwnerId values from its own window lifecycle. OwnerId cannot be deserialized. Never accept an owner, arbitrary window label, private root or database path from a renderer. A renderer may eventually receive only an opaque StorageHandle, checked together with the host-derived owner on every operation.

Owners receive explicit SpaceKey grants (peer, workspace/userspace type, identifier). Filenames are length-delimited SHA-256 hashes of those three fields. Owners sharing a space share one SQLite connection authority, but have independent leases; closing one does not invalidate other owners. The last lease closes the connection. Revoking an owner wakes its blocked subscriptions and denies further operations. Active operations hold the lifecycle read lock; revocation waits for them before returning.

The broker holds a native exclusive .host.lock for its lifetime. A second broker or cooperating process using the same root receives STORAGE_IN_USE; it must not construct an independent revision/event authority over that database. The lock file is not deleted on shutdown, avoiding lock-inode replacement by a later instance. Normal OS process termination releases the lock. This is not protection against another same-user process that ignores advisory locks or replaces files.

A new root uses Unix mode 0700; existing Unix roots with group/other permission bits are rejected. Root, database, SQLite sidecar and lock paths reject preexisting symlinks/special files. The host must supply trusted ancestors and prevent file replacement. These path checks are **not** descriptor-relative, race-proof filesystem confinement. Windows ACL/reparse/hardlink policy and hostile same-user filesystem races remain integration gates. Never point this API at a user-selected directory or an existing Electron profile.

## Operations and wire data

- register_owner: host-only explicit grants.
- open: authorized, owner-scoped opaque lease.
- get_doc: real merged document bytes with a millisecond clock; underlying incomplete-document/storage errors are sanitized.
- push_update: bounded, validated Update V1 persistence and event publication under the space mutation lock.
- snapshot: document clocks and a subscription created under the same mutation lock, with no fetch/subscribe gap.
- close / revoke_owner: explicit lifetime cleanup preserving other owners.
- Subscription::recv: rechecks authority, suppresses its source-handle echoes and returns RESYNC_REQUIRED on lag. A failed stream stays failed; obtain a new snapshot instead of continuing from a gap.

Events contain revision, docId and timestampMs, not another owner's lease. Byte DTOs use Vec<u8>; a future bridge must verify lossless binary transport. Serialized errors are fixed codes and do not contain paths, SQL, secrets or raw internal errors. Revisions are in-memory per open space, not persisted global clocks. Do not compare them across close/reopen or restart.

An accepted write runs in its own task: cancelling the awaiting caller does not cancel a commit or its event publication. Cancellation is not rollback. Reconcile from snapshot after uncertain completion; do not blindly retry non-idempotent operations. Runtime/process termination can interrupt an operation, so the production host still needs a drain/shutdown protocol and recovery tests. A write queued behind revocation can be denied before execution. No success is returned for rejected input.

## Fixed-scope host sessions

StorageSession is a Rust-only foundation for a future TrustedStorageSession binding. Its constructor receives a trusted SpaceKey, creates its own owner and lease, and exposes only get_doc, push_update and close. Call payloads cannot select owner, handle, path, window or another space. It has no Tauri/WebView/Node dependency or command registration; the TypeScript bridge still has no native binding.

The first polled operation admits work under the same synchronous gate as closing, reserves one of 64 per-session call slots and, for updates, a 64 MiB queued-byte budget in 64 KiB units. Accepted work runs independently of its caller, retaining admission until the actual broker result. Cancelling a waiter does not roll back a write or release its capacity. Reads are also drained, but their merged output size/CPU and native serialization are not yet bounded.

The first polled close stops admission, waits for all accepted calls, then revokes only the session's dedicated owner. Concurrent and repeated close waiters receive the same stored result; cancelling a waiter does not cancel cleanup. A task join failure reports TASK. A real host-side external revocation produces a stable UNAUTHORIZED close failure; the tests do not simulate a SQLite I/O close error. The lower-level SQLite close API returns no error result, so this wrapper does not prove detection of every disk/flush failure.

Construction is detached from its awaiting caller so an abandoned successful result can trigger cleanup. Dropping the final session reference starts best-effort asynchronous close. Neither is a substitute for the host explicitly awaiting close while the runtime remains alive. Runtime/process termination, leaked references, stuck native operations, host navigation/reload/close wiring and aggregate session/response budgets remain production gates. The session supplies no snapshot/subscription API yet. A successful close and same-process root reopen is library evidence, not application restart or migration acceptance.

Linux verification now covers eight new deterministic session unit cases and three real-SQLite public API integration cases, alongside the prior four core unit and eighteen storage integration harness cases. Accepted-work draining is exercised on a two-thread runtime without sleeps; tests cover cancelled callers/close waiters, capacity retention/recovery, idempotent close, visible close failure, abandoned construction/drop cleanup, shared-owner preservation, malformed input and immediate root cleanup after reopen. The same session suite passes on Linux x86_64, Windows x86_64 and macOS ARM64 hosted runners (33, 31 and 33 core harness cases; Windows omits two Unix-specific cases; 35 standalone tests each), see docs/tauri-migration/evidence/ci-tauri-session.json and linux-tauri-session.json.

## Resource controls and remaining limits

Current library guards: 128 owners, 128 grants and leases per owner, 256 open spaces, 2048-byte non-control identifiers, 16 MiB per update, 64 in-flight writes, 64 MiB of queued update bytes (rounded to 64 KiB permits), 128 buffered events per space. These are backpressure/security controls, **not** approved reductions of reference document sizes or capabilities. A production transport needs chunking/reconciliation and representative large-document evidence before adoption.

Update validation uses y-octo ReadDoc's bounded wire scanner on a blocking worker: 250,000 structs, 10,000 clients, 1,000,000 collection entries, depth 64 and 16 MiB content/input. IncompleteSnapshot is accepted only after successful bounded wire scanning, preserving valid out-of-order incremental updates; malformed/trailing input and resource-limit errors are rejected before persistence. This avoids unrestricted Update::decode_v1 on untrusted input. It still builds a read projection and copies bytes, so the 64 MiB queue budget is **not** a total process-memory bound.

The current get_doc merge, total stored document/update growth, clock snapshot size, reads, subscriptions and renderer-side deserialization do not yet have complete resource accounting or pagination. Read/merge CPU work and large-document compatibility need review before renderer exposure. Existing SQLite behavior is reused, not claimed to be sandboxed merely by wrapping it.

## Verification

From the repository root, with its pinned Rust toolchain:

    cargo test -p affine_tauri_core --locked
    cargo clippy -p affine_tauri_core --all-targets --locked --no-deps -- -D warnings
    cargo fmt -p affine_tauri_core -- --check
    cargo tree -p affine_tauri_core --locked --edges normal,build --prefix none --format '{p}'

The normal/build graph must not include napi, napi-derive or napi-build. Selecting legacy Node packages in the same Cargo invocation can intentionally unify their N-API feature; audit this crate separately.

Linux currently passes four cancellation/budget unit tests and eighteen integration harness cases (one is the child-process fixture entry). Coverage includes real SQLite/UTF-8 CRDT roundtrips, owner/lease bounds and isolation, concurrent writes to one document, revision/event ordering, gap-free snapshots, source suppression, terminal lag, malformed/hostile inputs, private paths, and a separate-process reopen after exit without graceful cleanup. Unix-only path/permission tests do not run on Windows. The three-platform tauri-core.yml workflow records actual native test results separately; a configured matrix alone does not prove they pass.

The first native CI run 42389199337 failed Windows opening canonical database paths; run 42390321070 fixed opening but failed three immediate file-deletion assertions. Both failures remain in docs/tauri-migration/evidence/ci-tauri-core-{first,second}.json. After awaited complete pool draining, including temporary query-error paths and the deterministic SQLx return/close race regression, run 42391980349 passes every required job on Linux x86_64, Windows x86_64 and macOS ARM64. See ci-tauri-core-third.json. Each runner passes 33 standalone unit tests and 2 standalone integration tests, strict core Clippy and the no-N-API audit. Core tests pass 4 unit + 18 integration harness cases on Linux/macOS and 4 + 16 on Windows (two Unix-only cases). No assertions were waived. This is cross-platform library execution, not native IPC/editor integration or application acceptance.

The child process test is not an application restart, power-loss guarantee, legacy migration/backup/recovery test or editor integration acceptance. Missing APIs include blobs, delete/compaction, search/indexing, sync clocks/awareness/telemetry and the existing StoreManager contract. A trusted MessageChannel bridge, explicit Tauri command capabilities, main-frame isolation, remote-content denial and native lifecycle E2E remain prerequisites. No inventory/parity item is closed by this library alone.
