-- Token de parceiro (.planning/partner-keys/SPEC.md).
-- Só o SHA-256 do token é guardado; o token em claro aparece uma única vez
-- no CLI (src/cli/partners.ts). Idempotente: pode rodar de novo.
CREATE TABLE IF NOT EXISTS partner_keys (
  id_partner INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_keys_hash ON partner_keys (key_hash);
