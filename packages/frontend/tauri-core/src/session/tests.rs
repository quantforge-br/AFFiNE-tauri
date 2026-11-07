use std::{path::PathBuf, time::Duration};

use y_octo::DocOptions;

use super::*;
use crate::SpaceType;

struct Fixture(PathBuf);
impl Fixture {
  fn new() -> Self {
    Self(std::env::temp_dir().join(format!("affine-tauri-session-{}", uuid::Uuid::new_v4())))
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
    id: "session".into(),
  }
}
fn update() -> Vec<u8> {
  let doc = DocOptions::new().with_guid("doc".into()).build();
  doc
    .get_or_create_text("content")
    .unwrap()
    .insert(0, "session café 東京 🦀")
    .unwrap();
  doc.encode_update_v1().unwrap()
}
async fn admitted(session: &StorageSession, permits: usize) {
  tokio::time::timeout(Duration::from_secs(3), async {
    while session.inner.calls.available_permits() != permits {
      tokio::task::yield_now().await;
    }
  })
  .await
  .unwrap();
}
async fn closing(session: &StorageSession) {
  tokio::time::timeout(Duration::from_secs(3), async {
    while !*session.inner.closing.lock().unwrap() {
      tokio::task::yield_now().await;
    }
  })
  .await
  .unwrap();
}
async fn space(session: &StorageSession) -> Arc<crate::Space> {
  let state = session.inner.broker.state.read().await;
  StorageBroker::authorized(&state, session.inner.owner, session.inner.handle).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_drains_cancelled_accepted_write_before_revocation_and_publishes() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let session = StorageSession::open(Arc::clone(&broker), key()).await.unwrap();
  let observer = broker.register_owner(vec![key()]).await.unwrap();
  let lease = broker.open(observer, key()).await.unwrap();
  let mut snapshot = broker.snapshot(observer, lease).await.unwrap();
  let shared = space(&session).await;
  let held = shared.connection.lock().await;
  let writer = Arc::clone(&session);
  let writing = tokio::spawn(async move { writer.push_update("doc".into(), update()).await });
  admitted(&session, 63).await;
  writing.abort();
  assert!(writing.await.unwrap_err().is_cancelled());
  let closer = Arc::clone(&session);
  let close = tokio::spawn(async move { closer.close().await });
  closing(&session).await;
  assert!(!close.is_finished());
  assert_eq!(session.get_doc("doc".into()).await.unwrap_err(), Error::Closed);
  assert_eq!(
    session.push_update("doc".into(), update()).await.unwrap_err(),
    Error::Closed
  );
  drop(held);
  tokio::time::timeout(Duration::from_secs(3), close)
    .await
    .unwrap()
    .unwrap()
    .unwrap();
  let event = tokio::time::timeout(Duration::from_secs(3), snapshot.subscription.recv())
    .await
    .unwrap()
    .unwrap();
  assert_eq!(event.revision, 1);
  assert!(broker.get_doc(observer, lease, "doc".into()).await.unwrap().is_some());
  assert_eq!(session.inner.calls.available_permits(), MAX_CALLS as usize);
  assert!(!broker.state.read().await.owners.contains_key(&session.inner.owner));
  broker.revoke_owner(observer).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_waiter_cancellation_does_not_cancel_shared_cleanup_or_reopen_admission() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let session = StorageSession::open(Arc::clone(&broker), key()).await.unwrap();
  let shared = space(&session).await;
  let held = shared.connection.lock().await;
  let reader = Arc::clone(&session);
  let reading = tokio::spawn(async move { reader.get_doc("missing".into()).await });
  admitted(&session, 63).await;
  let closer = Arc::clone(&session);
  let cancelled = tokio::spawn(async move { closer.close().await });
  closing(&session).await;
  cancelled.abort();
  assert!(cancelled.await.unwrap_err().is_cancelled());
  assert_eq!(session.get_doc("missing".into()).await.unwrap_err(), Error::Closed);
  drop(held);
  assert!(reading.await.unwrap().unwrap().is_none());
  let (first, second) = tokio::join!(session.close(), session.close());
  first.unwrap();
  second.unwrap();
  session.close().await.unwrap();
  assert!(broker.state.read().await.owners.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_reads_keep_their_admission_until_actual_completion() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let session = StorageSession::open(broker, key()).await.unwrap();
  let shared = space(&session).await;
  let held = shared.connection.lock().await;
  let mut readers = vec![];
  for _ in 0..MAX_CALLS {
    let reader = Arc::clone(&session);
    readers.push(tokio::spawn(async move { reader.get_doc("missing".into()).await }));
  }
  admitted(&session, 0).await;
  for reader in readers {
    reader.abort();
    assert!(reader.await.unwrap_err().is_cancelled());
  }
  assert_eq!(
    session.get_doc("missing".into()).await.unwrap_err(),
    Error::ResourceLimit
  );
  assert_eq!(session.inner.calls.available_permits(), 0);
  drop(held);
  admitted(&session, MAX_CALLS as usize).await;
  session.close().await.unwrap();
}

#[tokio::test]
async fn session_bytes_stay_bounded_until_cancelled_work_settles() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let session = StorageSession::open(broker, key()).await.unwrap();
  let shared = space(&session).await;
  let held = shared.connection.lock().await;
  let mut writers = vec![];
  for _ in 0..4 {
    let writer = Arc::clone(&session);
    writers.push(tokio::spawn(async move {
      writer.push_update("doc".into(), vec![0; MAX_UPDATE_BYTES]).await
    }));
  }
  admitted(&session, 60).await;
  assert_eq!(session.inner.bytes.available_permits(), 0);
  for writer in writers {
    writer.abort();
    assert!(writer.await.unwrap_err().is_cancelled());
  }
  assert_eq!(
    session.push_update("doc".into(), update()).await.unwrap_err(),
    Error::ResourceLimit
  );
  assert_eq!(session.inner.bytes.available_permits(), 0);
  drop(held);
  admitted(&session, MAX_CALLS as usize).await;
  assert_eq!(session.inner.bytes.available_permits(), BYTE_PERMITS as usize);
  session.close().await.unwrap();
}

#[tokio::test]
async fn close_failure_is_stable_for_every_waiter() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let session = StorageSession::open(Arc::clone(&broker), key()).await.unwrap();
  // Host-only external revocation is a real native failure for this session's later close.
  broker.revoke_owner(session.inner.owner).await.unwrap();
  let (first, second) = tokio::join!(session.close(), session.close());
  assert_eq!(first, Err(Error::Unauthorized));
  assert_eq!(second, first);
  assert_eq!(session.close().await, first);
  assert_eq!(session.get_doc("doc".into()).await.unwrap_err(), Error::Closed);
}

#[tokio::test]
async fn abandoned_open_result_revokes_its_new_owner_without_a_renderer() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let held = broker.state.write().await;
  let opening = StorageSession::spawn_open(Arc::clone(&broker), key());
  drop(opening);
  drop(held);
  tokio::time::timeout(Duration::from_secs(3), async {
    loop {
      // The detached opening task and its cleanup retain broker references until they finish.
      let state = broker.state.read().await;
      if state.owners.is_empty() && state.leases.is_empty() && Arc::strong_count(&broker) == 1 {
        break;
      }
      drop(state);
      tokio::task::yield_now().await;
    }
  })
  .await
  .unwrap();
}

#[tokio::test]
async fn failed_open_cleans_up_its_registered_owner() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let unsafe_database = fixture.0.join(key().filename());
  tokio::fs::create_dir(&unsafe_database).await.unwrap();
  assert!(matches!(
    StorageSession::open(Arc::clone(&broker), key()).await,
    Err(Error::UnsafePath)
  ));
  let state = broker.state.read().await;
  assert!(state.owners.is_empty());
  assert!(state.leases.is_empty());
  assert!(state.spaces.is_empty());
}

#[tokio::test]
async fn dropping_last_session_reference_starts_cleanup_after_accepted_work() {
  let fixture = Fixture::new();
  let broker = StorageBroker::new(fixture.0.clone()).await.unwrap();
  let session = StorageSession::open(Arc::clone(&broker), key()).await.unwrap();
  let observer = broker.register_owner(vec![key()]).await.unwrap();
  let lease = broker.open(observer, key()).await.unwrap();
  let owner = session.inner.owner;
  let shared = space(&session).await;
  let held = shared.connection.lock().await;
  let writer = Arc::clone(&session);
  let writing = tokio::spawn(async move { writer.push_update("doc".into(), update()).await });
  admitted(&session, 63).await;
  writing.abort();
  assert!(writing.await.unwrap_err().is_cancelled());
  let mut completion = session.inner.completion.subscribe();
  drop(session);
  assert!(completion.borrow().is_none());
  drop(held);
  tokio::time::timeout(Duration::from_secs(3), async {
    loop {
      if let Some(result) = *completion.borrow_and_update() {
        result.unwrap();
        break;
      }
      completion.changed().await.unwrap();
    }
  })
  .await
  .unwrap();
  assert!(!broker.state.read().await.owners.contains_key(&owner));
  let record = broker.get_doc(observer, lease, "doc".into()).await.unwrap().unwrap();
  let mut doc = DocOptions::new().with_guid("doc".into()).build();
  doc.apply_update_from_binary_v1(&record.data).unwrap();
  assert_eq!(
    doc.get_or_create_text("content").unwrap().to_string(),
    "session café 東京 🦀"
  );
  broker.revoke_owner(observer).await.unwrap();
}
