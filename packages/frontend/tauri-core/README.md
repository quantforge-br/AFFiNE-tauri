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

The first native CI run 42389199337 passed Linux/macOS but failed Windows while opening canonical database paths. The failed evidence is retained in docs/tauri-migration/evidence/ci-tauri-core-first.json. A regression fixture reproduces URL parsing of literal path characters; the candidate fix opens/creates through the existing filename-configured pool instead of migration URL helpers. A fresh Windows run is required before claiming cross-platform core acceptance.

The child process test is not an application restart, power-loss guarantee, legacy migration/backup/recovery test or editor integration acceptance. Missing APIs include blobs, delete/compaction, search/indexing, sync clocks/awareness/telemetry and the existing StoreManager contract. A trusted MessageChannel bridge, explicit Tauri command capabilities, main-frame isolation, remote-content denial and native lifecycle E2E remain prerequisites. No inventory/parity item is closed by this library alone.
