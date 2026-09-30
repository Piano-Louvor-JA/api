-- 023_custom_password_reset.sql
-- Reset de senha: token de uso único com expiração (1h), guardado como hash.
-- Sem SMTP: o token é exibido/deixado com o próprio usuário pelo canal de
-- suporte (ou via tela do app em modo local-dev). O token puro NUNCA é
-- persistido — igual às sessões.

ALTER TABLE custom_users ADD COLUMN reset_token_hash TEXT;
ALTER TABLE custom_users ADD COLUMN reset_token_expires DATETIME;
