-- 041_cover_privacy.sql
-- Cover privacy (t_c68a47ac, decisão Rafael 27/11): capa local deslogado →
-- upload na autenticação com privacidade. Coluna por coletânea:
-- 1 (default) = cover_url só para o dono; 0 = cover_url público.
-- Default conservador (LGPD): covers pré-existentes de coletâneas públicas
-- continuam visíveis SOMENTE ao dono até opt-in explícito.
ALTER TABLE custom_collections ADD COLUMN cover_private INTEGER NOT NULL DEFAULT 1
  CHECK (cover_private IN (0, 1));
