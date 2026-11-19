-- 034_deleted_account_sentinel.sql
-- Usuário-sistema "Conta excluída": recebe as coletâneas públicas (e as
-- referências de moderação) de quem exclui a conta (DELETE /v1/custom/auth/me).
-- Não pode ficar owner_id NULL: NULL = coletânea legado editável por qualquer um.
-- password_hash fora do formato pbkdf2 → verifyPassword sempre falha (sem login).
-- Idempotente: e-mail é UNIQUE, então rodar de novo não duplica.
INSERT OR IGNORE INTO custom_users (email, password_hash, display_name)
VALUES ('conta-excluida@sistema.invalid', 'disabled$deleted-account', 'Conta excluída');
