# Tauri desktop migration baseline

## Repository

- Upstream: https://github.com/toeverything/AFFiNE
- Fork: https://github.com/quantforge-br/AFFiNE-tauri
- Reference branch: `canary`
- Reference commit: `ef401b20cb2a5960278a8e7ab2c0e96d8f759aeb`
- Migration branch: `feat/tauri-desktop`
- Independent checkout: `/home/diogo/dev/AFFiNE-tauri`

The checkout was cloned from committed Git objects using `--no-hardlinks`, then configured with the fork as origin and the original repository as upstream. No untracked files were copied or pushed. The original checkout's HEAD, remotes, tracked working tree and index were unchanged after fork creation.

## Excluded local state

The original checkout contained only two untracked entries: `.pi/` (agent state) and `affine-mcp-server/` (independent local integration). Neither belongs to the baseline or the fork. No user data, credentials or local agent state is part of this migration.

## Reference behavior

The reference implementation is Electron, not a previously validated Tauri application. Source inspection establishes the feature inventory; runtime behavior still requires reference tests. No platform parity or migration safety is claimed by this baseline record.

The original checkout currently requests Rust 1.97.1, but invoking rustc reports a missing toolchain manifest. Node on the host is 24.22.2 while the repository requires Node >=22.12.0 <23.0.0. These are observed environment discrepancies, not baseline application test results. GTK 3.24.52 and WebKitGTK 2.54.2 are available through pkg-config.
