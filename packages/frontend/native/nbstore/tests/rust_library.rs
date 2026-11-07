#![cfg(feature = "use-as-lib")]

use affine_nbstore::{Data, SetBlob, storage::SqliteDocStorage};
use uuid::Uuid;
use y_octo::DocOptions;

#[tokio::test]
async fn rust_library_preserves_binary_blobs_and_document_updates_after_reopen() {
  let directory = std::env::temp_dir().join(format!("affine-rust-library-{}", Uuid::new_v4()));
  std::fs::create_dir_all(&directory).unwrap();
  let database = directory.join("storage.db").to_string_lossy().into_owned();
  let payload: Vec<u8> = (0..=u8::MAX).collect();
  let owned_payload: Data = payload.clone();
  let document = DocOptions::new().with_guid("doc".to_string()).build();
  document
    .get_or_create_text("content")
    .unwrap()
    .insert(0, "Rust storage preserves UTF-8: café 東京 🦀")
    .unwrap();
  let update = document.encode_update_v1().unwrap();

  let storage = SqliteDocStorage::new(database.clone());
  storage.connect().await.unwrap();
  storage
    .set_blob(SetBlob {
      key: "all-byte-values".to_string(),
      data: owned_payload,
      mime: "application/octet-stream".to_string(),
    })
    .await
    .unwrap();
  storage.push_update("doc".to_string(), update.clone()).await.unwrap();
  storage.close().await;
  drop(storage);

  let storage = SqliteDocStorage::new(database);
  storage.connect().await.unwrap();
  let blob = storage.get_blob("all-byte-values".to_string()).await.unwrap().unwrap();
  assert_eq!(blob.data, payload);
  assert_eq!(blob.size, 256);
  assert_eq!(blob.mime, "application/octet-stream");
  let updates = storage.get_doc_updates("doc".to_string()).await.unwrap();
  assert_eq!(updates.len(), 1);
  assert_eq!(updates[0].bin, update);
  let record = storage.get_doc("doc".to_string()).await.unwrap().unwrap();
  let mut restored = DocOptions::new().with_guid("doc".to_string()).build();
  restored.apply_update_from_binary_v1(&record.bin).unwrap();
  assert_eq!(
    restored.get_or_create_text("content").unwrap().to_string(),
    "Rust storage preserves UTF-8: café 東京 🦀"
  );
  storage.close().await;
  drop(storage);
  std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn literal_canonical_paths_do_not_parse_url_query_or_percent_escapes() {
  let directory = std::env::temp_dir().join(format!("affine-literal-path-{}", Uuid::new_v4()));
  std::fs::create_dir_all(&directory).unwrap();
  let directory = std::fs::canonicalize(directory).unwrap();
  // Windows canonical paths include a verbatim prefix containing '?'. Unix also permits '?' in filenames.
  let filename = if cfg!(windows) {
    "storage %2F café.db"
  } else {
    "storage ?mode=ro %2F café.db"
  };
  let database = directory.join(filename);
  let storage = SqliteDocStorage::new(database.to_str().unwrap().to_owned());
  storage.connect().await.unwrap();
  storage.set_space_id("literal-path".into()).await.unwrap();
  storage.close().await;
  assert!(database.is_file());
  let reopened = SqliteDocStorage::new(database.to_str().unwrap().to_owned());
  reopened.connect().await.unwrap();
  assert!(reopened.validate().await.unwrap());
  reopened.close().await;
  std::fs::remove_dir_all(directory).unwrap();
}
