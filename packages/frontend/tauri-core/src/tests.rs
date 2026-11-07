use super::*;
use std::time::Duration;
use y_octo::DocOptions;

struct Fixture(PathBuf);
impl Fixture {
  fn new() -> Self {
    Self(std::env::temp_dir().join(format!("affine-tauri-cancellation-{}", Uuid::new_v4())))
  }
}
impl Drop for Fixture {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}
fn key() -> SpaceKey {
  SpaceKey {
    peer: "local".into(),
    space_type: SpaceType::Workspace,
    id: "workspace".into(),
  }
}
fn update() -> Vec<u8> {
  let doc = DocOptions::new().with_guid("doc".into()).build();
  doc
    .get_or_create_text("content")
    .unwrap()
    .insert(0, "committed after cancellation")
    .unwrap();
  doc.encode_update_v1().unwrap()
}
async fn queued(broker: &StorageBroker, expected: usize) {
  tokio::time::timeout(Duration::from_secs(3), async {
    while broker.writes.available_permits() != expected {
      tokio::task::yield_now().await;
    }
  })
  .await
  .unwrap();
}

#[tokio::test]
async fn accepted_write_finishes_and_publishes_when_the_awaiting_caller_is_cancelled() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let owner = broker.register_owner(vec![key()]).await.unwrap();
  let writer = broker.open(owner, key()).await.unwrap();
  let reader = broker.open(owner, key()).await.unwrap();
  let mut snapshot = broker.snapshot(owner, reader).await.unwrap();
  let space = {
    let state = broker.state.read().await;
    StorageBroker::authorized(&state, owner, writer).unwrap()
  };
  let held = space.connection.lock().await;
  let host = Arc::clone(&broker);
  let caller = tokio::spawn(async move { host.push_update(owner, writer, "doc".into(), update()).await });
  queued(&broker, 63).await;
  caller.abort();
  assert!(caller.await.unwrap_err().is_cancelled());
  drop(held);
  let event = tokio::time::timeout(Duration::from_secs(3), snapshot.subscription.recv())
    .await
    .unwrap()
    .unwrap();
  assert_eq!(event.revision, 1);
  let record = broker.get_doc(owner, reader, "doc".into()).await.unwrap().unwrap();
  assert!(!record.data.is_empty());
  broker.revoke_owner(owner).await.unwrap();
}

#[tokio::test]
async fn queued_write_budget_is_bounded_even_when_callers_cancel() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let owner = broker.register_owner(vec![key()]).await.unwrap();
  let handle = broker.open(owner, key()).await.unwrap();
  let space = {
    let state = broker.state.read().await;
    StorageBroker::authorized(&state, owner, handle).unwrap()
  };
  let held = space.connection.lock().await;
  let mut callers = vec![];
  for _ in 0..64 {
    let broker = Arc::clone(&broker);
    callers.push(tokio::spawn(async move {
      broker.push_update(owner, handle, "doc".into(), update()).await
    }));
  }
  queued(&broker, 0).await;
  assert!(matches!(
    broker.push_update(owner, handle, "doc".into(), update()).await,
    Err(Error::ResourceLimit)
  ));
  for caller in callers {
    caller.abort();
    let _ = caller.await;
  }
  assert_eq!(
    broker.writes.available_permits(),
    0,
    "cancelled callers must not release in-flight write permits"
  );
  drop(held);
  queued(&broker, 64).await;
  let snapshot = broker.snapshot(owner, handle).await.unwrap();
  assert_eq!(snapshot.revision, 64);
  broker.revoke_owner(owner).await.unwrap();
}

#[tokio::test]
async fn owner_revocation_waits_for_inflight_writes_then_denies_further_access() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let owner = broker.register_owner(vec![key()]).await.unwrap();
  let handle = broker.open(owner, key()).await.unwrap();
  let space = {
    let state = broker.state.read().await;
    StorageBroker::authorized(&state, owner, handle).unwrap()
  };
  let held = space.connection.lock().await;
  let host = Arc::clone(&broker);
  let writing = tokio::spawn(async move { host.push_update(owner, handle, "doc".into(), update()).await });
  // Confirm authorization lock acquisition before starting revocation.
  tokio::time::timeout(Duration::from_secs(3), async {
    while broker.state.try_write().is_ok() {
      tokio::task::yield_now().await;
    }
  })
  .await
  .unwrap();
  let host = Arc::clone(&broker);
  let revoking = tokio::spawn(async move { host.revoke_owner(owner).await });
  tokio::task::yield_now().await;
  assert!(!revoking.is_finished());
  drop(held);
  writing.await.unwrap().unwrap();
  revoking.await.unwrap().unwrap();
  assert!(matches!(
    broker.get_doc(owner, handle, "doc".into()).await,
    Err(Error::Unauthorized)
  ));
  let next = broker.register_owner(vec![key()]).await.unwrap();
  let reopened = broker.open(next, key()).await.unwrap();
  assert!(broker.get_doc(next, reopened, "doc".into()).await.unwrap().is_some());
  broker.revoke_owner(next).await.unwrap();
}

#[tokio::test]
async fn in_flight_byte_budget_prevents_large_queued_requests_from_exceeding_64_mib() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let owner = broker.register_owner(vec![key()]).await.unwrap();
  let handle = broker.open(owner, key()).await.unwrap();
  let space = {
    let state = broker.state.read().await;
    StorageBroker::authorized(&state, owner, handle).unwrap()
  };
  let held = space.connection.lock().await;
  let mut callers = vec![];
  for _ in 0..4 {
    let broker = Arc::clone(&broker);
    callers.push(tokio::spawn(async move {
      broker
        .push_update(owner, handle, "doc".into(), vec![0; MAX_UPDATE_BYTES])
        .await
    }));
  }
  tokio::time::timeout(Duration::from_secs(3), async {
    while broker.write_bytes.available_permits() != 0 {
      tokio::task::yield_now().await;
    }
  })
  .await
  .unwrap();
  assert!(matches!(
    broker.push_update(owner, handle, "doc".into(), update()).await,
    Err(Error::ResourceLimit)
  ));
  drop(held);
  for caller in callers {
    let _ = caller.await.unwrap();
  }
  assert_eq!(broker.write_bytes.available_permits(), 1024);
  broker.revoke_owner(owner).await.unwrap();
}
