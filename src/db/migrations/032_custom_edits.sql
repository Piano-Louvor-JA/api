-- 032_custom_edits.sql
-- Editas da Comunidade: correções de letra/timing sobre músicas oficiais (SPEC piano-community-edits v1.0).
CREATE TABLE IF NOT EXISTS custom_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_uuid TEXT NOT NULL UNIQUE,        -- idempotência (sha256 do conteúdo, mesmo padrão custom)
  music_id INTEGER NOT NULL,               -- id oficial do catálogo
  author_user_id INTEGER NOT NULL REFERENCES custom_users(id_user) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','approved','rejected')),
  lyrics TEXT,                             -- JSON dos slides editados ou NULL
  timing TEXT,                             -- JSON das marcações de slide ou NULL
  reason TEXT,                             -- motivo público do reject
  decided_by INTEGER REFERENCES custom_users(id_user),
  decided_at TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'piano',
  created_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_edits_music ON custom_edits(music_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_edits_pending ON custom_edits(music_id, author_user_id)
  WHERE status = 'published';

-- GM role v1: concessão manual via SQL (RF-07 automatizado entra em fase 2)
ALTER TABLE custom_users ADD COLUMN is_gm INTEGER NOT NULL DEFAULT 0;
