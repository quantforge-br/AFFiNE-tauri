# Native document-authority diagnostic

Status: isolated compatibility evidence on Linux x86_64, Windows x86_64 and macOS ARM64 ([run 42397826185](evidence/ci-native-authority-second.json), after the failed [first run](evidence/ci-native-authority-first.json)). Windows differs: subframes receive the native bootstrap, so cross-origin and opaque frames are actually denied by the ACL or origin check, while Linux/macOS frames merely lack the bootstrap. No production storage surface is authorized by these results.

## Mechanism

A WebView label and renderer-supplied owner are not authenticated calling-frame identity. Tauri 2.11.5 and locked Wry 0.55.1 document that Windows initialization scripts also enter subframes. The diagnostic combines a local-only capability, a host-derived WebView label/URL and a random per-document ticket delivered by native main-WebView evaluation after the trusted page finishes loading. Delivery checks the complete URL and top-level context. The page deletes its callback and retains the ticket in a closure. Rust accepts only ticket/challenge, never owner/path/handle/window authority.

The debug-only feature cannot be combined with editor/protocol modes and registers only authority_ping and intentionally ungranted authority_forbidden. No storage, filesystem, Node, shell or production frontend is connected. Normal and embedded editor modes remain commandless with empty capabilities. The loopback server serves only two adversarial fixture files, not the frontend.

## Required observations

- The exact bundled main document can ping with generation/sequence/challenge verification.
- Forged tickets and four extra authority fields fail. An ungranted command and a second local WebView fail ACL authorization.
- A same-origin frame actually executes and accesses the parent realm; its forged ticket fails. This is forged-ticket denial, not frame isolation.
- Cross-origin and opaque sandbox frames actually execute, report their expected postMessage origins and cannot access the parent DOM or ticket callback.
- A dedicated Worker has no Tauri bootstrap globals or ticket callback.
- A real reload changes performance.timeOrigin, advances the native generation and rejects the previous ticket. Rejected calls do not increase native accepted-call count.
- Remote top-level navigation executes the fixture and attempts native IPC, which the local-only capability denies.
- Successful runs report no unexpected page CSP violations. No unsafe-eval or editor CSP exemption is added.

The first five runs failed because frame fixture scripts did not execute, not because native authorization was proven. In particular, frame-ancestors * did not include the native custom scheme. Corrected fixture headers explicitly allow tauri://localhost and http://tauri.localhost ancestors and the fixed loopback script origin, including for opaque sandbox content. Failed observations remain preserved in evidence/linux-native-authority.json. Missing frame reports were never accepted as denial.

## Unproven production contracts

A closure-held bearer ticket does not make same-origin scripts a different principal. Same-origin frames can modify parent DOM/prototypes and potentially intercept bootstrap before delivery. The post-bootstrap fake-ticket test is not a defense against that attack. Untrusted document/media content must not execute as unsandboxed same-origin code in a privileged renderer. Production content isolation remains a gate, not an assumption justified by this ping.

Worker absence of globals is not a raw-IPC penetration test. No native deserialization budget, production message queue, TrustedStorageSession binding, SQLite operation, revocation/drain or editor path is exercised.

In Wry 0.55.1 Linux PageLoadEvent::Started maps to WebKit LoadEvent::Committed. This does not prove revocation at every attempted/failed navigation or redirect. Navigation/evaluation races, BFCache, crashes, window close/recreate, navigation floods and accepted-operation ordering remain unverified. A successful reload does not establish cancellation-safe shutdown or drain of native work.

## Reproduction and evidence

Follow tools/tauri-migration/webview-probe/README.md with the authority configuration. Local logs are under /tmp/affine-tauri-build/authority-final. Versioned Linux evidence records source hashes, versions, failed attempts, ten page/collector checks and the separate capability-denied WebView result. The workflow now builds/runs the same mode on Linux, Windows and macOS; configuration is not a passing result.

The migration remains at two completed milestones. tauri-architecture, production ownership/content isolation, native storage integration and desktop parity remain open.
