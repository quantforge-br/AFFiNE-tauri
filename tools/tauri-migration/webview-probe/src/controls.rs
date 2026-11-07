// Disposable window-controls diagnostic. It records what the native window does while the page's own
// controls drive it; it is not the production window manager and is never part of a release build.
use std::{collections::BTreeMap, sync::Mutex};

use serde::Serialize;
use tauri::{State, Webview, WebviewWindow, WindowEvent};

const DOCUMENT_PATH: &str = "/controls.html";

#[derive(Default)]
pub struct Controls(Mutex<Observed>);

#[derive(Default)]
struct Observed {
  events: BTreeMap<&'static str, u64>,
  decorated_observations: u64,
  decorated_violations: u64,
  close_requests: u64,
  prevented_closes: u64,
  allow_close: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
  events: BTreeMap<&'static str, u64>,
  decorated_observations: u64,
  decorated_violations: u64,
  close_requests: u64,
  prevented_closes: u64,
}

fn event_name(event: &WindowEvent) -> &'static str {
  match event {
    WindowEvent::Resized(_) => "resized",
    WindowEvent::Moved(_) => "moved",
    WindowEvent::CloseRequested { .. } => "closeRequested",
    WindowEvent::Destroyed => "destroyed",
    WindowEvent::Focused(_) => "focused",
    WindowEvent::ScaleFactorChanged { .. } => "scaleFactorChanged",
    WindowEvent::DragDrop(_) => "dragDrop",
    WindowEvent::ThemeChanged(_) => "themeChanged",
    _ => "other",
  }
}

fn trusted_document(url: &tauri::Url) -> bool {
  let origin = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
    || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
  origin
    && url.port().is_none()
    && url.username().is_empty()
    && url.password().is_none()
    && url.path() == DOCUMENT_PATH
    && url.query().is_none()
    && url.fragment().is_none()
}

impl Controls {
  fn record(&self, name: &'static str, decorated: Option<bool>) -> Option<bool> {
    let mut observed = self.0.lock().ok()?;
    *observed.events.entry(name).or_default() += 1;
    if let Some(decorated) = decorated {
      observed.decorated_observations += 1;
      if decorated {
        observed.decorated_violations += 1;
      }
    }
    Some(observed.allow_close)
  }

  fn report(&self) -> Option<Report> {
    let observed = self.0.lock().ok()?;
    Some(Report {
      events: observed.events.clone(),
      decorated_observations: observed.decorated_observations,
      decorated_violations: observed.decorated_violations,
      close_requests: observed.close_requests,
      prevented_closes: observed.prevented_closes,
    })
  }
}

/// Called for every native window event. The window must never regain native decorations, whatever the
/// transition that produced the event. Close requests are intercepted until the page asks to allow one,
/// which models the close safeguard (for example hiding to the tray) the reference application has.
pub fn observe(window: &WebviewWindow, state: &Controls, event: &WindowEvent) {
  let decorated = if matches!(event, WindowEvent::Destroyed) {
    None
  } else {
    window.is_decorated().ok()
  };
  let allow_close = state.record(event_name(event), decorated).unwrap_or(false);
  if let WindowEvent::CloseRequested { api, .. } = event {
    if let Ok(mut observed) = state.0.lock() {
      observed.close_requests += 1;
      if !allow_close {
        observed.prevented_closes += 1;
      }
    }
    if !allow_close {
      api.prevent_close();
    }
  }
}

#[tauri::command]
pub fn controls_report(webview: Webview, state: State<'_, Controls>) -> Result<Report, &'static str> {
  if webview.label() != "probe" || !webview.url().is_ok_and(|url| trusted_document(&url)) {
    return Err("UNAUTHORIZED");
  }
  state.report().ok_or("UNAUTHORIZED")
}

#[tauri::command]
pub fn controls_allow_close(webview: Webview, state: State<'_, Controls>) -> Result<(), &'static str> {
  if webview.label() != "probe" || !webview.url().is_ok_and(|url| trusted_document(&url)) {
    return Err("UNAUTHORIZED");
  }
  state.0.lock().map_err(|_| "UNAUTHORIZED")?.allow_close = true;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn url(value: &str) -> tauri::Url {
    value.parse().expect("test URL")
  }

  #[test]
  fn only_the_exact_local_diagnostic_document_is_trusted() {
    assert!(trusted_document(&url("tauri://localhost/controls.html")));
    assert!(trusted_document(&url("http://tauri.localhost/controls.html")));
    for rejected in [
      "tauri://localhost/other.html",
      "tauri://localhost/controls.html?x=1",
      "tauri://localhost/controls.html#x",
      "tauri://user@localhost/controls.html",
      "tauri://localhost:9/controls.html",
      "http://localhost/controls.html",
      "http://127.0.0.1:8080/controls.html",
      "https://tauri.localhost/controls.html",
    ] {
      assert!(!trusted_document(&url(rejected)), "{rejected}");
    }
  }

  #[test]
  fn decorated_observations_are_counted_and_violations_are_reported() {
    let state = Controls::default();
    assert_eq!(state.record("resized", Some(false)), Some(false));
    assert_eq!(state.record("moved", Some(true)), Some(false));
    assert_eq!(state.record("destroyed", None), Some(false));
    let report = state.report().expect("report");
    assert_eq!(report.decorated_observations, 2);
    assert_eq!(report.decorated_violations, 1);
    assert_eq!(report.events.get("destroyed"), Some(&1));
  }

  #[test]
  fn the_close_gate_defaults_to_intercepting() {
    let state = Controls::default();
    assert_eq!(state.record("closeRequested", Some(false)), Some(false));
    state.0.lock().expect("lock").allow_close = true;
    assert_eq!(state.record("closeRequested", Some(false)), Some(true));
  }

  #[test]
  fn the_report_has_no_authority_fields() {
    let json = serde_json::to_string(&Controls::default().report().expect("report")).expect("json");
    for forbidden in ["owner", "path", "handle", "ticket"] {
      assert!(!json.contains(forbidden), "{forbidden}");
    }
  }
}
