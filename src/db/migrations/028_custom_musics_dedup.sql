-- 028_custom_musics_dedup.sql
-- app#336 fase 3 / dedup de imports .slja.
--
-- A 023 criou idx_custom_musics_client_uuid UNIQUE sobre client_uuid
-- SOZINHO (global). Com o dedupe de imports o client_uuid vira
-- DETERMINÍSTICO do conteúdo do arquivo — dois operadores diferentes
-- importando o MESMO .slja geram o MESMO uuid e colidiriam
-- globalmente. O escopo correto é o dono (owner_id, adicionado na 022).
--
-- Então: dropa o índice global e cria o escopado por dono.
-- Donos diferentes coexistem (cada um tem sua cópia). Legacy
-- (client_uuid NULL) não participa (índice parcial).

DROP INDEX IF EXISTS idx_custom_musics_client_uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_musics_owner_client_uuid
  ON custom_musics(owner_id, client_uuid)
  WHERE client_uuid IS NOT NULL;
