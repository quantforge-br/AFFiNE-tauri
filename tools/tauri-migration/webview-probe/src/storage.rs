//! Disposable fixture only. This is not the production native storage command boundary.
use std::{path::PathBuf, sync::Arc};

use affine_tauri_core::{DocClock, DocRecord, Error, SpaceKey, SpaceType, StorageBroker, StorageSession};
use serde::{Deserialize, Serialize};
use tauri::{State, Webview};
use tokio::sync::Mutex;

use crate::authority::{self, Authority};

pub struct StorageProbe {
  broker: Arc<StorageBroker>,
  session: Mutex<Entry>,
  _root: PathBuf,
}
struct Entry {
  value: Arc<StorageSession>,
  generation: Option<u64>,
  closed: bool,
}
fn key() -> SpaceKey {
  SpaceKey {
    peer: "disposable-probe".into(),
    space_type: SpaceType::Workspace,
    id: "fixed-fixture".into(),
  }
}
fn code(error: Error) -> &'static str {
  match error {
    Error::InvalidInput => "INVALID_INPUT",
    Error::Unauthorized => "UNAUTHORIZED",
    Error::InvalidHandle => "INVALID_HANDLE",
    Error::ResourceLimit => "RESOURCE_LIMIT",
    Error::ResyncRequired => "RESYNC_REQUIRED",
    Error::Closed => "CLOSED",
    _ => "STORAGE",
  }
}
impl StorageProbe {
  pub async fn new() -> Result<Self, Error> {
    // Requires the driver's disposable profile; ordinary launches cannot expose this fixture.
    let root = tauri_wd::automation_profile_dir()
      .ok_or(Error::Unauthorized)?
      .join("rust-storage");
    let broker = StorageBroker::new(root.clone()).await?;
    let value = StorageSession::open(Arc::clone(&broker), key()).await?;
    Ok(Self {
      broker,
      session: Mutex::new(Entry {
        value,
        generation: None,
        closed: false,
      }),
      _root: root,
    })
  }
  async fn session(&self, generation: u64) -> Result<Arc<StorageSession>, &'static str> {
    let mut entry = self.session.lock().await;
    if entry.generation.is_some_and(|value| value != generation) {
      return Err("UNAUTHORIZED");
    }
    entry.generation = Some(generation);
    Ok(Arc::clone(&entry.value))
  }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReadRequest {
  ticket: String,
  doc_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WriteRequest {
  ticket: String,
  doc_id: String,
  data: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TicketRequest {
  ticket: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReopenResponse {
  drained_previous: bool,
}

#[tauri::command]
pub async fn storage_read(
  webview: Webview,
  authority: State<'_, Authority>,
  storage: State<'_, StorageProbe>,
  request: ReadRequest,
) -> Result<Option<DocRecord>, &'static str> {
  let generation = authority::authorize(&webview, &authority, &request.ticket)?;
  storage
    .session(generation)
    .await?
    .get_doc(request.doc_id)
    .await
    .map_err(code)
}
#[tauri::command]
pub async fn storage_write(
  webview: Webview,
  authority: State<'_, Authority>,
  storage: State<'_, StorageProbe>,
  request: WriteRequest,
) -> Result<DocClock, &'static str> {
  let generation = authority::authorize(&webview, &authority, &request.ticket)?;
  storage
    .session(generation)
    .await?
    .push_update(request.doc_id, request.data)
    .await
    .map_err(code)
}
#[tauri::command]
pub async fn storage_close(
  webview: Webview,
  authority: State<'_, Authority>,
  storage: State<'_, StorageProbe>,
  request: TicketRequest,
) -> Result<(), &'static str> {
  let generation = authority::authorize(&webview, &authority, &request.ticket)?;
  let mut entry = storage.session.lock().await;
  if entry.generation.is_some_and(|value| value != generation) {
    return Err("UNAUTHORIZED");
  }
  entry.generation = Some(generation);
  entry.value.close().await.map_err(code)?;
  entry.closed = true;
  Ok(())
}
#[tauri::command]
pub async fn storage_reopen(
  webview: Webview,
  authority: State<'_, Authority>,
  storage: State<'_, StorageProbe>,
  request: TicketRequest,
) -> Result<ReopenResponse, &'static str> {
  let generation = authority::authorize(&webview, &authority, &request.ticket)?;
  let mut entry = storage.session.lock().await;
  if !entry.closed && entry.generation == Some(generation) {
    return Err("INVALID_INPUT");
  }
  // A replacement document takes over only after the previous document's accepted work drains.
  let drained_previous = !entry.closed;
  if drained_previous {
    entry.value.close().await.map_err(code)?;
    entry.closed = true;
  }
  let value = StorageSession::open(Arc::clone(&storage.broker), key())
    .await
    .map_err(code)?;
  *entry = Entry {
    value,
    generation: Some(generation),
    closed: false,
  };
  Ok(ReopenResponse { drained_previous })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  const TICKET: &str = "00000000-0000-4000-8000-000000000000";

  fn rejected_fields<T: serde::de::DeserializeOwned>(base: serde_json::Value) {
    for field in [
      "owner",
      "path",
      "handle",
      "windowLabel",
      "space",
      "peer",
      "spaceId",
      "generation",
    ] {
      let mut request = base.clone();
      request[field] = json!("forged");
      let error = serde_json::from_value::<T>(request)
        .err()
        .unwrap_or_else(|| panic!("extra field {field} accepted"));
      assert!(error.to_string().contains(field), "{field}: {error}");
    }
  }

  #[test]
  fn requests_never_accept_caller_selected_authority() {
    assert!(serde_json::from_value::<ReadRequest>(json!({"ticket": TICKET, "docId": "a"})).is_ok());
    assert!(serde_json::from_value::<WriteRequest>(json!({"ticket": TICKET, "docId": "a", "data": [0, 255]})).is_ok());
    assert!(serde_json::from_value::<TicketRequest>(json!({"ticket": TICKET})).is_ok());
    rejected_fields::<ReadRequest>(json!({"ticket": TICKET, "docId": "a"}));
    rejected_fields::<WriteRequest>(json!({"ticket": TICKET, "docId": "a", "data": [1]}));
    rejected_fields::<TicketRequest>(json!({"ticket": TICKET}));
  }

  #[test]
  fn requests_require_every_declared_field_and_byte_values() {
    assert!(serde_json::from_value::<ReadRequest>(json!({"ticket": TICKET})).is_err());
    assert!(serde_json::from_value::<ReadRequest>(json!({"docId": "a"})).is_err());
    assert!(serde_json::from_value::<WriteRequest>(json!({"ticket": TICKET, "docId": "a"})).is_err());
    assert!(serde_json::from_value::<TicketRequest>(json!({})).is_err());
    for invalid in [json!([256]), json!([-1]), json!(["1"]), json!("bytes"), json!([1.5])] {
      assert!(
        serde_json::from_value::<WriteRequest>(json!({"ticket": TICKET, "docId": "a", "data": invalid})).is_err(),
        "{invalid}"
      );
    }
  }

  #[test]
  fn native_errors_map_to_the_bridge_code_whitelist_without_details() {
    for (error, expected) in [
      (Error::InvalidInput, "INVALID_INPUT"),
      (Error::Unauthorized, "UNAUTHORIZED"),
      (Error::InvalidHandle, "INVALID_HANDLE"),
      (Error::ResourceLimit, "RESOURCE_LIMIT"),
      (Error::ResyncRequired, "RESYNC_REQUIRED"),
      (Error::Closed, "CLOSED"),
      (Error::Task, "STORAGE"),
    ] {
      assert_eq!(code(error), expected);
    }
  }

  #[test]
  fn the_fixture_scope_is_fixed_and_the_reopen_reply_has_no_authority() {
    let key = key();
    assert_eq!(
      (key.peer.as_str(), key.space_type, key.id.as_str()),
      ("disposable-probe", SpaceType::Workspace, "fixed-fixture")
    );
    assert_eq!(
      serde_json::to_value(ReopenResponse { drained_previous: true }).unwrap(),
      json!({"drainedPrevious": true})
    );
  }
}
