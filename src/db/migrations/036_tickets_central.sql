-- 036_tickets_central.sql
-- Central de Tickets Multiempresa — SPEC 0.1.0 frozen (BD-01..BD-10 aprovados).
-- Domínio: memberships, tickets, mensagens, triagem pública, KB,
-- políticas IA, runs de automação e audit append-only.
-- NDAAD é o primeiro tenant novo (seed) — automação desligada, sem admin/UID inventado.
-- A tabela `tenants` já existe desde a 027 (comunidade); aqui apenas
-- ADICIONAMOS colunas de status/automação (aditivo, idempotente — lição api#88).
-- Idempotente: CREATE IF NOT EXISTS + INSERT OR IGNORE; replay seguro.

ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE tenants ADD COLUMN automation_opt_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN automation_kill_switch INTEGER NOT NULL DEFAULT 0;
-- default constante (SQLite não aceita não-constante em ADD COLUMN)
ALTER TABLE tenants ADD COLUMN updated_at TEXT;

CREATE TABLE IF NOT EXISTS tenant_memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  principal_id TEXT NOT NULL, -- Firebase UID (BD-01)
  role TEXT NOT NULL CHECK (role IN ('member','agent','admin','global_operator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, principal_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON tenant_memberships(tenant_id, principal_id);

-- Prioridades P1–P4 (BD-02); horário comercial 08:00–18:00 America/Sao_Paulo é regra de negócio (serviço SLA).
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  source TEXT NOT NULL CHECK (source IN ('portal','triage_conversion')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','open','pending','resolved','closed','reopened')),
  priority TEXT NOT NULL DEFAULT 'P3' CHECK (priority IN ('P1','P2','P3','P4')),
  risk_level TEXT NOT NULL DEFAULT 'R0' CHECK (risk_level IN ('R0','R1','R2','R3')),
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  requester_ref TEXT NOT NULL, -- UID ou referência do solicitante
  created_by TEXT NOT NULL,
  first_response_due_at TEXT,
  resolution_due_at TEXT,
  reopened_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant ON tickets(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant_id ON tickets(tenant_id, id);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  author_type TEXT NOT NULL CHECK (author_type IN ('human','automation')),
  author_ref TEXT NOT NULL,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','public')),
  automation_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_ticket ON ticket_messages(tenant_id, ticket_id, created_at);

-- Intake público (RF-03): somente solicitação + protocolo; sem acesso a histórico.
CREATE TABLE IF NOT EXISTS triage_requests (
  id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL UNIQUE,
  requester_name TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  requester_phone TEXT,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  consent_lgpd INTEGER NOT NULL DEFAULT 0 CHECK (consent_lgpd IN (0,1)),
  origin TEXT NOT NULL DEFAULT 'public_form',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_review','rejected','converted')),
  tenant_id TEXT REFERENCES tenants(id),
  converted_ticket_id TEXT REFERENCES tickets(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_note TEXT
);

-- KB (RF-06): global (PIANO) ou escopo tenant; aprovação obrigatória p/ autoenvio.
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','tenant')),
  tenant_id TEXT REFERENCES tenants(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  approved_for_auto_send INTEGER NOT NULL DEFAULT 0 CHECK (approved_for_auto_send IN (0,1)),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((scope = 'global' AND tenant_id IS NULL) OR (scope = 'tenant' AND tenant_id IS NOT NULL))
);

-- Políticas IA (RF-07): allowlist, limiar 0.90 (BD-07), kill switches (RF-08).
CREATE TABLE IF NOT EXISTS automation_policies (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','tenant')),
  tenant_id TEXT REFERENCES tenants(id),
  allowlist TEXT NOT NULL DEFAULT '[]', -- JSON array de categorias
  confidence_threshold REAL NOT NULL DEFAULT 0.90,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((scope = 'global' AND tenant_id IS NULL) OR (scope = 'tenant' AND tenant_id IS NOT NULL))
);

-- Runs de automação (RF-09): decisão auditável de cada execução IA.
CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  ticket_id TEXT REFERENCES tickets(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  model TEXT NOT NULL,
  classification TEXT NOT NULL, -- R0..R3
  confidence REAL NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '[]', -- [{id,version,approved}]
  decision TEXT NOT NULL CHECK (decision IN ('draft','auto_send','blocked')),
  blocked_reasons TEXT NOT NULL DEFAULT '[]',
  output_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_ticket ON automation_runs(tenant_id, ticket_id);

-- Auditoria append-only (RF-09): trigger bloqueia UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  before_json TEXT,
  after_json TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_events(tenant_id, created_at);

-- Append-only: falha forçada em UPDATE e DELETE (mantida em linha única — o
-- runner de migrations em connection.ts divide statements por ';' de fim de linha).
CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events é append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events é append-only'); END;

-- Seed: tenant NDAAD (BD-10) — automação desligada; nenhum membership criado
-- (admins somente após UIDs Firebase confirmados).
INSERT OR IGNORE INTO tenants (id, name, status, automation_opt_in, automation_kill_switch)
VALUES ('ndaad', 'NDAAD', 'active', 0, 0);
