-- SPEC-B1.1 QA Remediation (frozen 2026-11-22). Idempotente; requer 036.
-- P1-4: tickets_messages ganha tenant_id (backfill do ticket pai)
ALTER TABLE tickets_messages ADD COLUMN tenant_id TEXT REFERENCES tickets_tenants(id);
UPDATE tickets_messages SET tenant_id = (SELECT tenant_id FROM tickets WHERE id = tickets_messages.ticket_id)
WHERE tenant_id IS NULL
  AND ticket_id IN (SELECT id FROM tickets WHERE tenant_id IS NOT NULL)
  AND (SELECT tenant_id FROM tickets WHERE id = tickets_messages.ticket_id) IN (SELECT id FROM tickets_tenants);

-- RF-05: reabertura
ALTER TABLE tickets ADD COLUMN reopened_at TEXT;
ALTER TABLE tickets ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0;

-- RF-05: escalada humana
CREATE TABLE IF NOT EXISTS tickets_escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  tenant_id TEXT NOT NULL REFERENCES tickets_tenants(id),
  reason TEXT NOT NULL,
  created_by_uid TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_escalations_tenant ON tickets_escalations(tenant_id, created_at);

-- RF-08: kill switch global (1 linha)
CREATE TABLE IF NOT EXISTS tickets_global_switch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO tickets_global_switch (id, enabled) VALUES (1, 0);
