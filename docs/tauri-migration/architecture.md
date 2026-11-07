# Tauri desktop architecture proposal

Status: **provisional**. All three native WebViews pass the development editor smoke, native-origin protocol/storage diagnostic and ten-check embedded static frontend smoke under enforced CSP in [CI run 42387377066](evidence/ci-webview-probe-fifth.json). The page-script negative test receives EvalError on Linux, Windows and macOS without weakening CSP. See [lottie-csp.md](lottie-csp.md). Production broker/native integrations, cloud/media/embed policy and the full workbench lifecycle still gate architecture acceptance.

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

The immutable ipc-inventory.json provides 153 command and 24 event requirements. It is an audit inventory, not an allow-all dispatcher. Each production Rust command must have a typed request/response, explicit error type, payload bounds and authorization tied to the calling WebView. Owner-scoped resources include windows, workbenches, import sessions, worker ports, recording jobs and file grants. The [IPC mapping](ipc-mapping.md) assigns each of the 31 inventory groups (30 namespace records plus the preload import wrapper), and every method through groups where a namespace spans several concerns, a proposed Tauri/Rust boundary, caller class, parity items and platform notes; tools/tauri-migration/ipc-mapping.test.mjs fails if a record, a method or a parity item has no destination. It is a design mapping, not an implementation or verification claim.

Use tauri-build AppManifest command registration and explicit capabilities; app commands otherwise default to broad availability. Capabilities enumerate trusted labels and specific operations, without remote origins or unrestricted shell/filesystem permissions. Register windows only from Rust. Rejected/missing operations must return explicit errors, never successful no-ops or canned data.

Use targeted events for view-owned changes; subscriptions must register before snapshots, use monotonic revisions and deduplicate source echoes. Binary document/blob data must round-trip losslessly. Use bounded IPC payloads or binary channels where appropriate, and test serialization/ownership/error propagation. No refresh token or raw BYOK secret should be broadcast to frontend listeners.

An isolated debug-only [document-authority diagnostic](native-authority-probe.md) passes its ping/ACL/forged-ticket/reload checks on Linux ([source-hashed evidence](evidence/linux-native-authority.json)) and on Linux, Windows and macOS hosted runners ([run 42397826185](evidence/ci-native-authority-second.json)). It is not a production ownership design: same-origin code can access the parent realm, Worker raw IPC is not tested, Linux load-start timing is actually document commit, and navigation/drain/crash/close races remain open. This diagnostic itself introduces no storage commands or production editor permissions. On Windows, subframes receive the native bootstrap and cross-origin or opaque frames are denied by the ACL or origin check; on Linux/macOS they simply lack the bootstrap.

## Window and workbench model

Native window decorations are always disabled per window-decoration-policy.md. The existing tabs/header/editor remain, with accessible in-app controls, drag regions and resize behavior. Close-to-tray semantics stay centralized in Rust. No decoration autohide timer or hover reveal is desired.

Do not base the production design blindly on Tauri add_child: the currently inspected API requires the unstable feature. Prefer rendering the shell, tabs and workbench view panels in a single primary WebView using the existing React workbench/view model; maintain a Rust-authoritative tab metadata model and frontend view lifecycle adapter. Validate background tab state, independent routing, memory usage, drag/drop and split views before accepting this strategy. If source compatibility/performance requires multiple native child WebViews, raise the stable-API constraint and alternatives with the user before adopting an experimental API.

Popups and onboarding/theme-editor windows can be separate explicitly registered Tauri WebviewWindows with narrower capability sets. Ordinary remote embeds must never become privileged app windows.

## Workers and local services

A trusted UI bridge brokers Web Worker requests to Rust. Ordinary Web Workers do not receive the Tauri bootstrap; absence of globals alone is not proof against constructed raw IPC traffic. Shared storage/nbstore workers must survive tab switches, report errors and dispose ports/tasks safely. Preserve StoreManager/CRDT operation semantics; native SQLite must not become IndexedDB as a final fallback.

The Rust storage pool uses the existing v2 schema/migrations and native indexer. The standalone use-as-lib path now uses owned Vec<u8> and optional N-API dependencies, with a dependency audit proving no N-API crates in the standalone/mobile graphs. Linux checks cover 31 library tests, a byte/CRDT SQLite reopen integration test, 33 binding-mode tests, eight mobile tests and the 122-test Electron reference suite after rebuilding its actual binding. See evidence/linux-rust-storage.json. Explicit wire DTOs, host authorization, cold-process restart and production migration tests remain prerequisites for Tauri integration.

A host-owned storage foundation now exists at packages/frontend/tauri-core. It adds non-deserializable host owners, scoped leases, shared-space serialization, native exclusive root locking, bounded CRDT validation, cancellation-safe accepted writes and revisioned snapshot/event streams. Linux passes four unit tests and eighteen integration harness cases, including separate-process reopen and root-lock denial; see [evidence/linux-tauri-core.json](evidence/linux-tauri-core.json) and the crate README for limits. This library has no Tauri commands or frontend adapter. Read/merge resources, Windows path policy, legacy migration and the full nbstore API still gate renderer exposure.

The complete native library workflow passes on Linux x86_64, Windows x86_64 and macOS ARM64 in [run 42391980349](evidence/ci-tauri-core-third.json), including the canonical-path and immediate-file-cleanup regressions. Earlier Windows failures remain recorded. This resolves those library compatibility blockers, not Windows filesystem hardening, native IPC/main-frame isolation, full storage semantics or production application acceptance.

A Rust-only StorageSession now fixes one host-granted space/owner/lease, retains admission until accepted reads/writes finish, and shares an idempotent close result after draining and owner revocation. The eight session unit cases and three SQLite integration cases pass on Linux, Windows and macOS runners; see evidence/ci-tauri-session.json and evidence/linux-tauri-session.json. This is not the TypeScript TrustedStorageSession binding or a Tauri command surface. Native calling-context enforcement, output/read budgets, snapshot transport, runtime shutdown and full application lifecycle remain gates.
A separate private-port transport foundation now exists at packages/frontend/tauri-bridge. A trusted, pre-scoped session supplies getDoc/pushUpdate; messages cannot select owner, handle, window or path. Its 28 Linux tests use real MessageChannels and one Node Worker but deliberately simulated sessions, not Rust persistence. Cancellation accounting, binary ownership, malformed messages and explicit disposal are covered; see [evidence/linux-tauri-bridge.json](evidence/linux-tauri-bridge.json). Native ownership/capabilities, main-frame isolation, session binding, browser Worker execution, snapshot/events and full storage semantics remain required before editor adoption.

The transport-only suite also passes all 28 cases, real TypeScript checking, lint, formatting and immutable installation on Linux x86_64, Windows x86_64 and macOS ARM64 in [run 42392848133](evidence/ci-tauri-bridge-first.json). Its sessions remain simulated on every platform; native/browser integration remains unverified.
A disposable [native storage diagnostic](native-storage-probe.md) now runs a real dedicated Worker, the production bridge client over a private port, Tauri IPC, a Rust `StorageSession` and SQLite inside the Linux native WebView, including a real reload that replaces the document. It passes 18 checks on Linux with empty CSP violations, raw binary IPC bodies and an 8 MiB document checked after a real reload ([evidence](evidence/linux-native-storage.json)). It is a fixed-space fixture with explicit document-driven session replacement; Rust lifecycle hooks, Worker raw-IPC and same-origin isolation, production read/queue budgets, snapshots, and the Windows result for this version remain open.

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

The standalone probe is not part of production packaging. All three native WebViews pass document creation, real text input, edgeless, completed writes, reload persistence, required web APIs, binary Worker transfer, denied native commands and independent workbench routes. Minimal native-origin dedicated Worker/IndexedDB diagnostics also pass on each platform. These are not cold process restart, native storage-host integration, authentication, custom controls, tab lifecycle or installable-package evidence. See evidence/ci-webview-probe-third.json; earlier failed runs remain recorded.

Sources consulted: https://v2.tauri.app/concept/architecture/ ; https://v2.tauri.app/security/capabilities/ ; https://v2.tauri.app/develop/tests/webdriver/ . Exact local Tauri 2.11.5 source was inspected for add_child, navigation policy and decoration state APIs.
