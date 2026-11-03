-- 027_community_multitenancy.sql — SPEC comunidade-multitenant (out/2026)
-- Padrão silo compartilhado + discriminator (tenant_id), default 'piano'.
-- Puramente aditiva e idempotente (replay total a cada boot — lição api#88).

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,                    -- 'piano','classic','flute','violin'
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO tenants (id, name) VALUES
  ('piano',  'LouvorJA PIANO'),
  ('classic','LouvorJA Clássico'),
  ('flute',  'LouvorJA Flute'),
  ('violin', 'LouvorJA Violin');

-- SQLite cannot ADD COLUMN with REFERENCES plus a non-NULL DEFAULT.
-- Tenant existence is enforced by tenant.middleware.ts before every community query/write.
ALTER TABLE custom_collections ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'piano';
CREATE INDEX IF NOT EXISTS idx_custom_collections_tenant
  ON custom_collections(tenant_id, visibility);

ALTER TABLE custom_users ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'piano';

ALTER TABLE seasonal_events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'piano';
