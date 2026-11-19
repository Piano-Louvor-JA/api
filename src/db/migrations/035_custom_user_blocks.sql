-- 035_custom_user_blocks.sql
-- Bloqueio de usuário (App Store 1.2 — conteúdo gerado por usuários): quem
-- bloqueia deixa de ver as coletâneas do autor bloqueado na Comunidade.
-- Idempotente: CREATE ... IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS custom_user_blocks (
  blocker_id INTEGER NOT NULL REFERENCES custom_users(id_user) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES custom_users(id_user) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_custom_user_blocks_blocked ON custom_user_blocks(blocked_id);
