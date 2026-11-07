//! Host-owned storage authority. This crate has no WebView or command registration.
//! The host must derive owners from trusted windows; never deserialize an owner from IPC.
use std::{
  collections::{HashMap, HashSet},
  path::{Path, PathBuf},
  sync::{Arc, Weak},
};

use affine_nbstore::storage::SqliteDocStorage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock, Semaphore, broadcast, watch};
use uuid::Uuid;

#[cfg(test)]
mod tests;

mod session;
pub use session::StorageSession;

const MAX_IDENTIFIER_BYTES: usize = 2048;
const MAX_OWNERS: usize = 128;
const MAX_GRANTS: usize = 128;
const MAX_OPEN_SPACES: usize = 256;
const MAX_UPDATE_BYTES: usize = 16 * 1024 * 1024;
const EVENT_CAPACITY: usize = 128;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct OwnerId(Uuid);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct StorageHandle(Uuid);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpaceType {
  Workspace,
  Userspace,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SpaceKey {
  pub peer: String,
  pub space_type: SpaceType,
  pub id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Error {
  #[error("invalid input")]
  InvalidInput,
  #[error("owner is not authorized")]
  Unauthorized,
  #[error("storage handle is closed or belongs to another owner")]
  InvalidHandle,
  #[error("resource limit reached")]
  ResourceLimit,
  #[error("unsafe storage path")]
  UnsafePath,
  #[error("storage directory is already in use")]
  StorageInUse,
  #[error("storage operation failed")]
  Storage,
  #[error("storage event stream requires a new snapshot")]
  ResyncRequired,
  #[error("storage operation task failed")]
  Task,
  #[error("storage session is closed")]
  Closed,
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRecord {
  pub doc_id: String,
  pub timestamp_ms: i64,
  pub data: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocClock {
  pub doc_id: String,
  pub timestamp_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEvent {
  pub revision: u64,
  pub doc_id: String,
  pub timestamp_ms: i64,
  #[serde(skip)]
  source: StorageHandle,
}

pub struct Snapshot {
  pub revision: u64,
  pub clocks: Vec<DocClock>,
  pub subscription: Subscription,
}

struct Owner {
  grants: HashSet<SpaceKey>,
  lifecycle: watch::Sender<u64>,
}
struct Lease {
  owner: OwnerId,
  key: SpaceKey,
}
struct Connection {
  storage: SqliteDocStorage,
  revision: u64,
}
struct Space {
  connection: Mutex<Connection>,
  events: broadcast::Sender<StorageEvent>,
}
#[derive(Default)]
struct State {
  owners: HashMap<OwnerId, Owner>,
  leases: HashMap<StorageHandle, Lease>,
  spaces: HashMap<SpaceKey, Arc<Space>>,
}

pub struct StorageBroker {
  root: PathBuf,
  state: RwLock<State>,
  writes: Arc<Semaphore>,
  write_bytes: Arc<Semaphore>,
  _root_lock: std::fs::File,
}

fn valid_identifier(value: &str) -> bool {
  !value.is_empty() && value.len() <= MAX_IDENTIFIER_BYTES && !value.chars().any(char::is_control)
}
impl SpaceKey {
  fn validate(&self) -> Result<()> {
    if valid_identifier(&self.peer) && valid_identifier(&self.id) {
      Ok(())
    } else {
      Err(Error::InvalidInput)
    }
  }
  fn filename(&self) -> String {
    let mut hash = Sha256::new();
    for value in [
      self.peer.as_str(),
      match self.space_type {
        SpaceType::Workspace => "workspace",
        SpaceType::Userspace => "userspace",
      },
      self.id.as_str(),
    ] {
      hash.update((value.len() as u64).to_be_bytes());
      hash.update(value.as_bytes());
    }
    format!(
      "{}.db",
      hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
    )
  }
}
async fn reject_special_path(path: &Path, directory: bool) -> Result<()> {
  match tokio::fs::symlink_metadata(path).await {
    Ok(meta) if !meta.file_type().is_symlink() && if directory { meta.is_dir() } else { meta.is_file() } => Ok(()),
    Ok(_) => Err(Error::UnsafePath),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(_) => Err(Error::Storage),
  }
}

impl StorageBroker {
  /// The host supplies a private application directory, never a renderer-controlled path.
  /// This does not import or migrate an existing Electron profile.
  pub async fn new(root: PathBuf) -> Result<Arc<Self>> {
    reject_special_path(&root, true).await?;
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(&root).await.map_err(|_| Error::Storage)?;
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let mode = tokio::fs::metadata(&root)
        .await
        .map_err(|_| Error::Storage)?
        .permissions()
        .mode();
      if mode & 0o077 != 0 {
        return Err(Error::UnsafePath);
      }
    }
    let root = tokio::fs::canonicalize(root).await.map_err(|_| Error::Storage)?;

    let lock_path = root.join(".host.lock");
    reject_special_path(&lock_path, false).await?;
    let root_lock = tokio::task::spawn_blocking(move || {
      let mut options = std::fs::OpenOptions::new();
      options.read(true).write(true).create(true).truncate(false);
      #[cfg(unix)]
      {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
      }
      let file = options.open(lock_path).map_err(|_| Error::Storage)?;
      file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => Error::StorageInUse,
        std::fs::TryLockError::Error(_) => Error::Storage,
      })?;
      Ok(file)
    })
    .await
    .map_err(|_| Error::Task)??;
    Ok(Arc::new(Self {
      root,
      state: RwLock::new(State::default()),
      writes: Arc::new(Semaphore::new(64)),
      write_bytes: Arc::new(Semaphore::new(1024)),
      _root_lock: root_lock,
    }))
  }

  /// Host-only authorization. No serialized owner or caller-selected window label is accepted.
  pub async fn register_owner(&self, grants: Vec<SpaceKey>) -> Result<OwnerId> {
    if grants.is_empty() || grants.len() > MAX_GRANTS {
      return Err(Error::InvalidInput);
    }
    for key in &grants {
      key.validate()?;
    }
    let mut state = self.state.write().await;
    if state.owners.len() >= MAX_OWNERS {
      return Err(Error::ResourceLimit);
    }
    let id = OwnerId(Uuid::new_v4());
    let (lifecycle, _) = watch::channel(0);
    state.owners.insert(
      id,
      Owner {
        grants: grants.into_iter().collect(),
        lifecycle,
      },
    );
    Ok(id)
  }

  pub async fn open(&self, owner: OwnerId, key: SpaceKey) -> Result<StorageHandle> {
    key.validate()?;
    // Lifecycle writes exclude active operations; operations on distinct open spaces remain concurrent.
    let mut state = self.state.write().await;
    let authority = state.owners.get(&owner).ok_or(Error::Unauthorized)?;
    if !authority.grants.contains(&key) {
      return Err(Error::Unauthorized);
    }
    if state.leases.values().filter(|lease| lease.owner == owner).count() >= MAX_GRANTS {
      return Err(Error::ResourceLimit);
    }
    if !state.spaces.contains_key(&key) {
      if state.spaces.len() >= MAX_OPEN_SPACES {
        return Err(Error::ResourceLimit);
      }
      let database = self.root.join(key.filename());
      for suffix in ["", "-wal", "-shm", "-journal"] {
        reject_special_path(&PathBuf::from(format!("{}{suffix}", database.display())), false).await?;
      }
      let storage = SqliteDocStorage::new(database.to_str().ok_or(Error::UnsafePath)?.to_owned());
      if storage.connect().await.is_err() {
        storage.close().await;
        return Err(Error::Storage);
      }
      if storage.set_space_id(key.id.clone()).await.is_err() {
        storage.close().await;
        return Err(Error::Storage);
      }
      let (events, _) = broadcast::channel(EVENT_CAPACITY);
      state.spaces.insert(
        key.clone(),
        Arc::new(Space {
          connection: Mutex::new(Connection { storage, revision: 0 }),
          events,
        }),
      );
    }
    let handle = StorageHandle(Uuid::new_v4());
    state.leases.insert(handle, Lease { owner, key });
    Ok(handle)
  }

  fn authorized(state: &State, owner: OwnerId, handle: StorageHandle) -> Result<Arc<Space>> {
    let authority = state.owners.get(&owner).ok_or(Error::Unauthorized)?;
    let lease = state
      .leases
      .get(&handle)
      .filter(|lease| lease.owner == owner)
      .ok_or(Error::InvalidHandle)?;
    if !authority.grants.contains(&lease.key) {
      return Err(Error::Unauthorized);
    }
    state.spaces.get(&lease.key).cloned().ok_or(Error::InvalidHandle)
  }

  pub async fn get_doc(&self, owner: OwnerId, handle: StorageHandle, doc_id: String) -> Result<Option<DocRecord>> {
    if !valid_identifier(&doc_id) {
      return Err(Error::InvalidInput);
    }
    let state = self.state.read().await;
    let space = Self::authorized(&state, owner, handle)?;
    let connection = space.connection.lock().await;
    let record = connection.storage.get_doc(doc_id).await.map_err(|_| Error::Storage)?;
    Ok(record.map(|record| DocRecord {
      doc_id: record.doc_id,
      timestamp_ms: record.timestamp.and_utc().timestamp_millis(),
      data: record.bin,
    }))
  }

  /// Accepted writes finish independently of caller cancellation, including event publication.
  /// A cancelled caller must reconcile from a snapshot rather than assume the write was rolled back.
  pub async fn push_update(
    self: &Arc<Self>,
    owner: OwnerId,
    handle: StorageHandle,
    doc_id: String,
    data: Vec<u8>,
  ) -> Result<DocClock> {
    if !valid_identifier(&doc_id) || data.is_empty() || data.len() > MAX_UPDATE_BYTES {
      return Err(Error::InvalidInput);
    }
    let permit = Arc::clone(&self.writes)
      .try_acquire_owned()
      .map_err(|_| Error::ResourceLimit)?;
    let bytes = Arc::clone(&self.write_bytes)
      .try_acquire_many_owned(data.len().div_ceil(65536) as u32)
      .map_err(|_| Error::ResourceLimit)?;
    let broker = Arc::clone(self);
    tokio::spawn(async move {
      let _permit = permit;
      let _bytes = bytes;
      let state = broker.state.read().await;
      let space = Self::authorized(&state, owner, handle)?;
      let mut connection = space.connection.lock().await;
      let data = tokio::task::spawn_blocking(move || {
        let limits = y_octo::ReadLimits {
          max_input_bytes: MAX_UPDATE_BYTES,
          max_structs: 250_000,
          max_clients: 10_000,
          max_collection_entries: 1_000_000,
          max_any_depth: 64,
          max_content_bytes: MAX_UPDATE_BYTES,
        };
        match y_octo::ReadDoc::from_full_update_v1_with_limits(data.clone(), limits) {
          Ok(_) | Err(y_octo::ReadError::IncompleteSnapshot(_)) => Ok(data),
          Err(y_octo::ReadError::ResourceLimit(_)) => Err(Error::ResourceLimit),
          Err(_) => Err(Error::InvalidInput),
        }
      })
      .await
      .map_err(|_| Error::Task)??;
      let revision = connection.revision.checked_add(1).ok_or(Error::ResourceLimit)?;
      let timestamp = connection
        .storage
        .push_update(doc_id.clone(), data)
        .await
        .map_err(|_| Error::Storage)?;
      let timestamp_ms = timestamp.and_utc().timestamp_millis();
      connection.revision = revision;
      let _ = space.events.send(StorageEvent {
        revision,
        doc_id: doc_id.clone(),
        timestamp_ms,
        source: handle,
      });
      Ok(DocClock { doc_id, timestamp_ms })
    })
    .await
    .map_err(|_| Error::Task)?
  }

  pub async fn snapshot(self: &Arc<Self>, owner: OwnerId, handle: StorageHandle) -> Result<Snapshot> {
    let state = self.state.read().await;
    let space = Self::authorized(&state, owner, handle)?;
    let connection = space.connection.lock().await;
    // Subscribe while holding the same mutation lock as the snapshot: no fetch/subscribe gap.
    let events = space.events.subscribe();
    let lifecycle = state
      .owners
      .get(&owner)
      .ok_or(Error::Unauthorized)?
      .lifecycle
      .subscribe();
    let clocks = connection
      .storage
      .get_doc_clocks(None)
      .await
      .map_err(|_| Error::Storage)?;
    Ok(Snapshot {
      revision: connection.revision,
      clocks: clocks
        .into_iter()
        .map(|clock| DocClock {
          doc_id: clock.doc_id,
          timestamp_ms: clock.timestamp.and_utc().timestamp_millis(),
        })
        .collect(),
      subscription: Subscription {
        broker: Arc::downgrade(self),
        owner,
        handle,
        events,
        lifecycle,
        failed: false,
      },
    })
  }

  pub async fn close(&self, owner: OwnerId, handle: StorageHandle) -> Result<()> {
    let mut state = self.state.write().await;
    Self::authorized(&state, owner, handle)?;
    let lease = state.leases.remove(&handle).ok_or(Error::InvalidHandle)?;
    if let Some(authority) = state.owners.get(&owner) {
      authority
        .lifecycle
        .send_modify(|revision| *revision = revision.wrapping_add(1));
    }
    Self::close_unused(&mut state, &lease.key).await;
    Ok(())
  }

  pub async fn revoke_owner(&self, owner: OwnerId) -> Result<()> {
    let mut state = self.state.write().await;
    let authority = state.owners.remove(&owner).ok_or(Error::Unauthorized)?;
    authority
      .lifecycle
      .send_modify(|revision| *revision = revision.wrapping_add(1));
    let keys: HashSet<_> = state
      .leases
      .values()
      .filter(|lease| lease.owner == owner)
      .map(|lease| lease.key.clone())
      .collect();
    state.leases.retain(|_, lease| lease.owner != owner);
    for key in keys {
      Self::close_unused(&mut state, &key).await;
    }
    Ok(())
  }

  async fn close_unused(state: &mut State, key: &SpaceKey) {
    if state.leases.values().any(|lease| &lease.key == key) {
      return;
    }
    if let Some(space) = state.spaces.remove(key) {
      space.connection.lock().await.storage.close().await;
    }
  }
}

pub struct Subscription {
  broker: Weak<StorageBroker>,
  owner: OwnerId,
  handle: StorageHandle,
  events: broadcast::Receiver<StorageEvent>,
  lifecycle: watch::Receiver<u64>,
  failed: bool,
}
impl Subscription {
  async fn authorize(&self) -> Result<()> {
    let broker = self.broker.upgrade().ok_or(Error::Unauthorized)?;
    let state = broker.state.read().await;
    StorageBroker::authorized(&state, self.owner, self.handle)?;
    Ok(())
  }
  pub async fn recv(&mut self) -> Result<StorageEvent> {
    if self.failed {
      return Err(Error::ResyncRequired);
    }
    self.authorize().await?;
    loop {
      tokio::select! {
        changed = self.lifecycle.changed() => {
          changed.map_err(|_| Error::Unauthorized)?;
          self.authorize().await?;
        }
        event = self.events.recv() => {
          self.authorize().await?;
          let event = match event { Ok(event) => event, Err(_) => { self.failed = true; return Err(Error::ResyncRequired); } };
          if event.source != self.handle { return Ok(event); }
        }
      }
    }
  }
}
