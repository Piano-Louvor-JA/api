-- 022_custom_auth_ownership.sql
-- Adiciona owner_id nas tabelas custom + índices.
-- owner_id NULL = coletânea legado (pública, sem dono).
--
-- IMPORTANTE (lição api#88 / B15): o runner roda o arquivo via db.exec() que
-- PARA no primeiro erro. Melhor-sqlite3 não suportava múltiplos statements com
-- tolerância por-statement (corrigido depois), então a 021 já cria owner_id em
-- custom_collections — duplicado abortaria o restante deste script.
-- Solução: o ALTER duplicado de custom_collections foi REMOVIDO (021 já cobre).
--
-- Em DBs que já aplicaram a 021: owner_id/author_name existem → nada a fazer.
-- Em DBs que NÃO aplicaram (ordem antiga): 021 roda antes (sort) e cria.

-- custom_musics (021 não cria aqui — sempre seguro)
ALTER TABLE custom_musics ADD COLUMN owner_id INTEGER REFERENCES custom_users(id_user);

CREATE INDEX IF NOT EXISTS idx_custom_musics_owner_id ON custom_musics(owner_id);

CREATE INDEX IF NOT EXISTS idx_custom_collections_owner_id ON custom_collections(owner_id);

-- custom_lyrics (herda via custom_musics, não precisa de owner_id direto)

-- custom_sessions: já tem id_user FK
