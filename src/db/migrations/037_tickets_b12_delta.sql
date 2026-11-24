-- SPEC-B1.1 QA Remediation (frozen 2026-11-22), portado para schema 036_tickets_central (staging).
-- Idempotente. Delta B1.1 sobre staging: reopen_count, escalada, kill switch global.
-- (staging já possui: tickets.tenant_id REFERENCES tenants, tickets.reopened_at, tenants.automation_kill_switch, tickets_messages.tenant_id)

-- RF-05: contagem de reaberturas
ALTER TABLE tickets ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0;

-- RF-05: escalada humana
CREATE TABLE IF NOT EXISTS tickets_escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  reason TEXT NOT NULL,
  created_by_uid TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_escalations_tenant ON tickets_escalations(tenant_id, created_at);
-- RF-08 (kill switch global) já coberto no staging: automation_policies (scope='global', enabled=0) + tenants.automation_kill_switch.

