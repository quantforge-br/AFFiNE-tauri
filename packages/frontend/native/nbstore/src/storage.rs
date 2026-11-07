use std::sync::Arc;

use affine_schema::{
  get_migrator,
  import_validation::{V2_IMPORT_SCHEMA_RULES, validate_import_schema, validate_required_schema},
};
use sqlx::{
  Pool, Row,
  migrate::{Migration, Migrator},
  sqlite::{Sqlite, SqliteConnectOptions, SqlitePoolOptions},
};

use super::{error::Result, indexer::IndexManager};

pub struct SqliteDocStorage {
  pub pool: Pool<Sqlite>,
  path: String,
  pub indexes: Arc<IndexManager>,
}

impl SqliteDocStorage {
  pub fn new(path: String) -> Self {
    let sqlite_options = SqliteConnectOptions::new()
      .filename(&path)
      .create_if_missing(true)
      .foreign_keys(false);

    let mut pool_options = SqlitePoolOptions::new();

    let indexes = Arc::new(IndexManager::new());

    if path == ":memory:" {
      pool_options = pool_options
        .min_connections(1)
        .max_connections(1)
        .idle_timeout(None)
        .max_lifetime(None);

      Self {
        pool: pool_options.connect_lazy_with(sqlite_options),
        path,
        indexes,
      }
    } else {
      Self {
        pool: pool_options
          .max_connections(4)
          .connect_lazy_with(sqlite_options.journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)),
        path,
        indexes,
      }
    }
  }

  pub async fn validate(&self) -> Result<bool> {
    if self.path == ":memory:" {
      return Ok(validate_required_schema(&self.pool, &V2_IMPORT_SCHEMA_RULES).await?);
    }

    let Ok(pool) = self.open_readonly_pool().await else {
      return Ok(false);
    };

    let result = validate_required_schema(&pool, &V2_IMPORT_SCHEMA_RULES).await;
    Self::close_pool(&pool).await;
    Ok(result?)
  }

  pub async fn validate_import_schema(&self) -> Result<bool> {
    if self.path == ":memory:" {
      return Ok(validate_import_schema(&self.pool, &V2_IMPORT_SCHEMA_RULES).await?);
    }

    let Ok(pool) = self.open_readonly_pool().await else {
      return Ok(false);
    };

    let result = validate_import_schema(&pool, &V2_IMPORT_SCHEMA_RULES).await;
    Self::close_pool(&pool).await;
    Ok(result?)
  }

  pub async fn connect(&self) -> Result<()> {
    // The pool opens literal filesystem paths. URL helpers misparse Windows verbatim prefixes,
    // query characters and percent escapes; the configured pool creates missing files instead.

    self.migrate().await?;
    self.init_index().await?;

    Ok(())
  }

  async fn migrate(&self) -> Result<()> {
    let migrator = get_migrator();
    if let Err(err) = migrator.run(&self.pool).await {
      // Compatibility: migration 3 (`add_idx_snapshots`) had a whitespace-only
      // SQL change (trailing space) between releases, which causes sqlx
      // to reject existing DBs with: `VersionMismatch(3)`. It's safe to
      // fix by updating the stored checksum.
      if matches!(err, sqlx::migrate::MigrateError::VersionMismatch(3))
        && self.try_repair_migration_3_checksum(&migrator).await?
      {
        migrator.run(&self.pool).await?;
      } else {
        return Err(err.into());
      }
    }

    Ok(())
  }

  async fn try_repair_migration_3_checksum(&self, migrator: &Migrator) -> Result<bool> {
    let Some(migration) = migrator.iter().find(|m| m.version == 3) else {
      return Ok(false);
    };

    // We're only prepared to repair the known `add_idx_snapshots`
    // whitespace-only mismatch.
    if migration.description.as_ref() != "add_idx_snapshots" {
      return Ok(false);
    }

    let row = sqlx::query("SELECT description, checksum FROM _sqlx_migrations WHERE version = 3")
      .fetch_optional(&self.pool)
      .await?;

    let Some(row) = row else {
      return Ok(false);
    };

    let applied_description: String = row.try_get("description")?;
    if applied_description != migration.description.as_ref() {
      return Ok(false);
    }

    let applied_checksum: Vec<u8> = row.try_get("checksum")?;
    let expected_checksum = migration.checksum.as_ref();

    // sqlx computes the checksum as SHA-384 of the raw SQL bytes. The legacy
    // variant had an extra trailing space at the end of the SQL string (after
    // the final newline).
    let legacy_sql = format!("{} ", migration.sql);
    let legacy_migration = Migration::new(
      migration.version,
      migration.description.clone(),
      migration.migration_type,
      std::borrow::Cow::Owned(legacy_sql),
      migration.no_tx,
    );

    if applied_checksum.as_slice() != legacy_migration.checksum.as_ref() {
      return Ok(false);
    }

    sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = 3")
      .bind(expected_checksum)
      .execute(&self.pool)
      .await?;

    Ok(true)
  }

  pub async fn close(&self) {
    Self::close_pool(&self.pool).await
  }

  pub(crate) async fn close_pool(pool: &Pool<Sqlite>) {
    // SQLx 0.8 can return from close after a concurrent return task requeues a connection.
    // Once marked closed, no new acquisitions can succeed. Drain those late returns too.
    while {
      pool.close().await;
      pool.size() != 0
    } {}
  }

  pub fn is_closed(&self) -> bool {
    self.pool.is_closed()
  }

  ///
  /// Flush the WAL file to the database file.
  /// See https://www.sqlite.org/pragma.html#pragma_wal_checkpoint:~:text=PRAGMA%20schema.wal_checkpoint%3B
  pub async fn checkpoint(&self) -> Result<()> {
    sqlx::query("PRAGMA wal_checkpoint(FULL);").execute(&self.pool).await?;

    Ok(())
  }

  pub async fn vacuum_into(&self, path: String) -> Result<()> {
    if self.path == ":memory:" {
      sqlx::query("VACUUM INTO ?;").bind(path).execute(&self.pool).await?;
      return Ok(());
    }

    let pool = self.open_readonly_pool().await?;
    let result = sqlx::query("VACUUM INTO ?;").bind(path).execute(&pool).await;
    Self::close_pool(&pool).await;
    result?;

    Ok(())
  }

  async fn open_readonly_pool(&self) -> Result<Pool<Sqlite>> {
    Self::open_readonly_path(&self.path).await
  }

  pub(crate) async fn open_readonly_path(path: &str) -> Result<Pool<Sqlite>> {
    let sqlite_options = SqliteConnectOptions::new()
      .filename(path)
      .foreign_keys(false)
      .read_only(true);

    Ok(
      SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(sqlite_options)
        .await?,
    )
  }
}

#[cfg(test)]
mod tests {
  use std::{borrow::Cow, fs, path::Path};

  use affine_schema::get_migrator;
  use sqlx::migrate::{Migration, Migrator};
  use uuid::Uuid;

  use super::*;

  async fn get_storage() -> SqliteDocStorage {
    let storage = SqliteDocStorage::new(":memory:".to_string());
    storage.connect().await.unwrap();

    storage
  }

  #[tokio::test]
  async fn close_waits_for_a_connection_already_being_returned() {
    let returning = Arc::new(tokio::sync::Notify::new());
    let resume = Arc::new(tokio::sync::Notify::new());
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .after_release({
        let returning = returning.clone();
        let resume = resume.clone();
        move |_, _| {
          let returning = returning.clone();
          let resume = resume.clone();
          Box::pin(async move {
            returning.notify_one();
            resume.notified().await;
            Ok(true)
          })
        }
      })
      .connect_lazy_with(SqliteConnectOptions::new().filename(":memory:"));
    drop(pool.acquire().await.unwrap());
    returning.notified().await;

    // Mark the pool closed while its return task is past SQLx's is_closed check.
    let closing = SqliteDocStorage::close_pool(&pool);
    tokio::pin!(closing);
    tokio::select! {
      biased;
      _ = &mut closing => panic!("close returned while a connection was checked out"),
      _ = std::future::ready(()) => {}
    }
    assert!(pool.is_closed());
    resume.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), closing)
      .await
      .unwrap();
    assert_eq!(pool.size(), 0, "close must await every SQLite worker");
  }

  #[tokio::test]
  async fn temporary_readonly_operations_release_files_on_success_and_error() {
    let base = std::env::temp_dir().join(format!("nbstore-readonly-close-{}", Uuid::new_v4()));
    fs::create_dir(&base).unwrap();
    let source = base.join("storage.db");
    let export = base.join("backup.affine");
    let storage = SqliteDocStorage::new(path_string(&source));
    storage.connect().await.unwrap();
    storage.close().await;
    assert_eq!(storage.pool.size(), 0);

    assert!(storage.validate().await.unwrap());
    assert_no_open_test_files(&base);
    assert!(storage.validate_import_schema().await.unwrap());
    assert_no_open_test_files(&base);
    assert!(
      SqliteDocStorage::read_doc_records_readonly(&path_string(&source), "missing")
        .await
        .unwrap()
        .snapshot
        .is_none()
    );
    assert_no_open_test_files(&base);
    assert!(
      SqliteDocStorage::read_blob_readonly(&path_string(&source), "missing")
        .await
        .unwrap()
        .is_none()
    );
    assert_no_open_test_files(&base);
    storage.vacuum_into(path_string(&export)).await.unwrap();
    assert_no_open_test_files(&base);
    assert!(storage.vacuum_into(path_string(&export)).await.is_err());
    assert_no_open_test_files(&base);

    // A valid SQLite file with missing tables exercises query-error cleanup.
    let invalid = base.join("missing-schema.db");
    fs::File::create(&invalid).unwrap();
    let invalid_storage = SqliteDocStorage::new(path_string(&invalid));
    assert!(!invalid_storage.validate().await.unwrap());
    assert_no_open_test_files(&base);
    assert!(!invalid_storage.validate_import_schema().await.unwrap());
    assert_no_open_test_files(&base);
    assert!(
      SqliteDocStorage::read_doc_records_readonly(&path_string(&invalid), "doc")
        .await
        .is_err()
    );
    assert_no_open_test_files(&base);
    assert!(
      SqliteDocStorage::read_blob_readonly(&path_string(&invalid), "blob")
        .await
        .is_err()
    );
    assert_no_open_test_files(&base);
    invalid_storage.close().await;

    // Windows must allow immediate deletion, with no delayed cleanup/retry exemption.
    fs::remove_dir_all(&base).unwrap();
  }

  fn assert_no_open_test_files(base: &Path) {
    // Unix permits unlinking open files, so deletion alone would miss a lifetime regression.
    #[cfg(target_os = "linux")]
    for entry in fs::read_dir("/proc/self/fd").unwrap() {
      if let Ok(target) = fs::read_link(entry.unwrap().path()) {
        assert!(!target.starts_with(base), "SQLite descriptor still open: {target:?}");
      }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = base;
  }

  #[tokio::test]
  async fn init_tables() {
    let storage = get_storage().await;

    sqlx::query("INSERT INTO meta (space_id) VALUES ($1);")
      .bind("test")
      .execute(&storage.pool)
      .await
      .unwrap();

    let record = sqlx::query!("SELECT space_id FROM meta;")
      .fetch_one(&storage.pool)
      .await
      .unwrap();

    assert_eq!(record.space_id, "test");
  }

  #[tokio::test]
  async fn validate_db() {
    let storage = get_storage().await;
    assert!(storage.validate().await.unwrap());

    let storage = SqliteDocStorage::new(":memory:".to_string());
    assert!(!storage.validate().await.unwrap());
  }

  #[tokio::test]
  async fn connect_repairs_whitespace_only_migration_checksum_mismatch() {
    // Simulate a DB migrated with an older `add_idx_snapshots` SQL that had a
    // trailing space.
    let storage = SqliteDocStorage::new(":memory:".to_string());

    let new_migrator = get_migrator();
    let mut migrations = new_migrator.migrations.to_vec();
    assert!(migrations.len() >= 3);

    let mig3 = migrations[2].clone();
    assert_eq!(mig3.version, 3);
    assert_eq!(mig3.description.as_ref(), "add_idx_snapshots");

    let legacy_sql = format!("{} ", mig3.sql);
    migrations[2] = Migration::new(
      mig3.version,
      mig3.description.clone(),
      mig3.migration_type,
      Cow::Owned(legacy_sql),
      mig3.no_tx,
    );

    // The legacy DB didn't have newer migrations.
    migrations.truncate(3);
    let legacy_migrator = Migrator {
      migrations: Cow::Owned(migrations),
      ..Migrator::DEFAULT
    };

    legacy_migrator.run(&storage.pool).await.unwrap();

    // Now connecting with the current code should auto-repair the checksum and
    // succeed.
    storage.connect().await.unwrap();

    let expected_checksum = get_migrator()
      .iter()
      .find(|m| m.version == 3)
      .unwrap()
      .checksum
      .as_ref()
      .to_vec();

    let row = sqlx::query("SELECT checksum FROM _sqlx_migrations WHERE version = 3")
      .fetch_one(&storage.pool)
      .await
      .unwrap();
    let checksum: Vec<u8> = row.get("checksum");

    assert_eq!(checksum, expected_checksum);
  }

  #[tokio::test]
  async fn vacuum_into_exports_a_compacted_database() {
    let base = std::env::temp_dir().join(format!("nbstore-vacuum-{}", Uuid::new_v4()));
    fs::create_dir_all(&base).unwrap();

    let source = base.join("storage.db");
    let export = base.join("backup.affine");

    let storage = SqliteDocStorage::new(path_string(&source));
    storage.connect().await.unwrap();

    storage
      .set_blob(crate::SetBlob {
        key: "large-blob".to_string(),
        data: Into::<crate::Data>::into(vec![7; 1024 * 1024]),
        mime: "application/octet-stream".to_string(),
      })
      .await
      .unwrap();
    storage.delete_blob("large-blob".to_string(), true).await.unwrap();
    storage.checkpoint().await.unwrap();

    let source_len = fs::metadata(&source).unwrap().len();
    assert!(source_len > 0);

    storage.vacuum_into(path_string(&export)).await.unwrap();

    let export_len = fs::metadata(&export).unwrap().len();
    assert!(export_len < source_len);

    let exported = SqliteDocStorage::new(path_string(&export));
    exported.connect().await.unwrap();
    assert!(exported.list_blobs().await.unwrap().is_empty());
    exported.close().await;
    storage.close().await;

    fs::remove_dir_all(base).unwrap();
  }

  #[tokio::test]
  async fn validate_import_schema_rejects_unexpected_schema_objects() {
    let base = std::env::temp_dir().join(format!("nbstore-schema-{}", Uuid::new_v4()));
    fs::create_dir_all(&base).unwrap();

    let source = base.join("storage.db");
    fs::File::create(&source).unwrap();
    let storage = SqliteDocStorage::new(path_string(&source));
    storage.connect().await.unwrap();

    sqlx::query("CREATE VIEW rogue_view AS SELECT space_id FROM meta")
      .execute(&storage.pool)
      .await
      .unwrap();

    assert!(!storage.validate_import_schema().await.unwrap());

    storage.close().await;
    fs::remove_dir_all(base).unwrap();
  }

  #[tokio::test]
  async fn validate_import_schema_accepts_initial_v2_schema() {
    let base = std::env::temp_dir().join(format!("nbstore-v2-schema-{}", Uuid::new_v4()));
    fs::create_dir_all(&base).unwrap();

    let source = base.join("storage.db");
    let source_path = path_string(&source);
    let setup_pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect_with(
        SqliteConnectOptions::new()
          .filename(&source_path)
          .create_if_missing(true)
          .foreign_keys(false),
      )
      .await
      .unwrap();

    let mut migrations = get_migrator().migrations.to_vec();
    migrations.truncate(1);
    let migrator = Migrator {
      migrations: Cow::Owned(migrations),
      ..Migrator::DEFAULT
    };

    migrator.run(&setup_pool).await.unwrap();
    SqliteDocStorage::close_pool(&setup_pool).await;

    let storage = SqliteDocStorage::new(source_path);

    assert!(storage.validate().await.unwrap());
    assert!(storage.validate_import_schema().await.unwrap());

    storage.close().await;
    fs::remove_dir_all(base).unwrap();
  }

  fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
  }
}
