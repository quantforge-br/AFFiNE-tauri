use std::{path::PathBuf, sync::Arc};

use affine_tauri_core::{Error, SpaceKey, SpaceType, StorageBroker, StorageSession};
use uuid::Uuid;
use y_octo::DocOptions;

struct Fixture(PathBuf);
impl Fixture {
  fn new() -> Self {
    Self(std::env::temp_dir().join(format!("affine-session-public-{}", Uuid::new_v4())))
  }
}
impl Drop for Fixture {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}
fn key(id: &str) -> SpaceKey {
  SpaceKey {
    peer: "local".into(),
    space_type: SpaceType::Workspace,
    id: id.into(),
  }
}
fn update(text: &str) -> Vec<u8> {
  let doc = DocOptions::new().with_guid("doc".into()).build();
  doc.get_or_create_text("content").unwrap().insert(0, text).unwrap();
  doc.encode_update_v1().unwrap()
}
fn text(data: Vec<u8>) -> String {
  let mut doc = DocOptions::new().with_guid("doc".into()).build();
  doc.apply_update_from_binary_v1(&data).unwrap();
  doc.get_or_create_text("content").unwrap().to_string()
}

#[tokio::test]
async fn fixed_sessions_isolate_spaces_and_closing_one_keeps_another_alive() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let first = StorageSession::open(Arc::clone(&broker), key("shared")).await.unwrap();
  let second = StorageSession::open(Arc::clone(&broker), key("shared")).await.unwrap();
  let isolated = StorageSession::open(Arc::clone(&broker), key("isolated"))
    .await
    .unwrap();
  let expected = "session café 東京 🦀";
  let clock = first.push_update("doc".into(), update(expected)).await.unwrap();
  assert_eq!(clock.doc_id, "doc");
  let record = second.get_doc("doc".into()).await.unwrap().unwrap();
  assert_eq!(record.timestamp_ms, clock.timestamp_ms);
  assert_eq!(text(record.data), expected);
  assert!(isolated.get_doc("doc".into()).await.unwrap().is_none());
  first.close().await.unwrap();
  assert_eq!(first.get_doc("doc".into()).await.unwrap_err(), Error::Closed);
  assert_eq!(
    text(second.get_doc("doc".into()).await.unwrap().unwrap().data),
    expected
  );
  second.close().await.unwrap();
  isolated.close().await.unwrap();
}

#[tokio::test]
async fn awaited_close_and_root_reopen_preserve_real_document_and_release_files() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let session = StorageSession::open(Arc::clone(&broker), key("durable")).await.unwrap();
  let expected = "durable native session café 東京 🦀";
  session.push_update("doc".into(), update(expected)).await.unwrap();
  session.close().await.unwrap();
  session.close().await.unwrap();
  drop(session);
  drop(broker);
  let reopened = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let session = StorageSession::open(Arc::clone(&reopened), key("durable"))
    .await
    .unwrap();
  assert_eq!(
    text(session.get_doc("doc".into()).await.unwrap().unwrap().data),
    expected
  );
  session.close().await.unwrap();
  drop(session);
  drop(reopened);
  // Immediate cleanup remains required on Windows, without sleeps or deletion retries.
  std::fs::remove_dir_all(&fixture.0).unwrap();
}

#[tokio::test]
async fn malformed_requests_do_not_change_a_real_session_document() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let session = StorageSession::open(broker, key("validated")).await.unwrap();
  let expected = "valid before rejected update";
  session.push_update("doc".into(), update(expected)).await.unwrap();
  assert_eq!(
    session.push_update("doc".into(), vec![255]).await.unwrap_err(),
    Error::InvalidInput
  );
  assert_eq!(session.get_doc("".into()).await.unwrap_err(), Error::InvalidInput);
  assert_eq!(
    text(session.get_doc("doc".into()).await.unwrap().unwrap().data),
    expected
  );
  session.close().await.unwrap();
  assert_eq!(serde_json::to_string(&Error::Closed).unwrap(), "\"CLOSED\"");
}
