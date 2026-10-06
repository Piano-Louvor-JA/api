-- 029: files.url precisa de UNIQUE — importMusicById usa
-- INSERT ... ON CONFLICT(url) DO NOTHING (lib/importMusicOnMiss.ts),
-- que exige constraint/índice único em url. Sem isso, o import on-miss
-- quebra com SqliteError em DB fresh criado só com migrations.
-- UNIQUE INDEX simples: valores NULL são tratados como distintos pelo
-- SQLite, então linhas antigas com url NULL não conflitam.
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_url_unique
  ON files (url);
