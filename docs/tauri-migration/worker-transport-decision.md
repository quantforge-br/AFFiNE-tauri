# Native Worker transport decision

Status: user-approved direction, not a completed desktop bridge.

The user selected **dedicated Worker + Rust broker** after the native-origin storage diagnostic. Do not replace this with a production localhost server or retain Electron/Node as a fallback.

## Evidence

On Linux WebKitGTK, a minimal embedded page at tauri://localhost can fetch JavaScript and round-trip IndexedDB. Dedicated Workers loaded from native URLs and fetched Blobs can open IndexedDB and have no native IPC. SharedWorkers can echo messages but report origin null; opening IndexedDB throws "SecurityError: IDBFactory.open() called in an invalid security context".

The AFFiNE reference web frontend already exposes a dedicated-Worker path. The architecture probe selects that path using its existing local setting; the production Tauri adapter must select it explicitly before importing the application. A disposable setting is not the implementation of a production broker.

The development-origin smoke passes all nine checks on Linux, Windows and macOS with dedicated Workers; [third CI evidence](evidence/ci-webview-probe-third.json) includes real writes/reload, binary transfer, native-command denial and independent workbench routes. The minimal native protocol diagnostics pass dedicated Worker transport/storage on all three platforms; SharedWorker storage fails on Linux/macOS and succeeds on Windows. None of these results implements cross-window coordination or full native-origin frontend packaging.

## Required implementation

- One dedicated storage/sync Worker per trusted frontend owner; Workers never receive Tauri globals or direct native privileges.
- A narrow MessageChannel broker in the trusted main WebView validates operation, owner, request ID, size, cancellation and lifecycle before calling typed Rust commands.
- Rust owns SQLite handles, authorization, per-workspace serialization and cross-window notifications. Closing a WebView must release its resources without losing committed writes or disrupting other owners.
- Preserve existing sync, indexing, awareness and telemetry semantics; sharing previously supplied by SharedWorker must be explicitly replaced and tested, not discarded.
- Revisioned bootstrap must avoid subscribe/snapshot races. Events are scoped to authorized owners and suppress feedback to the original writer.
- Unit, integration and native E2E must cover two windows, concurrency, close/reopen, cancellation, large/binary data, worker termination, offline process restart and all three platforms.

This direction does not close the architecture milestone. The previous Windows development-origin reload and Linux interaction failures are resolved at the probe level in the third CI, without deleting earlier failed evidence. Full static native-origin bootstrap, actual tab lifecycle and the production bridge remain open gates.
