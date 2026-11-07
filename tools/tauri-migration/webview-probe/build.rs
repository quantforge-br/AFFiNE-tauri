fn main() {
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[])))
    .expect("failed to configure the isolated WebView probe");
}
