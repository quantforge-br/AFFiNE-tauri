#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!("the WebDriver automation feature must not be enabled in release builds");
#[cfg(all(
  feature = "authority-probe",
  any(feature = "protocol-probe", feature = "bundled-frontend")
))]
compile_error!("authority diagnostic must run separately from frontend/protocol modes");
#[cfg(all(feature = "authority-probe", not(debug_assertions)))]
compile_error!("the authority diagnostic must not be included in release builds");
#[cfg(feature = "authority-probe")]
mod authority;
#[cfg(feature = "controls-probe")]
mod controls;
#[cfg(feature = "storage-probe")]
mod storage;
#[cfg(all(
  feature = "controls-probe",
  any(
    feature = "authority-probe",
    feature = "protocol-probe",
    feature = "bundled-frontend"
  )
))]
compile_error!("the window-controls diagnostic must run separately from the other modes");
#[cfg(all(feature = "controls-probe", not(feature = "e2e")))]
compile_error!("the window-controls diagnostic requires the disposable e2e profile");
#[cfg(all(feature = "controls-probe", not(debug_assertions)))]
compile_error!("the window-controls diagnostic must not be included in release builds");
#[cfg(all(feature = "storage-probe", not(feature = "e2e")))]
compile_error!("storage diagnostic requires the disposable e2e profile");
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
  // This executable is an engine-compatibility probe, not a desktop release.
  // Existing frontend/protocol modes register no app commands. Authority mode is a separate diagnostic.
  let builder = tauri::Builder::default();
  #[cfg(feature = "e2e")]
  let builder = builder.plugin(tauri_wd::init());
  #[cfg(all(feature = "authority-probe", not(feature = "storage-probe")))]
  let builder = builder
    .manage(authority::Authority::default())
    .invoke_handler(tauri::generate_handler![
      authority::authority_ping,
      authority::authority_forbidden
    ]);
  #[cfg(feature = "storage-probe")]
  let builder = builder
    .manage(authority::Authority::default())
    .manage(tauri::async_runtime::block_on(storage::StorageProbe::new()).expect("disposable native storage fixture"))
    .invoke_handler(tauri::generate_handler![
      authority::authority_ping,
      authority::authority_forbidden,
      storage::storage_read,
      storage::storage_write,
      storage::storage_close,
      storage::storage_reopen
    ]);

  #[cfg(feature = "controls-probe")]
  let builder = builder
    .manage(controls::Controls::default())
    .invoke_handler(tauri::generate_handler![
      controls::controls_report,
      controls::controls_allow_close
    ]);

  builder
    .setup(|app| {
      #[cfg(not(any(
        feature = "bundled-frontend",
        feature = "protocol-probe",
        feature = "authority-probe",
        feature = "controls-probe"
      )))]
      let url = WebviewUrl::External("http://localhost:8080/".parse()?);
      #[cfg(all(feature = "bundled-frontend", not(feature = "protocol-probe")))]
      let url = WebviewUrl::App("index.html".into());
      #[cfg(feature = "protocol-probe")]
      let url = WebviewUrl::App("protocol.html".into());
      #[cfg(all(feature = "authority-probe", not(feature = "storage-probe")))]
      let url = WebviewUrl::App("authority.html".into());
      #[cfg(feature = "storage-probe")]
      let url = WebviewUrl::App("storage.html".into());
      #[cfg(feature = "controls-probe")]
      let url = WebviewUrl::App("controls.html".into());
      let title = if cfg!(feature = "controls-probe") {
        "AFFiNE Window Controls Diagnostic"
      } else {
        "AFFiNE WebView Compatibility Probe"
      };
      let window = WebviewWindowBuilder::new(app, "probe", url)
        .title(title)
        .decorations(false)
        .inner_size(1280.0, 900.0);
      #[cfg(feature = "authority-probe")]
      let window = window.on_page_load(authority::on_page_load);
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
      #[cfg(not(any(feature = "protocol-probe", feature = "authority-probe", feature = "controls-probe")))]
      let window = window.initialization_script(
        // Probe only: the production adapter must choose its transport explicitly.
        "localStorage.setItem('disableSharedWorker', 'true');",
      );
      #[cfg(feature = "e2e")]
      let window = window.on_web_resource_request(|request, response| {
        #[cfg(feature = "bundled-frontend")]
        if request.uri().path() == "/__probe-csp.js" {
          // A normal same-origin page script: WebDriver's Windows executor can bypass CSP.
          let script = r#"try {
            new Function('return 42')();
            window.__probePageCsp = {blocked:false, context:'page-script'};
          } catch(error) {
            window.__probePageCsp = {blocked:true, name:error.name, context:'page-script'};
          }"#;
          *response.status_mut() = 200.try_into().expect("valid status");
          response.headers_mut().insert("content-type", "text/javascript".parse().expect("valid content type"));
          response.headers_mut().remove("content-length");
          *response.body_mut() = std::borrow::Cow::Borrowed(script.as_bytes());
          return;
        }
        eprintln!("AFFINE_PROBE_RESOURCE {} {} {}", request.uri(), response.status(), response.body().len());
      });
      #[cfg(feature = "e2e")]
      let window = window.initialization_script(r#"
        window.__probeErrors = [];
        window.__probeCspViolations = [];
        const originalError = console.error;
        console.error = (...args) => {
          window.__probeErrors.push(args.map(value => String(value)).join(' '));
          originalError.apply(console, args);
        };
        window.__probeWorkers = [];
        for (const name of ['Worker', 'SharedWorker']) {
          const Constructor = window[name];
          if (!Constructor) continue;
          window[name] = new Proxy(Constructor, {
            construct(Target, args) {
              const record = {kind: name, url: String(args[0])};
              window.__probeWorkers.push(record);
              try {
                const worker = new Target(...args);
                worker.addEventListener('error', event => window.__probeErrors.push(name + ': ' + event.message));
                return worker;
              } catch (error) {
                window.__probeErrors.push(name + ' constructor: ' + error);
                throw error;
              }
            }
          });
        };
        window.addEventListener('error', event => window.__probeErrors.push(String(event.message)));
        window.addEventListener('unhandledrejection', event => window.__probeErrors.push(String(event.reason)));
        window.addEventListener('securitypolicyviolation', event => {
          window.__probeCspViolations.push({directive: event.effectiveDirective, blockedURI: event.blockedURI, disposition: event.disposition});
          window.__probeErrors.push('CSP ' + event.violatedDirective + ': ' + event.blockedURI);
        });
      "#);
      let window = window
        .on_navigation(|url| {
          #[cfg(all(feature = "authority-probe", not(feature = "storage-probe")))]
          if url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(8080) && url.path() == "/frame.html" {
            return true;
          }
          if cfg!(any(
            feature = "bundled-frontend",
            feature = "protocol-probe",
            feature = "authority-probe",
            feature = "controls-probe"
          )) {
            (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
              || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
          } else {
            url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(8080)
          }
        })
        .build()?;
      if window.is_decorated()? {
        return Err("the WebView probe must not have native decorations".into());
      }
      eprintln!("AFFINE_PROBE_WINDOW decorations=false");
      #[cfg(not(feature = "controls-probe"))]
      window.on_window_event({
        let window = window.clone();
        move |event| {
          if matches!(event, tauri::WindowEvent::Resized(_)) {
            assert_eq!(window.is_decorated().ok(), Some(false));
          }
        }
      });
      #[cfg(feature = "controls-probe")]
      window.on_window_event({
        let window = window.clone();
        move |event| {
          use tauri::Manager;
          controls::observe(&window, &window.state::<controls::Controls>(), event);
        }
      });
      #[cfg(all(feature = "authority-probe", not(feature = "storage-probe")))]
      {
        // This second local WebView deliberately has no command capability or document ticket.
        let blocked = WebviewWindowBuilder::new(app, "authority-blocked", WebviewUrl::App("authority-blocked.html".into()))
          .decorations(false)
          .visible(false);
        #[cfg(feature = "e2e")]
        let blocked = if let Some(_profile) = tauri_wd::automation_profile_dir() {
          #[cfg(target_os = "macos")]
          { blocked.incognito(true) }
          #[cfg(not(target_os = "macos"))]
          { blocked.data_directory(_profile.join("webview")) }
        } else { blocked };
        let _blocked = blocked.build()?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("failed to run the isolated AFFiNE WebView probe");
}
