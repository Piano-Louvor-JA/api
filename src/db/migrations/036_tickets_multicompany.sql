-- Central de Tickets multiempresa (SPEC central-tickets v1.0.0, frozen 2026-11-21)
-- Tenants, memberships RBAC, tickets, mensagens, intake público com triagem,
-- KB global+tenant, políticas IA fail-closed, automação off, auditoria append-only.
-- Idempotente: CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE.

CREATE TABLE IF NOT EXISTS tickets_tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets_memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tickets_tenants(id),
  firebase_uid TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client','agent','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, firebase_uid)
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_ref TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tickets_tenants(id),
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending_user','resolved','closed','spam')),
  priority TEXT NOT NULL DEFAULT 'P4' CHECK (priority IN ('P1','P2','P3','P4')),
  channel TEXT NOT NULL DEFAULT 'portal',
  created_by_uid TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  first_response_due_at TEXT,
  resolve_due_at TEXT,
  resolved_at TEXT,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant ON tickets(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);

CREATE TABLE IF NOT EXISTS tickets_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  author_type TEXT NOT NULL CHECK (author_type IN ('client','agent','system')),
  author_uid TEXT,
  author_name TEXT,
  body TEXT NOT NULL,
  internal_note INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tmsg_ticket ON tickets_messages(ticket_id, created_at);

-- Intake público: só triagem, sem acesso a histórico/tickets
CREATE TABLE IF NOT EXISTS tickets_intake (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','triaged','rejected','converted')),
  triage_priority TEXT CHECK (triage_priority IN ('P1','P2','P3','P4')),
  triage_note TEXT,
  triaged_at TEXT,
  triaged_by_uid TEXT,
  converted_ticket_id INTEGER REFERENCES tickets(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- KB: artigos globais PIANO (tenant_id NULL) + por tenant
CREATE TABLE IF NOT EXISTS tickets_kb_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT REFERENCES tickets_tenants(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, slug)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_global_slug
  ON tickets_kb_articles(slug) WHERE tenant_id IS NULL;

-- Políticas IA por tenant: fail-closed (todos off por padrão)
CREATE TABLE IF NOT EXISTS tickets_ai_policies (
  tenant_id TEXT PRIMARY KEY REFERENCES tickets_tenants(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  min_confidence REAL NOT NULL DEFAULT 0.90,
  max_actions_per_day INTEGER NOT NULL DEFAULT 50,
  allowed_actions TEXT NOT NULL DEFAULT '[]', -- JSON array
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Automação NDAAD: off (SPEC: nenhum envio automático)
CREATE TABLE IF NOT EXISTS tickets_automation (
  tenant_id TEXT PRIMARY KEY REFERENCES tickets_tenants(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Auditoria append-only (sem UPDATE/DELETE na aplicação)
CREATE TABLE IF NOT EXISTS tickets_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  actor_uid TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON tickets_audit(tenant_id, created_at);

-- Seed: NDAAD primeiro tenant (sem UID/admin inventado)
INSERT OR IGNORE INTO tickets_tenants (id, name) VALUES ('ndaad', 'NDAAD');
INSERT OR IGNORE INTO tickets_ai_policies (tenant_id, enabled) VALUES ('ndaad', 0);
INSERT OR IGNORE INTO tickets_automation (tenant_id, enabled) VALUES ('ndaad', 0);

-- SLA janela 08:00–18:00 America/Sao_Paulo, P1..P4 (horas até primeira resposta)
CREATE TABLE IF NOT EXISTS tickets_sla_policy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT REFERENCES tickets_tenants(id),
  priority TEXT NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
  first_response_hours INTEGER NOT NULL,
  resolve_hours INTEGER NOT NULL,
  UNIQUE (tenant_id, priority)
);
INSERT OR IGNORE INTO tickets_sla_policy (tenant_id, priority, first_response_hours, resolve_hours) VALUES
  ('ndaad','P1',1,4),
  ('ndaad','P2',4,12),
  ('ndaad','P3',12,48),
  ('ndaad','P4',24,120);
