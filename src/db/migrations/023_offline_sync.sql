-- 023_offline_sync.sql
-- Schema de sincronização offline-first das coletâneas custom.
-- Conceitos:
--   client_uuid: identidade client-side do item (uuid v4 gerado no app).
--                É a chave de sync; o INTEGER id permanece chave primária interna.
--   deleted_at:  tombstone (ms epoch). NULL = vivo. DELETE lógico, purge após 30d.
--   updated_at_ms: relógio LWW em ms epoch (inteiro confiável; DATETIME string
--                não serve pra comparar). NULL = herdado de updated_at.
--
-- Idempotência: o runner tolera "duplicate column name"; ALTERs repetidos
-- são inofensivos. CREATE INDEX usa IF NOT EXISTS.

-- ===================== custom_collections =====================
ALTER TABLE custom_collections ADD COLUMN client_uuid TEXT;
ALTER TABLE custom_collections ADD COLUMN deleted_at INTEGER;
ALTER TABLE custom_collections ADD COLUMN updated_at_ms INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_collections_client_uuid
  ON custom_collections(client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_custom_collections_deleted
  ON custom_collections(deleted_at);

-- Backfill: legado ganha uuid + clock derivado de updated_at (DATETIME string)
UPDATE custom_collections
   SET client_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
                          substr(hex(randomblob(2)),2) || '-' ||
                          substr('89ab', abs(random()) % 4 + 1, 1) ||
                          substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
       updated_at_ms = CAST(strftime('%s', updated_at) AS INTEGER) * 1000
 WHERE client_uuid IS NULL;

-- ===================== custom_musics =====================
ALTER TABLE custom_musics ADD COLUMN client_uuid TEXT;
ALTER TABLE custom_musics ADD COLUMN deleted_at INTEGER;
ALTER TABLE custom_musics ADD COLUMN updated_at_ms INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_musics_client_uuid
  ON custom_musics(client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_custom_musics_deleted
  ON custom_musics(deleted_at);

UPDATE custom_musics
   SET client_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
                          substr(hex(randomblob(2)),2) || '-' ||
                          substr('89ab', abs(random()) % 4 + 1, 1) ||
                          substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
       updated_at_ms = CAST(strftime('%s', updated_at) AS INTEGER) * 1000
 WHERE client_uuid IS NULL;

-- ===================== custom_lyrics =====================
-- Estrofes não têm identidade própria no sync (sincronizam como payload da
-- música pai), mas recebem updated_at_ms p/ LWW de conteúdo.
ALTER TABLE custom_lyrics ADD COLUMN updated_at_ms INTEGER;

UPDATE custom_lyrics
   SET updated_at_ms = CAST(strftime('%s', updated_at) AS INTEGER) * 1000
 WHERE updated_at_ms IS NULL;
