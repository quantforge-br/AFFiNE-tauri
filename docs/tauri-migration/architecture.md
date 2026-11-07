# Tauri desktop architecture proposal

Status: **provisional**. Linux editor feasibility is verified in linux-probe-results.md. Windows/macOS engine and native-integration checks are still required before this architecture milestone can be closed.

## Runtime model

Use Tauri 2 and Rust services; do not ship Electron, Node, an Electron sidecar or the e2e automation plugin. Keep the existing React/BlockSuite UI, assets, SQL migrations and CRDT encodings. Preserve the legacy Electron target until the replacement satisfies the parity matrix; shared web/mobile targets must continue to work.

The desktop host owns application lifecycle, persisted window/tab metadata, storage pools, file grants, authentication/session refresh, system integration and update verification. The frontend owns rendering and editor state and talks through explicit typed commands/events, not arbitrary namespace dispatch or a dynamically permissive proxy.

## Boundaries and file layout

- A production app target will live at packages/frontend/apps/tauri, with a Rust host and a TypeScript bootstrap/bridge.
- Introduce a runtime-neutral desktop API contract independently from Electron implementation imports. Retain compatibility aliases temporarily so existing UI code does not need a simultaneous rewrite. Type-only imports alone are not permission checks.
- Rust storage functionality should live in reusable core crates. Remove N-API from the library feature path before using storage DTOs across IPC; keep existing Node bindings supported with their own feature/tests.
- Preserve the repository's Rspack/Vanilla Extract bundling. Add a Tauri build flag rather than making BUILD_CONFIG.isElectron falsely true for the new runtime. Replace desktop-behavior checks with a native-desktop predicate and retain genuine Electron-only checks.
- Hydrate shared state and establish event subscriptions before dynamically importing existing renderer entries. This replaces synchronous preload IPC without first-load races.

## Commands, events and authorization

The immutable ipc-inventory.json provides 153 command and 24 event requirements. It is an audit inventory, not an allow-all dispatcher. Each production Rust command must have a typed request/response, explicit error type, payload bounds and authorization tied to the calling WebView. Owner-scoped resources include windows, workbenches, import sessions, worker ports, recording jobs and file grants.

Use tauri-build AppManifest command registration and explicit capabilities; app commands otherwise default to broad availability. Capabilities enumerate trusted labels and specific operations, without remote origins or unrestricted shell/filesystem permissions. Register windows only from Rust. Rejected/missing operations must return explicit errors, never successful no-ops or canned data.

Use targeted events for view-owned changes; subscriptions must register before snapshots, use monotonic revisions and deduplicate source echoes. Binary document/blob data must round-trip losslessly. Use bounded IPC payloads or binary channels where appropriate, and test serialization/ownership/error propagation. No refresh token or raw BYOK secret should be broadcast to frontend listeners.

## Window and workbench model

Native window decorations are always disabled per window-decoration-policy.md. The existing tabs/header/editor remain, with accessible in-app controls, drag regions and resize behavior. Close-to-tray semantics stay centralized in Rust. No decoration autohide timer or hover reveal is desired.

Do not base the production design blindly on Tauri add_child: the currently inspected API requires the unstable feature. Prefer rendering the shell, tabs and workbench view panels in a single primary WebView using the existing React workbench/view model; maintain a Rust-authoritative tab metadata model and frontend view lifecycle adapter. Validate background tab state, independent routing, memory usage, drag/drop and split views before accepting this strategy. If source compatibility/performance requires multiple native child WebViews, raise the stable-API constraint and alternatives with the user before adopting an experimental API.

Popups and onboarding/theme-editor windows can be separate explicitly registered Tauri WebviewWindows with narrower capability sets. Ordinary remote embeds must never become privileged app windows.

## Workers and local services

A trusted UI bridge brokers Web Worker requests to Rust. Ordinary Web Workers do not have Tauri IPC access. Shared storage/nbstore workers must survive tab switches, report errors and dispose ports/tasks safely. Preserve the existing StoreManager/CRDT operation semantics; do not replace native SQLite with IndexedDB as a final fallback.

The Rust storage pool uses the existing v2 schema/migrations and native indexer. Source review and standalone Rust tests show reuse is feasible, but use-as-lib still exposes napi Uint8Array and unconditionally enables affine_common/napi. Clean feature isolation and explicit wire DTOs are prerequisites for production integration.

Workspace data belongs in a new app-owned location by default. Import from the reference only after consistent backup and validation, including WAL/SHM handling and restart/interruption recovery. Never write to the original profile merely because an app ID matches.

## Network, authentication and remote content

Retain cloud APIs; Rust handles native auth token refresh, encrypted-at-rest/session-only policy, endpoint-origin normalization and bounded/retriable requests. Frontend requests must target the configured server; never attach credentials to arbitrary URLs, redirects, embeds or proxies. Self-hosted endpoints remain supported according to existing security policy.

Tauri uses different custom-protocol origins on Linux/macOS and Windows. Verify CORS, WebSocket upgrades, SPA routes, local blob/fonts/assets and authenticated downloads on each OS. A dev localhost server is a probe, not production asset packaging.

Remote iframe isolation is a high-risk item: Tauri docs warn that Linux cannot distinguish iframe requests from their parent in some IPC access paths. Do not grant remote native access. Test actual hostile-frame attempts; use explicit main-frame isolation and scoped broker design rather than relying solely on window labels. CSP must permit required document media while blocking executable/native privilege escalation.

## Native integration replacement map

| Reference area                    | Proposed Rust/Tauri boundary                                                                                   | Acceptance gate                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Window/menu/tray/popup            | Stable Tauri window/menu/tray APIs + Rust state + narrow frontend controls                                     | Native UI tests and tab ownership on each OS                                       |
| File import/export/folder sync    | Native dialogs create opaque grants; Rust schema checks, import sessions, SQLite and existing disk_sync engine | Traversal/symlink/race/error tests plus real file round-trips                      |
| Clipboard/capture/find/spellcheck | Tauri clipboard facilities and narrowly audited OS/WebView adapters                                            | Actual formats, render capture and search semantics; no stubs                      |
| Auth/BYOK                         | Existing token broker semantics ported to Rust; OS keychain + memory-only fallback                             | Authorized test endpoint, refresh races, encryption and origin-isolation checks    |
| Preview/hashcash                  | Reusable affine_preview/affine_common services without N-API                                                   | Native output and invalid-input tests                                              |
| Meetings/recording                | Existing media-capture Rust adapted behind OS services + job coordinator                                       | Real Windows/macOS capture and permission flows; Linux unavailable as in reference |
| Power/language/settings/logs      | OS adapters + revisioned persisted state/events, sanitized diagnostics                                         | Initial state, changes, persistence and subscription cleanup                       |
| Updates/packages                  | Tauri package generation and signed test feed for fork artifacts                                               | Real install/update with data retention on all OS; no upstream Electron artifacts  |

## Verification and risks

Follow parity-matrix.md and record OS/architecture/revision/commands/results; source mapping and mocks alone never close a requirement. Separate pure Rust/unit tests from actual WebView/native E2E. Keep all automation behind test features and loopback authentication.

The current standalone probe is not part of production packaging. Linux smoke passes creation, character input, edgeless switching and persistence after reload. 31 native storage Rust tests pass. Windows/macOS execution, custom controls, restart/backup and authenticated cloud integration still need evidence. If machines, certificates or accounts are missing, preserve progress and ask rather than weakening scope.

Sources consulted: https://v2.tauri.app/concept/architecture/ ; https://v2.tauri.app/security/capabilities/ ; https://v2.tauri.app/develop/tests/webdriver/ . Exact local Tauri 2.11.5 source was inspected for add_child, navigation policy and decoration state APIs.
