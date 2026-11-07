//! Disposable command-authorization diagnostic. No storage or production frontend is exposed.
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
  Manager, State, Webview, WebviewWindow,
  webview::{PageLoadEvent, PageLoadPayload},
};
use uuid::Uuid;

#[derive(Default)]
pub struct Authority(Mutex<DocumentAuthority>);

#[derive(Default)]
struct DocumentAuthority {
  ticket: Option<Uuid>,
  generation: u64,
  accepted: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PingRequest {
  ticket: String,
  challenge: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResponse {
  generation: u64,
  sequence: u64,
  challenge: String,
}

fn document_path() -> &'static str {
  if cfg!(feature = "storage-probe") {
    "/storage.html"
  } else {
    "/authority.html"
  }
}

fn trusted_url(url: &tauri::Url) -> bool {
  let origin = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
    || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
  origin
    && url.port().is_none()
    && url.username().is_empty()
    && url.password().is_none()
    && url.path() == document_path()
    && url.query().is_none()
    && url.fragment().is_none()
}

pub fn on_page_load(window: WebviewWindow, payload: PageLoadPayload<'_>) {
  if window.label() != "probe" {
    return;
  }
  let state = window.state::<Authority>();
  let Ok(mut document) = state.0.lock() else {
    return;
  };
  // Revoke on reported document-load events. On Linux Started maps to WebKit Committed,
  // not every attempted/failed navigation; this diagnostic does not prove that stronger contract.
  document.ticket = None;
  if payload.event() != PageLoadEvent::Finished || !trusted_url(payload.url()) {
    return;
  }
  let ticket = Uuid::new_v4();
  document.generation += 1;
  document.ticket = Some(ticket);
  let generation = document.generation;
  drop(document);
  // Evaluate into the main document, not an initialization script that also runs in Windows subframes.
  // The page callback keeps the ticket in a closure. Never send it through a global message listener.
  let script = format!(
    "if (window === window.top && location.href === {} && typeof window.__acceptAuthorityTicket === 'function') {{ window.__acceptAuthorityTicket({}, {}); }}",
    serde_json::to_string(payload.url().as_str()).expect("URL is serializable"),
    serde_json::to_string(&ticket.to_string()).expect("UUID is serializable"),
    generation
  );
  if window.eval(script).is_err()
    && let Ok(mut document) = state.0.lock()
  {
    document.ticket = None;
  }
}

#[cfg(feature = "storage-probe")]
pub fn authorize(webview: &Webview, state: &Authority, ticket: &str) -> Result<u64, &'static str> {
  if webview.label() != "probe" || !webview.url().is_ok_and(|url| trusted_url(&url)) {
    return Err("UNAUTHORIZED");
  }
  let ticket = Uuid::parse_str(ticket).map_err(|_| "UNAUTHORIZED")?;
  let document = state.0.lock().map_err(|_| "UNAUTHORIZED")?;
  if document.ticket != Some(ticket) {
    return Err("UNAUTHORIZED");
  }
  Ok(document.generation)
}

#[tauri::command]
pub fn authority_ping(
  webview: Webview,
  state: State<'_, Authority>,
  request: PingRequest,
) -> Result<PingResponse, &'static str> {
  if webview.label() != "probe" || !webview.url().is_ok_and(|url| trusted_url(&url)) {
    return Err("UNAUTHORIZED");
  }
  if request.ticket.len() != 36 || request.challenge.len() > 128 || request.challenge.is_empty() {
    return Err("INVALID_INPUT");
  }
  let ticket = Uuid::parse_str(&request.ticket).map_err(|_| "UNAUTHORIZED")?;
  let mut document = state.0.lock().map_err(|_| "UNAUTHORIZED")?;
  if document.ticket != Some(ticket) {
    return Err("UNAUTHORIZED");
  }
  document.accepted += 1;
  Ok(PingResponse {
    generation: document.generation,
    sequence: document.accepted,
    challenge: request.challenge,
  })
}

#[tauri::command]
pub fn authority_forbidden() -> &'static str {
  // A successful call is a test failure: this command is registered but has no capability grant.
  "FORBIDDEN_COMMAND_REACHED"
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_the_exact_bundled_diagnostic_document_is_trusted() {
    // Each diagnostic mode trusts only its own document; the other mode's document must fail.
    let (active, other) = if cfg!(feature = "storage-probe") {
      ("storage.html", "authority.html")
    } else {
      ("authority.html", "storage.html")
    };
    for origin in ["tauri://localhost", "http://tauri.localhost"] {
      assert!(trusted_url(&format!("{origin}/{active}").parse().unwrap()));
      assert!(!trusted_url(&format!("{origin}/{other}").parse().unwrap()));
    }
    for url in [
      format!("https://tauri.localhost/{active}"),
      format!("http://tauri.localhost:80/{active}?forged"),
      "tauri://localhost/frame.html".to_string(),
      format!("http://localhost/{active}"),
      format!("tauri://localhost/{active}?forged"),
      format!("tauri://localhost/{active}#forged"),
      format!("http://tauri.localhost:8080/{active}"),
      format!("http://attacker@tauri.localhost/{active}"),
      format!("http://tauri.localhost.evil/{active}"),
      format!("tauri://localhost/{active}/"),
    ] {
      assert!(!trusted_url(&url.parse().unwrap()), "{url}");
    }
  }

  #[test]
  fn request_schema_never_accepts_owner_path_handle_or_window_authority() {
    assert!(
      serde_json::from_value::<PingRequest>(serde_json::json!({
        "ticket": Uuid::new_v4().to_string(), "challenge": "valid"
      }))
      .is_ok()
    );
    for key in ["owner", "path", "handle", "windowLabel"] {
      let mut request = serde_json::json!({"ticket": Uuid::new_v4().to_string(), "challenge": "test"});
      request[key] = serde_json::Value::String("forged".into());
      let error = serde_json::from_value::<PingRequest>(request)
        .err()
        .expect("extra field rejected");
      assert!(error.to_string().contains(key));
    }
  }
}
