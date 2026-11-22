-- Reversão da migration 036 (central-tickets B1).
-- Remove TODOS os objetos criados por 036_tickets_multicompany.sql.
-- Seguro: DROP IF EXISTS; dados de tickets são perdidos (intencional no rollback).

DROP INDEX IF EXISTS idx_audit_tenant;
DROP TABLE IF EXISTS tickets_audit;
DROP TABLE IF EXISTS tickets_automation;
DROP TABLE IF EXISTS tickets_ai_policies;
DROP INDEX IF EXISTS idx_kb_global_slug;
DROP TABLE IF EXISTS tickets_kb_articles;
DROP TABLE IF EXISTS tickets_intake;
DROP INDEX IF EXISTS idx_tmsg_ticket;
DROP TABLE IF EXISTS tickets_messages;
DROP TABLE IF EXISTS tickets_sla_policy;
DROP INDEX IF EXISTS idx_tickets_tenant;
DROP INDEX IF EXISTS idx_tickets_created;
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS tickets_memberships;
DROP TABLE IF EXISTS tickets_tenants;
