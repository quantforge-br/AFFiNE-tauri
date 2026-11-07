use std::{path::PathBuf, sync::Arc, time::Duration};

use affine_tauri_core::{Error, SpaceKey, SpaceType, StorageBroker};
use uuid::Uuid;
use y_octo::DocOptions;

struct Fixture(PathBuf);
impl Fixture {
  fn new() -> Self {
    Self(std::env::temp_dir().join(format!("affine-tauri-core-{}", Uuid::new_v4())))
  }
  async fn broker(&self) -> Arc<StorageBroker> {
    StorageBroker::new(self.0.clone()).await.unwrap()
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
fn update(doc_id: &str, text: &str) -> Vec<u8> {
  let doc = DocOptions::new().with_guid(doc_id.into()).build();
  doc.get_or_create_text("content").unwrap().insert(0, text).unwrap();
  doc.encode_update_v1().unwrap()
}
fn text(data: &[u8], doc_id: &str) -> String {
  let mut doc = DocOptions::new().with_guid(doc_id.into()).build();
  doc.apply_update_from_binary_v1(data).unwrap();
  doc.get_or_create_text("content").unwrap().to_string()
}

#[tokio::test]
async fn sharing_uses_owner_scoped_leases_and_close_keeps_other_owner_alive() {
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  let space = key("workspace");
  let alice = broker.register_owner(vec![space.clone()]).await.unwrap();
  let bob = broker.register_owner(vec![space.clone()]).await.unwrap();
  let outsider = broker.register_owner(vec![key("other")]).await.unwrap();
  let a = broker.open(alice, space.clone()).await.unwrap();
  let b = broker.open(bob, space.clone()).await.unwrap();
  assert!(matches!(broker.open(outsider, space).await, Err(Error::Unauthorized)));
  assert!(matches!(
    broker.get_doc(bob, a, "doc".into()).await,
    Err(Error::InvalidHandle)
  ));
  assert!(matches!(broker.close(bob, a).await, Err(Error::InvalidHandle)));
  let mut snapshot = broker.snapshot(bob, b).await.unwrap();
  assert_eq!(snapshot.revision, 0);
  let clock = broker
    .push_update(alice, a, "doc".into(), update("doc", "café 東京 🦀"))
    .await
    .unwrap();
  let event = tokio::time::timeout(Duration::from_secs(2), snapshot.subscription.recv())
    .await
    .unwrap()
    .unwrap();
  assert_eq!(event.revision, 1);
  assert_eq!(event.timestamp_ms, clock.timestamp_ms);
  let wire = serde_json::to_value(&event).unwrap();
  assert!(wire.get("source").is_none());
  assert!(
    !wire
      .to_string()
      .contains(&serde_json::to_value(a).unwrap().as_str().unwrap().to_string())
  );
  broker.close(alice, a).await.unwrap();
  let record = broker.get_doc(bob, b, "doc".into()).await.unwrap().unwrap();
  assert_eq!(text(&record.data, "doc"), "café 東京 🦀");
  assert!(matches!(
    broker.get_doc(alice, a, "doc".into()).await,
    Err(Error::InvalidHandle)
  ));
  broker.revoke_owner(bob).await.unwrap();
  broker.revoke_owner(alice).await.unwrap();
  broker.revoke_owner(outsider).await.unwrap();
}

#[tokio::test]
async fn snapshots_have_no_subscription_gap_and_source_echoes_are_suppressed() {
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  let space = key("workspace");
  let owner = broker.register_owner(vec![space.clone()]).await.unwrap();
  let a = broker.open(owner, space.clone()).await.unwrap();
  let b = broker.open(owner, space).await.unwrap();
  let mut first = broker.snapshot(owner, a).await.unwrap();
  let mut second = broker.snapshot(owner, b).await.unwrap();
  broker
    .push_update(owner, a, "doc".into(), update("doc", "first"))
    .await
    .unwrap();
  let event = tokio::time::timeout(Duration::from_secs(2), second.subscription.recv())
    .await
    .unwrap()
    .unwrap();
  assert_eq!(event.revision, 1);
  assert!(
    tokio::time::timeout(Duration::from_millis(30), first.subscription.recv())
      .await
      .is_err()
  );
  let after = broker.snapshot(owner, b).await.unwrap();
  assert_eq!(after.revision, 1);
  assert_eq!(after.clocks.len(), 1);
  broker.revoke_owner(owner).await.unwrap();
}

#[tokio::test]
async fn revoke_wakes_blocked_subscribers_and_does_not_invalidate_other_owners() {
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  let space = key("workspace");
  let alice = broker.register_owner(vec![space.clone()]).await.unwrap();
  let bob = broker.register_owner(vec![space.clone()]).await.unwrap();
  let a = broker.open(alice, space.clone()).await.unwrap();
  let b = broker.open(bob, space).await.unwrap();
  let mut snapshot = broker.snapshot(alice, a).await.unwrap();
  let task = tokio::spawn(async move { snapshot.subscription.recv().await });
  broker.revoke_owner(alice).await.unwrap();
  let failure = tokio::time::timeout(Duration::from_secs(2), task)
    .await
    .unwrap()
    .unwrap()
    .unwrap_err();
  assert_eq!(failure, Error::Unauthorized);
  assert!(matches!(
    broker.get_doc(alice, a, "doc".into()).await,
    Err(Error::Unauthorized)
  ));
  broker
    .push_update(bob, b, "doc".into(), update("doc", "still open"))
    .await
    .unwrap();
  broker.revoke_owner(bob).await.unwrap();
}

#[tokio::test]
async fn parallel_writes_have_strict_revisions_and_no_lost_committed_updates() {
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  let space = key("workspace");
  let owner = broker.register_owner(vec![space.clone()]).await.unwrap();
  let writer = broker.open(owner, space.clone()).await.unwrap();
  let reader = broker.open(owner, space).await.unwrap();
  let mut snapshot = broker.snapshot(owner, reader).await.unwrap();
  let mut tasks = vec![];
  for index in 0..32 {
    let broker = Arc::clone(&broker);
    tasks.push(tokio::spawn(async move {
      let id = format!("doc-{index}");
      broker
        .push_update(owner, writer, id.clone(), update(&id, &index.to_string()))
        .await
    }));
  }
  for task in tasks {
    task.await.unwrap().unwrap();
  }
  for revision in 1..=32 {
    let event = tokio::time::timeout(Duration::from_secs(2), snapshot.subscription.recv())
      .await
      .unwrap()
      .unwrap();
    assert_eq!(event.revision, revision);
  }
  let current = broker.snapshot(owner, reader).await.unwrap();
  assert_eq!(current.clocks.len(), 32);
  assert_eq!(current.revision, 32);
  broker.revoke_owner(owner).await.unwrap();
}

#[tokio::test]
async fn lagged_events_explicitly_require_a_new_snapshot() {
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  let space = key("workspace");
  let owner = broker.register_owner(vec![space.clone()]).await.unwrap();
  let a = broker.open(owner, space.clone()).await.unwrap();
  let b = broker.open(owner, space).await.unwrap();
  let mut snapshot = broker.snapshot(owner, b).await.unwrap();
  for index in 0..140 {
    let id = format!("doc-{index}");
    broker
      .push_update(owner, a, id.clone(), update(&id, "x"))
      .await
      .unwrap();
  }
  assert_eq!(snapshot.subscription.recv().await.unwrap_err(), Error::ResyncRequired);
  assert_eq!(snapshot.subscription.recv().await.unwrap_err(), Error::ResyncRequired);
  assert_eq!(broker.snapshot(owner, b).await.unwrap().clocks.len(), 140);
  broker.revoke_owner(owner).await.unwrap();
}

#[tokio::test]
async fn reopening_uses_existing_database_without_migrating_an_electron_profile() {
  let fixture = Fixture::new();
  let space = key("workspace");
  let broker = fixture.broker().await;
  let owner = broker.register_owner(vec![space.clone()]).await.unwrap();
  let handle = broker.open(owner, space.clone()).await.unwrap();
  let payload = update("doc", "persisted offline");
  let clock = broker.push_update(owner, handle, "doc".into(), payload).await.unwrap();
  broker.revoke_owner(owner).await.unwrap();
  drop(broker);
  let reopened = fixture.broker().await;
  let next = reopened.register_owner(vec![space.clone()]).await.unwrap();
  let handle = reopened.open(next, space).await.unwrap();
  let record = reopened.get_doc(next, handle, "doc".into()).await.unwrap().unwrap();
  assert_eq!(text(&record.data, "doc"), "persisted offline");
  assert_eq!(record.timestamp_ms, clock.timestamp_ms);
  reopened.revoke_owner(next).await.unwrap();
}

#[tokio::test]
async fn hostile_identifiers_cannot_select_paths_and_wire_errors_are_sanitized() {
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  for invalid in ["", "line\nbreak"] {
    assert!(matches!(
      broker.register_owner(vec![key(invalid)]).await,
      Err(Error::InvalidInput)
    ));
  }
  let space = key("../../outside/storage.db");
  let owner = broker.register_owner(vec![space.clone()]).await.unwrap();
  let handle = broker.open(owner, space).await.unwrap();
  assert!(matches!(
    broker.push_update(owner, handle, "doc".into(), vec![]).await,
    Err(Error::InvalidInput)
  ));
  assert!(matches!(
    broker
      .push_update(owner, handle, "doc".into(), vec![1; 16 * 1024 * 1024 + 1])
      .await,
    Err(Error::InvalidInput)
  ));
  for entry in std::fs::read_dir(&fixture.0).unwrap() {
    let name = entry.unwrap().file_name().to_string_lossy().to_string();
    if name == ".host.lock" {
      continue;
    }
    assert!(name.len() >= 67);
    assert!(name[..64].chars().all(|ch| ch.is_ascii_hexdigit()));
  }
  assert_eq!(serde_json::to_string(&Error::Storage).unwrap(), "\"STORAGE\"");
  broker.revoke_owner(owner).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_root_and_sqlite_sidecars_are_rejected() {
  use std::os::unix::fs::symlink;
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  let space = key("workspace");
  let owner = broker.register_owner(vec![space.clone()]).await.unwrap();
  let handle = broker.open(owner, space.clone()).await.unwrap();
  broker.close(owner, handle).await.unwrap();
  let database = std::fs::read_dir(&fixture.0)
    .unwrap()
    .map(|e| e.unwrap().path())
    .find(|p| p.extension().is_some_and(|e| e == "db"))
    .unwrap();
  let target = fixture.0.join("unrelated");
  std::fs::write(&target, b"must not change").unwrap();
  let sidecar = PathBuf::from(format!("{}-wal", database.display()));
  if sidecar.exists() {
    std::fs::remove_file(&sidecar).unwrap();
  }
  symlink(&target, &sidecar).unwrap();
  assert!(matches!(broker.open(owner, space).await, Err(Error::UnsafePath)));
  assert_eq!(std::fs::read(&target).unwrap(), b"must not change");
  let link = fixture.0.with_extension("link");
  symlink(&fixture.0, &link).unwrap();
  assert!(matches!(StorageBroker::new(link.clone()).await, Err(Error::UnsafePath)));
  std::fs::remove_file(link).unwrap();
  broker.revoke_owner(owner).await.unwrap();
}

#[tokio::test]
async fn malformed_crdt_is_rejected_before_changing_clocks_or_revisions() {
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  let space = key("workspace");
  let owner = broker.register_owner(vec![space.clone()]).await.unwrap();
  let handle = broker.open(owner, space).await.unwrap();
  assert!(matches!(
    broker
      .push_update(owner, handle, "doc".into(), vec![255, 255, 255])
      .await,
    Err(Error::InvalidInput)
  ));
  let snapshot = broker.snapshot(owner, handle).await.unwrap();
  assert_eq!(snapshot.revision, 0);
  assert!(snapshot.clocks.is_empty());
  assert!(broker.get_doc(owner, handle, "doc".into()).await.unwrap().is_none());
  broker.revoke_owner(owner).await.unwrap();
}

#[test]
fn cold_process_restart_retains_document_and_rejects_the_previous_process_handle() {
  let fixture = Fixture::new();
  for mode in ["write", "read"] {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
      .args(["--exact", "cold_process_fixture", "--nocapture"])
      .env("AFFINE_TAURI_FIXTURE_ROOT", &fixture.0)
      .env("AFFINE_TAURI_FIXTURE_MODE", mode)
      .output()
      .unwrap();
    assert!(
      output.status.success(),
      "child {mode} failed: {} {}",
      String::from_utf8_lossy(&output.stdout),
      String::from_utf8_lossy(&output.stderr)
    );
  }
}

#[tokio::test]
async fn cold_process_fixture() {
  let Ok(root) = std::env::var("AFFINE_TAURI_FIXTURE_ROOT") else {
    return;
  };
  let root = PathBuf::from(root);
  assert!(
    root
      .file_name()
      .unwrap()
      .to_string_lossy()
      .starts_with("affine-tauri-core-")
  );
  if std::env::var("AFFINE_TAURI_FIXTURE_MODE").unwrap() == "locked" {
    assert!(matches!(StorageBroker::new(root).await, Err(Error::StorageInUse)));
    return;
  }
  let broker = StorageBroker::new(root.clone()).await.unwrap();
  let space = key("process-workspace");
  let owner = broker.register_owner(vec![space.clone()]).await.unwrap();
  let handle = broker.open(owner, space).await.unwrap();
  if std::env::var("AFFINE_TAURI_FIXTURE_MODE").unwrap() == "write" {
    broker
      .push_update(owner, handle, "doc".into(), update("doc", "cold process café 東京 🦀"))
      .await
      .unwrap();
    std::fs::write(root.join("previous-handle.json"), serde_json::to_vec(&handle).unwrap()).unwrap();
    // Intentionally exit without graceful broker cleanup: SQLite must retain committed data.
    std::process::exit(0);
  }
  let old = serde_json::from_slice(&std::fs::read(root.join("previous-handle.json")).unwrap()).unwrap();
  assert!(matches!(
    broker.get_doc(owner, old, "doc".into()).await,
    Err(Error::InvalidHandle)
  ));
  let record = broker.get_doc(owner, handle, "doc".into()).await.unwrap().unwrap();
  assert_eq!(text(&record.data, "doc"), "cold process café 東京 🦀");
  broker.revoke_owner(owner).await.unwrap();
}

#[tokio::test]
async fn valid_incremental_updates_can_arrive_before_their_dependencies() {
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  let space = key("workspace");
  let owner = broker.register_owner(vec![space.clone()]).await.unwrap();
  let handle = broker.open(owner, space).await.unwrap();
  let doc = DocOptions::new().with_guid("doc".into()).build();
  let mut content = doc.get_or_create_text("content").unwrap();
  content.insert(0, "first").unwrap();
  let initial = doc.encode_update_v1().unwrap();
  let state = doc.get_state_vector();
  content.insert(5, " second").unwrap();
  let incremental = doc.encode_state_as_update_v1(&state).unwrap();
  broker
    .push_update(owner, handle, "doc".into(), incremental)
    .await
    .unwrap();
  broker.push_update(owner, handle, "doc".into(), initial).await.unwrap();
  let record = broker.get_doc(owner, handle, "doc".into()).await.unwrap().unwrap();
  assert_eq!(text(&record.data, "doc"), "first second");
  broker.revoke_owner(owner).await.unwrap();
}

#[tokio::test]
async fn hostile_crdt_counts_depth_and_trailing_bytes_are_rejected_without_persistence() {
  use y_octo::{CrdtWriter, RawEncoder};
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  let space = key("workspace");
  let owner = broker.register_owner(vec![space.clone()]).await.unwrap();
  let handle = broker.open(owner, space).await.unwrap();
  let mut clients = RawEncoder::default();
  clients.write_var_u64(10_001).unwrap();
  let mut structs = RawEncoder::default();
  structs.write_var_u64(1).unwrap();
  structs.write_var_u64(250_001).unwrap();
  let mut deep = vec![1, 1, 0, 0, 8, 1, 1, b'r', 1];
  for _ in 0..65 {
    deep.extend_from_slice(&[117, 1]);
  }
  deep.extend_from_slice(&[126, 0]);
  for bytes in [clients.into_inner(), structs.into_inner(), deep] {
    assert_eq!(
      broker
        .push_update(owner, handle, "doc".into(), bytes)
        .await
        .unwrap_err(),
      Error::ResourceLimit
    );
  }
  let mut trailing = update("doc", "must not persist");
  trailing.push(0);
  assert_eq!(
    broker
      .push_update(owner, handle, "doc".into(), trailing)
      .await
      .unwrap_err(),
    Error::InvalidInput
  );
  let snapshot = broker.snapshot(owner, handle).await.unwrap();
  assert_eq!(snapshot.revision, 0);
  assert!(snapshot.clocks.is_empty());
  broker.revoke_owner(owner).await.unwrap();
}

#[tokio::test]
async fn peer_type_and_length_delimited_identifiers_isolate_databases() {
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  let a = key("bc");
  let mut b = a.clone();
  b.peer = "other".into();
  let mut c = a.clone();
  c.space_type = SpaceType::Userspace;
  let mut d = key("c");
  d.peer = "localb".into();
  let owner = broker
    .register_owner(vec![a.clone(), b.clone(), c.clone(), d.clone()])
    .await
    .unwrap();
  let writer = broker.open(owner, a).await.unwrap();
  broker
    .push_update(owner, writer, "doc".into(), update("doc", "isolated"))
    .await
    .unwrap();
  for space in [b, c, d] {
    let handle = broker.open(owner, space).await.unwrap();
    assert!(broker.get_doc(owner, handle, "doc".into()).await.unwrap().is_none());
  }
  broker.revoke_owner(owner).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn private_root_rejects_group_or_other_permissions() {
  use std::os::unix::fs::PermissionsExt;
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  assert_eq!(
    std::fs::metadata(&fixture.0).unwrap().permissions().mode() & 0o777,
    0o700
  );
  drop(broker);
  std::fs::set_permissions(&fixture.0, std::fs::Permissions::from_mode(0o750)).unwrap();
  assert!(matches!(
    StorageBroker::new(fixture.0.clone()).await,
    Err(Error::UnsafePath)
  ));
}

#[tokio::test]
async fn a_private_root_has_only_one_authority_across_brokers_and_processes() {
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  assert!(matches!(
    StorageBroker::new(fixture.0.clone()).await,
    Err(Error::StorageInUse)
  ));
  let output = std::process::Command::new(std::env::current_exe().unwrap())
    .args(["--exact", "cold_process_fixture", "--nocapture"])
    .env("AFFINE_TAURI_FIXTURE_ROOT", &fixture.0)
    .env("AFFINE_TAURI_FIXTURE_MODE", "locked")
    .output()
    .unwrap();
  assert!(
    output.status.success(),
    "child lock check failed: {} {}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
  drop(broker);
  let reopened = fixture.broker().await;
  drop(reopened);
}

#[tokio::test]
async fn concurrent_updates_to_one_document_converge_without_lost_clients() {
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  let space = key("workspace");
  let owner = broker.register_owner(vec![space.clone()]).await.unwrap();
  let handle = broker.open(owner, space).await.unwrap();
  let mut tasks = vec![];
  for index in 0..32 {
    let broker = Arc::clone(&broker);
    tasks.push(tokio::spawn(async move {
      let doc = DocOptions::new().with_guid("doc".into()).build();
      doc
        .get_or_create_map("clients")
        .unwrap()
        .insert(index.to_string(), index)
        .unwrap();
      broker
        .push_update(owner, handle, "doc".into(), doc.encode_update_v1().unwrap())
        .await
    }));
  }
  for task in tasks {
    task.await.unwrap().unwrap();
  }
  let record = broker.get_doc(owner, handle, "doc".into()).await.unwrap().unwrap();
  let mut doc = DocOptions::new().with_guid("doc".into()).build();
  doc.apply_update_from_binary_v1(record.data).unwrap();
  let clients = doc.get_or_create_map("clients").unwrap();
  assert_eq!(clients.len(), 32);
  for index in 0..32 {
    assert!(clients.get(&index.to_string()).is_some());
  }
  broker.revoke_owner(owner).await.unwrap();
}

#[tokio::test]
async fn owner_and_lease_limits_reject_overflow_and_release_capacity() {
  let fixture = Fixture::new();
  let broker = fixture.broker().await;
  let space = key("workspace");
  let mut owners = vec![];
  for _ in 0..128 {
    owners.push(broker.register_owner(vec![space.clone()]).await.unwrap());
  }
  assert_eq!(
    broker.register_owner(vec![space.clone()]).await.unwrap_err(),
    Error::ResourceLimit
  );
  let owner = owners[0];
  let mut handles = vec![];
  for _ in 0..128 {
    handles.push(broker.open(owner, space.clone()).await.unwrap());
  }
  assert_eq!(
    broker.open(owner, space.clone()).await.unwrap_err(),
    Error::ResourceLimit
  );
  broker.close(owner, handles.pop().unwrap()).await.unwrap();
  broker.open(owner, space.clone()).await.unwrap();
  for owner in owners {
    broker.revoke_owner(owner).await.unwrap();
  }
  let owner = broker.register_owner(vec![space.clone()]).await.unwrap();
  broker.open(owner, space).await.unwrap();
  broker.revoke_owner(owner).await.unwrap();
}
