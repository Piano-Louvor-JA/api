CREATE TABLE IF NOT EXISTS catalog_imports (
  import_id TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dry_run', 'staged', 'published', 'rolled_back')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  manifest_path TEXT NOT NULL,
  license_approval_id TEXT NOT NULL,
  report_path TEXT
);

CREATE TABLE IF NOT EXISTS catalog_import_items (
  import_id TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_sha256 TEXT,
  role TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  runtime_path TEXT,
  PRIMARY KEY (import_id, drive_file_id),
  FOREIGN KEY (import_id) REFERENCES catalog_imports(import_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_import_items_drive_file
  ON catalog_import_items(drive_file_id)
  WHERE source_sha256 IS NOT NULL;
