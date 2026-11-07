//! Disposable fixture only. This is not the production native storage command boundary.
use std::{path::PathBuf, sync::Arc};

use affine_tauri_core::{DocClock, DocRecord, Error, SpaceKey, SpaceType, StorageBroker, StorageSession};
use serde::{Deserialize, Serialize};
use tauri::{
  State, Webview,
  http::HeaderMap,
  ipc::{InvokeBody, Request, Response},
};
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
#[serde(deny_unknown_fields)]
pub struct TicketRequest {
  ticket: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReopenResponse {
  drained_previous: bool,
}

const TICKET_HEADER: &str = "x-affine-ticket";
const FRAME_HEADER: usize = 9;

/// Accept exactly one ticket header and reject every other application header, so a caller
/// cannot smuggle owner, path, handle or space selectors through request metadata.
fn ticket(headers: &HeaderMap) -> Result<String, &'static str> {
  if headers
    .keys()
    .any(|name| name.as_str().starts_with("x-affine-") && name.as_str() != TICKET_HEADER)
  {
    return Err("INVALID_INPUT");
  }
  let mut values = headers.get_all(TICKET_HEADER).iter();
  match (values.next(), values.next()) {
    (Some(value), None) => value.to_str().map(str::to_owned).map_err(|_| "UNAUTHORIZED"),
    _ => Err("UNAUTHORIZED"),
  }
}
fn raw_body(body: &InvokeBody) -> Result<&[u8], &'static str> {
  match body {
    InvokeBody::Raw(bytes) => Ok(bytes),
    InvokeBody::Json(_) => Err("INVALID_INPUT"),
  }
}
/// Write frame: u32 little-endian identifier length, UTF-8 identifier, then the update bytes.
fn decode_write(body: &[u8]) -> Result<(String, Vec<u8>), &'static str> {
  let (length, rest) = body.split_first_chunk::<4>().ok_or("INVALID_INPUT")?;
  let length = usize::try_from(u32::from_le_bytes(*length)).map_err(|_| "INVALID_INPUT")?;
  if length == 0 || length > rest.len() {
    return Err("INVALID_INPUT");
  }
  let (id, data) = rest.split_at(length);
  let id = std::str::from_utf8(id).map_err(|_| "INVALID_INPUT")?;
  Ok((id.to_owned(), data.to_vec()))
}
/// Read frame: status byte (0 absent, 1 found), i64 little-endian millisecond clock, then the document bytes.
fn encode_record(record: Option<DocRecord>) -> Vec<u8> {
  let Some(record) = record else {
    return vec![0; FRAME_HEADER];
  };
  let mut frame = Vec::with_capacity(FRAME_HEADER + record.data.len());
  frame.push(1);
  frame.extend_from_slice(&record.timestamp_ms.to_le_bytes());
  frame.extend_from_slice(&record.data);
  frame
}

#[tauri::command]
pub async fn storage_read(
  webview: Webview,
  authority: State<'_, Authority>,
  storage: State<'_, StorageProbe>,
  request: Request<'_>,
) -> Result<Response, &'static str> {
  let ticket = ticket(request.headers())?;
  let generation = authority::authorize(&webview, &authority, &ticket)?;
  let doc_id = std::str::from_utf8(raw_body(request.body())?)
    .map_err(|_| "INVALID_INPUT")?
    .to_owned();
  let record = storage.session(generation).await?.get_doc(doc_id).await.map_err(code)?;
  Ok(Response::new(encode_record(record)))
}
#[tauri::command]
pub async fn storage_write(
  webview: Webview,
  authority: State<'_, Authority>,
  storage: State<'_, StorageProbe>,
  request: Request<'_>,
) -> Result<DocClock, &'static str> {
  let ticket = ticket(request.headers())?;
  let generation = authority::authorize(&webview, &authority, &ticket)?;
  // The diagnostic copies the update once more here; a production path must bound or avoid that copy.
  let (doc_id, data) = decode_write(raw_body(request.body())?)?;
  storage
    .session(generation)
    .await?
    .push_update(doc_id, data)
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

  fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
      map.append(
        tauri::http::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
        value.parse().unwrap(),
      );
    }
    map
  }
  fn write_frame(id: &[u8], declared: u32, data: &[u8]) -> Vec<u8> {
    let mut frame = declared.to_le_bytes().to_vec();
    frame.extend_from_slice(id);
    frame.extend_from_slice(data);
    frame
  }

  #[test]
  fn only_one_ticket_header_and_no_other_application_header_is_accepted() {
    assert_eq!(ticket(&headers(&[("x-affine-ticket", TICKET)])).as_deref(), Ok(TICKET));
    // Ordinary transport headers such as Tauri's own are not application authority.
    assert_eq!(
      ticket(&headers(&[
        ("x-affine-ticket", TICKET),
        ("tauri-callback", "1"),
        ("content-type", "application/octet-stream")
      ]))
      .as_deref(),
      Ok(TICKET)
    );
    for forged in [
      "x-affine-owner",
      "x-affine-path",
      "x-affine-handle",
      "x-affine-window",
      "x-affine-space",
      "x-affine-ticket-extra",
    ] {
      assert_eq!(
        ticket(&headers(&[("x-affine-ticket", TICKET), (forged, "forged")])),
        Err("INVALID_INPUT"),
        "{forged}"
      );
    }
    assert_eq!(ticket(&headers(&[])), Err("UNAUTHORIZED"));
    assert_eq!(
      ticket(&headers(&[("x-affine-ticket", TICKET), ("x-affine-ticket", TICKET)])),
      Err("UNAUTHORIZED")
    );
  }

  #[test]
  fn json_bodies_are_not_raw_storage_input() {
    assert_eq!(raw_body(&InvokeBody::Json(json!({"docId": "a"}))), Err("INVALID_INPUT"));
    assert_eq!(raw_body(&InvokeBody::Raw(vec![1, 2])), Ok(&[1u8, 2][..]));
  }

  #[test]
  fn write_frames_are_strict_and_preserve_every_byte() {
    let all: Vec<u8> = (0..=255).collect();
    let id = "doc café 東京".as_bytes();
    let (decoded_id, data) = decode_write(&write_frame(id, id.len() as u32, &all)).unwrap();
    assert_eq!(decoded_id, "doc café 東京");
    assert_eq!(data, all);
    // An empty update is the core's decision, not the framing's.
    assert_eq!(decode_write(&write_frame(b"a", 1, &[])).unwrap(), ("a".into(), vec![]));
    for (case, frame) in [
      ("empty body", vec![]),
      ("short header", vec![1, 0, 0]),
      ("zero identifier", write_frame(b"", 0, &[7])),
      ("identifier past end", write_frame(b"abc", 4, &[])),
      ("huge declared length", write_frame(b"abc", u32::MAX, &[1, 2])),
      ("invalid utf-8", write_frame(&[0xff, 0xfe], 2, &[1])),
    ] {
      assert_eq!(decode_write(&frame), Err("INVALID_INPUT"), "{case}");
    }
  }

  #[test]
  fn read_frames_distinguish_absent_from_empty_and_keep_the_clock() {
    assert_eq!(encode_record(None), vec![0; FRAME_HEADER]);
    let record = DocRecord {
      doc_id: "a".into(),
      timestamp_ms: 0x0102_0304_0506_0708,
      data: vec![0, 255],
    };
    let frame = encode_record(Some(record));
    assert_eq!(frame[0], 1);
    assert_eq!(
      i64::from_le_bytes(frame[1..9].try_into().unwrap()),
      0x0102_0304_0506_0708
    );
    assert_eq!(&frame[FRAME_HEADER..], &[0, 255]);
    let empty = encode_record(Some(DocRecord {
      doc_id: "a".into(),
      timestamp_ms: -1,
      data: vec![],
    }));
    assert_eq!((empty[0], empty.len()), (1, FRAME_HEADER));
    assert_eq!(i64::from_le_bytes(empty[1..9].try_into().unwrap()), -1);
  }

  #[test]
  fn ticket_commands_reject_unknown_authority_fields() {
    assert!(serde_json::from_value::<TicketRequest>(json!({"ticket": TICKET})).is_ok());
    assert!(serde_json::from_value::<TicketRequest>(json!({})).is_err());
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
      let error = serde_json::from_value::<TicketRequest>(json!({"ticket": TICKET, field: "forged"}))
        .err()
        .unwrap_or_else(|| panic!("extra field {field} accepted"));
      assert!(error.to_string().contains(field), "{field}: {error}");
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
