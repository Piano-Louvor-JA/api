-- 027_operator_state.sql
-- Sync v2 (app#336): estado do OPERADOR na conta — liturgia da semana,
-- itens agendados, customizações do palco, presets de timer, preferências.
--
-- Uma tabela genérica com namespace (em vez de N tabelas): cada frente
-- define seu namespace ('liturgy', 'scheduled', 'stage', 'timer', 'prefs')
-- e o payload é JSON. LWW idêntico ao das coletâneas (025):
--   client_uuid = identidade client-side
--   updated_at_ms = relógio LWW (ms epoch)
--   deleted_at = tombstone
--
-- Idempotência: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS operator_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_user INTEGER NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  client_uuid TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_state_client_uuid
  ON operator_state(client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operator_state_user_ns
  ON operator_state(id_user, namespace, deleted_at);
