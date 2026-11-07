# CSP-compatible built-in animations

## Failure and diagnosis

The static reference frontend froze during workspace bootstrap under enforced script CSP. The same bundle passed the native editor smoke through a temporary HTTP server without enforcement, and failed again with the embedded policy enforced. Report-only mode was diagnostic, not an acceptable runtime policy.

The enforced report identified script-src / eval in vendor.50b0911b.js at line 2, column 583260. The matched implementation was lottie-web's expression compiler. The only tracked frontend/BlockSuite animation JSON files with string-valued x expression fields were collections-icon.json and delete-icon.json. Attempts to normalize the native URL, change API error responses or disable telemetry did not fix bootstrap; those temporary changes were removed.

Do not add unsafe-eval, disable CSP, globally strip animation expressions or switch to a production HTTP server to work around this failure.

## Conversion, not feature removal

The original JSON files are retained unchanged as authoring sources with fixed SHA-256 checks. Components import generated .keyframes.json siblings. No global Lottie configuration or expression-engine behavior is changed; future imported/runtime animation data is not silently rewritten.

- Collections: evaluate both known nested position expressions with the pinned lottie-web dependency in an unprivileged authoring browser. Sample every 1/32 frame, include both sides of original keyframe transitions, then simplify linear segments with a 0.00015 position-unit tolerance. Retain spring overshoot and reverse playback.
- Both icons: remove only the known clamp(value, 0, 100) expressions after proving their values are static numbers within that interval. This is an identity operation, not a removed effect.
- Preserve all unrelated animation data, timing, dimensions, paths, effects and markers. Tests verify this structural restriction and source/generated hashes.
- Validate source/candidate at 1/64-frame intervals in forward and reverse order. Collections maximum measured position error is 0.0003662109375 units, conservatively scaled to 0.00456298828125 pixels at the 300px design size. The acceptance threshold is below 0.02 design pixels. Delete-icon transform error is zero.

See evidence/lottie-keyframes.json. This is sampled numerical validation, not a mathematical bound at every real-valued time or a native-platform visual parity claim. Source transition boundaries are explicitly sampled to avoid interpolating through original player discontinuities.

## Reproduction

Use the repository Node/Yarn versions and immutable dependencies. Install agent-browser separately and read its installed core skill. From the repository root:

    node tools/tauri-migration/bake-lottie.mjs --check
    node --test tools/tauri-migration/lottie-assets.test.mjs

The first command evaluates only the fixed, hashed source assets on a loopback-only disposable authoring server. It compares regenerated output without writing. Omit --check to regenerate after reviewing source/player changes. The authoring tools are never packaged or started by the desktop app.

For visual comparison:

    node tools/tauri-migration/lottie-gallery.mjs

Use agent-browser to open http://127.0.0.1:8083/candidate.html and wait for window.__galleryReady. Require no window.__galleryError and an empty window.__violations array. Candidate CSP permits only same-origin scripts and does not allow eval. The reference page executes the original expressions without privileged native access.

Capture #gallery on reference.html and candidate.html at a 960x500 viewport using screenshot-master after its doctor check, then diff the PNGs with zero fuzz. Twelve sampled states across the two icons were pixel-identical. The selected frames, capture hashes and result are in evidence/lottie-visual.json. This visual sample does not replace full timeline or native WebView checks.

## Embedded frontend result

Linux WebKitGTK now passes all ten embedded checks, including the original nine editor/transport/authorization/workbench checks and native-origin-script-csp. The latter confirms native origin, absence of application script CSP violations, and an explicit negative attempt to compile dynamic JavaScript (blocked with EvalError). CSP reports were empty before that deliberate negative test. The probe uses embedded static assets, empty native capabilities, no frontend server and no telemetry preference override. See evidence/linux-bundled-csp.json.

This resolves the observed Linux bootstrap incompatibility without weakening script CSP. It does not implement the production Rust broker, native cloud origin configuration, custom controls, process-restart persistence or package installation. The policy deliberately denies frames and most network origins; full media/embed/cloud requirements remain separate gates, not silently disabled product features. Windows/macOS full embedded execution must pass independently in CI.

## Cross-platform CSP verification

Fourth CI run 42386159524 passes all ten embedded checks on Linux/macOS. Windows passes the nine editor checks but fails the extra dynamic-compilation denial: code invoked through the automation executor can construct a Function. The Windows driver uses WebView2 ExecuteScriptWithResult, so that execution is not a sufficient test of ordinary page script restrictions. This failure is preserved in evidence/ci-webview-probe-fourth.json. The follow-up test serves a fixed same-origin JavaScript resource only in e2e,bundled-frontend builds; WebDriver merely appends its script element and reads the result. The script itself must observe EvalError under the unchanged document CSP. No platform exception, unsafe-eval permission or successful no-op replaces the assertion.
