-- 024_custom_visibility.sql
-- Visibilidade de coletâneas custom (api#82):
-- 'public' (default, legado) = aparece pra todos na listagem
-- 'private' = só o dono (owner_id) vê
-- Hardening de auth nas escritas é feito nas rotas (não no schema).

ALTER TABLE custom_collections ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'private'));

CREATE INDEX IF NOT EXISTS idx_custom_collections_visibility ON custom_collections(visibility);
