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
      #[cfg(not(any(feature = "bundled-frontend", feature = "protocol-probe")))]
      let url = WebviewUrl::External("http://localhost:8080/".parse()?);
      #[cfg(all(feature = "bundled-frontend", not(feature = "protocol-probe")))]
      let url = WebviewUrl::App("index.html".into());
      #[cfg(feature = "protocol-probe")]
      let url = WebviewUrl::App("protocol.html".into());
      let window = WebviewWindowBuilder::new(app, "probe", url)
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
      #[cfg(not(feature = "protocol-probe"))]
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
          if cfg!(any(feature = "bundled-frontend", feature = "protocol-probe")) {
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
