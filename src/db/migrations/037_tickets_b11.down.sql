-- Down da 037 (SPEC-B1.1). Seguro no boot (erros "no such column/table" são
-- ignorados pelo runner); reversão limpa quando executada manualmente pós-037.
ALTER TABLE tickets_messages DROP COLUMN tenant_id;
ALTER TABLE tickets DROP COLUMN reopened_at;
ALTER TABLE tickets DROP COLUMN reopen_count;
DROP TABLE IF EXISTS tickets_escalations;
DROP TABLE IF EXISTS tickets_global_switch;
