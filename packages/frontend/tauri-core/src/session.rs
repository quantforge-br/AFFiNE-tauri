//! Host-only fixed-scope session. No renderer command or serializable authority is introduced.
use std::sync::{Arc, Mutex};

use tokio::{
  runtime::Handle,
  sync::{OwnedSemaphorePermit, Semaphore, watch},
  task::JoinHandle,
};

use crate::{
  DocClock, DocRecord, Error, MAX_UPDATE_BYTES, OwnerId, Result, SpaceKey, StorageBroker, StorageHandle,
  valid_identifier,
};

const MAX_CALLS: u32 = 64;
const BYTE_UNIT: usize = 65536;
const BYTE_PERMITS: u32 = 1024;

/// A native host creates a session from trusted grants, never from IPC-selected ownership.
/// Explicitly await close before destroying the runtime; Drop only starts best-effort cleanup.
pub struct StorageSession {
  inner: Arc<SessionInner>,
}

struct SessionInner {
  broker: Arc<StorageBroker>,
  owner: OwnerId,
  handle: StorageHandle,
  runtime: Handle,
  closing: Mutex<bool>,
  completion: watch::Sender<Option<Result<()>>>,
  calls: Arc<Semaphore>,
  bytes: Arc<Semaphore>,
}

impl StorageSession {
  /// Creates a dedicated host owner and one lease for a trusted, fixed space.
  /// Construction continues if its awaiting caller is cancelled. An abandoned result closes itself.
  pub async fn open(broker: Arc<StorageBroker>, key: SpaceKey) -> Result<Arc<Self>> {
    Self::spawn_open(broker, key).await.map_err(|_| Error::Task)?
  }

  fn spawn_open(broker: Arc<StorageBroker>, key: SpaceKey) -> JoinHandle<Result<Arc<Self>>> {
    tokio::spawn(async move {
      let owner = broker.register_owner(vec![key.clone()]).await?;
      let handle = match broker.open(owner, key).await {
        Ok(handle) => handle,
        Err(error) => {
          broker.revoke_owner(owner).await?;
          return Err(error);
        }
      };
      let (completion, _) = watch::channel(None);
      Ok(Arc::new(Self {
        inner: Arc::new(SessionInner {
          broker,
          owner,
          handle,
          runtime: Handle::current(),
          closing: Mutex::new(false),
          completion,
          calls: Arc::new(Semaphore::new(MAX_CALLS as usize)),
          bytes: Arc::new(Semaphore::new(BYTE_PERMITS as usize)),
        }),
      }))
    })
  }

  /// Accepted work owns its admission permits until the native operation actually finishes.
  /// Cancelling this future does not roll back or abandon an already accepted operation.
  pub async fn get_doc(&self, doc_id: String) -> Result<Option<DocRecord>> {
    if !valid_identifier(&doc_id) {
      return Err(Error::InvalidInput);
    }
    let permits = self.inner.accept(0)?;
    let inner = Arc::clone(&self.inner);
    self
      .inner
      .runtime
      .spawn(async move {
        let _permits = permits;
        inner.broker.get_doc(inner.owner, inner.handle, doc_id).await
      })
      .await
      .map_err(|_| Error::Task)?
  }

  pub async fn push_update(&self, doc_id: String, data: Vec<u8>) -> Result<DocClock> {
    if !valid_identifier(&doc_id) || data.is_empty() || data.len() > MAX_UPDATE_BYTES {
      return Err(Error::InvalidInput);
    }
    let permits = self.inner.accept(data.len())?;
    let inner = Arc::clone(&self.inner);
    self
      .inner
      .runtime
      .spawn(async move {
        let _permits = permits;
        inner.broker.push_update(inner.owner, inner.handle, doc_id, data).await
      })
      .await
      .map_err(|_| Error::Task)?
  }

  /// Idempotent shared completion: stop admission, drain accepted work, then revoke this session's owner.
  /// Cancelling a close waiter does not cancel cleanup; failures remain visible to later waiters.
  pub async fn close(&self) -> Result<()> {
    let mut completion = self.inner.begin_close()?;
    loop {
      if let Some(result) = *completion.borrow_and_update() {
        return result;
      }
      completion.changed().await.map_err(|_| Error::Task)?;
    }
  }
}

impl SessionInner {
  fn accept(&self, bytes: usize) -> Result<(OwnedSemaphorePermit, Option<OwnedSemaphorePermit>)> {
    // Admission and closing transition share a synchronous gate. Never hold it across await.
    let closing = self.closing.lock().map_err(|_| Error::Task)?;
    if *closing {
      return Err(Error::Closed);
    }
    let call = Arc::clone(&self.calls)
      .try_acquire_owned()
      .map_err(|_| Error::ResourceLimit)?;
    let bytes = if bytes == 0 {
      None
    } else {
      Some(
        Arc::clone(&self.bytes)
          .try_acquire_many_owned(bytes.div_ceil(BYTE_UNIT) as u32)
          .map_err(|_| Error::ResourceLimit)?,
      )
    };
    Ok((call, bytes))
  }

  fn begin_close(self: &Arc<Self>) -> Result<watch::Receiver<Option<Result<()>>>> {
    let mut closing = self.closing.lock().map_err(|_| Error::Task)?;
    let completion = self.completion.subscribe();
    if !*closing {
      *closing = true;
      let inner = Arc::clone(self);
      let worker = self.runtime.spawn(async move {
        // All accepted calls hold one permit, including calls whose external waiter was cancelled.
        let _drained = Arc::clone(&inner.calls)
          .acquire_many_owned(MAX_CALLS)
          .await
          .map_err(|_| Error::Task)?;
        inner.broker.revoke_owner(inner.owner).await
      });
      let notification = self.completion.clone();
      self.runtime.spawn(async move {
        let result = worker.await.unwrap_or(Err(Error::Task));
        notification.send_replace(Some(result));
      });
    }
    Ok(completion)
  }
}

impl Drop for StorageSession {
  fn drop(&mut self) {
    // Explicit close is the host contract. Runtime termination cannot be repaired by an async Drop.
    let _ = self.inner.begin_close();
  }
}

#[cfg(test)]
mod tests;
