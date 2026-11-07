# Native storage runtime features

The default `napi` feature preserves the existing Node binding API. The standalone Rust/mobile/Tauri library must disable default features explicitly:

```toml
affine_nbstore = { path = "../nbstore", default-features = false, features = ["use-as-lib"] }
```

In standalone mode, binary data is owned `Vec<u8>` instead of a Node `Uint8Array`. The dependency graph contains no N-API crates, including build dependencies. The workspace dependency disables defaults so consumers must choose their runtime: Electron enables `napi`, while mobile enables `use-as-lib`.

Run the standalone checks from the repository root:

    cargo test -p affine_nbstore --no-default-features --features use-as-lib --locked
    cargo tree -p affine_nbstore --no-default-features --features use-as-lib --locked --edges normal,build

Also preserve existing consumers:

    cargo test -p affine_nbstore --locked --lib
    cargo test -p affine_mobile_native --locked --lib
    cargo check -p affine_native --locked

The integration test writes all byte values and a UTF-8 CRDT document to disposable SQLite storage, closes the connection, reopens it and verifies exact data. This does not establish production Tauri IPC, profile migration, cold-process restart or cross-platform parity.
