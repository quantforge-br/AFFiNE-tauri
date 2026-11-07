#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!("the WebDriver automation feature must not be enabled in release builds");
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
  // This executable is an engine-compatibility probe, not a desktop release.
  // It loads only the locally built reference frontend and registers no app commands.
  let builder = tauri::Builder::default();
  #[cfg(feature = "e2e")]
  let builder = builder.plugin(tauri_wd::init());

  builder
    .setup(|app| {
      let url = "http://localhost:8080/".parse()?;
      let window = WebviewWindowBuilder::new(app, "probe", WebviewUrl::External(url))
        .title("AFFiNE WebView Compatibility Probe")
        .decorations(false)
        .inner_size(1280.0, 900.0);
      #[cfg(feature = "e2e")]
      let window = if let Some(_profile) = tauri_wd::automation_profile_dir() {
        #[cfg(target_os = "macos")]
        {
          // WKWebView ignores data_directory; an ephemeral store isolates this probe.
          window.incognito(true)
        }
        #[cfg(not(target_os = "macos"))]
        {
          window.data_directory(_profile.join("webview"))
        }
      } else {
        window
      };
      let window = window
        .on_navigation(|url| url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(8080))
        .build()?;
      if window.is_decorated()? {
        return Err("the WebView probe must not have native decorations".into());
      }
      eprintln!("AFFINE_PROBE_WINDOW decorations=false");
      window.on_window_event({
        let window = window.clone();
        move |event| {
          if matches!(event, tauri::WindowEvent::Resized(_)) {
            assert_eq!(window.is_decorated().ok(), Some(false));
          }
        }
      });
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("failed to run the isolated AFFiNE WebView probe");
}
