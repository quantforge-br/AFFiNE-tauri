fn main() {
  let commands: &[&str] = if cfg!(feature = "authority-probe") {
    &["authority_ping", "authority_forbidden"]
  } else {
    &[]
  };
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)),
  )
  .expect("failed to configure the isolated WebView probe");
}
