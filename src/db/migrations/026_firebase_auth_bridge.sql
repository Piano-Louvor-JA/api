-- 026_firebase_auth_bridge.sql
-- Login unificado: Firebase Auth como IdP. custom_users ganha firebase_uid
-- (nullable — usuários legacy de email/senha continuam válidos).
-- Idempotente: roda 2x sem erro.

ALTER TABLE custom_users ADD COLUMN firebase_uid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_users_firebase_uid
  ON custom_users(firebase_uid) WHERE firebase_uid IS NOT NULL;
