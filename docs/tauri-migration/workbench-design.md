# Workbench and tabs: stable-WebView design experiment

Status: provisional. The existing split-view renderer can mount independent routes in one native Linux WebView. This is not desktop tab parity.

## Existing responsibilities

- `entities/workbench.ts` owns view order, active view, open/close and per-view sizes.
- `entities/view.ts` owns a memory-history stack, view scope, sidebar tabs and scroll/edgeless viewport positions.
- `view/view-root.tsx` mounts a memory router and framework scope per view.
- `view/split-view/split-view.tsx` intentionally keeps mounting order stable while changing visual order, avoiding BlockSuite/Lit remount defects.
- `services/desktop-state-synchronizer.ts` connects a workbench to one Electron view ID and forwards metadata/close/navigation events to the native process.
- `app-tabs-header/services/app-tabs-header-service.ts` manages tabs through native APIs. Its initial fetch-then-subscribe ordering must not be copied into the revisioned Tauri bootstrap, since it can lose updates.

## Candidate Tauri ownership

One primary native WebView renders the existing shell/tab header plus a tab-host component. Each tab owns a workbench scope; each workbench retains the existing split panels and view routers. Rust owns the authoritative window/tab metadata and lifecycle, never the React DOM or editor model.

Inactive tab trees must remain mounted, with focus/input ownership and expensive effects explicitly suspended. Hiding a tree is not sufficient proof that Workers, media or selection behave correctly. No iframe-based privileged tab host or unstable `add_child` API is accepted by this experiment.

Implement the Tauri desktop predicate separately from `isElectron`. Replace desktop behavior checks only where appropriate; preserve genuine Electron dependencies in their legacy target. The browser new-tab handler calls `window.open`, so it is not the final desktop adapter. The browser router also treats global history as authoritative; it must not overwrite per-tab history on activation.

## Evidence and open gates

The Linux smoke creates a secondary panel through the existing public workbench API, changes that panel’s route, checks the first route is unchanged and its edgeless host stays connected, then closes the secondary panel. The test is an architecture-level API exercise, not a user gesture/tab/drag-drop acceptance test.

Still required before consolidating the model:

- Actual tab creation, switching, closing, pinning, ordering and drag-out windows.
- Workspace isolation and per-tab histories through activation/back/forward.
- Editor content, selection, undo/redo, viewport and background-task retention.
- Split-view focus, resizing/reordering without remounts, sidebar/peek lifecycle.
- Rust-authoritative recovery after reload/process restart; revision conflicts and event ordering.
- Keyboard/IME/accessibility, memory/performance and all three native engines.
- Undecorated-window controls, drag regions and tray/close safeguards.

If the single-WebView model fails these gates, preserve the failing evidence and discuss stable alternatives rather than silently removing functionality.
