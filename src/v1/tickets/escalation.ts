/**
 * central-tickets B1.1 — escalada automática determinística (SPEC-B1.1 §6.1).
 * Portado para schema 036_tickets_central (audit_events).
 * Job local: chamada manual/cron externo. P1 com first_response_due_at vencido
 * e sem primeira resposta → escalada humana + auditoria. Sem envio externo.
 */
import { getDb } from "../../db/connection.js";

export function escalateBreached(): number {
  const db = getDb();
  const breached = db
    .prepare(
      `SELECT id, tenant_id FROM tickets
       WHERE priority = 'P1'
         AND status IN ('new', 'open')
         AND first_response_due_at IS NOT NULL
         AND first_response_due_at < datetime('now')
         AND id NOT IN (SELECT ticket_id FROM tickets_escalations WHERE resolved_at IS NULL)`,
    )
    .all() as { id: string; tenant_id: string }[];

  let created = 0;
  for (const t of breached) {
    db.prepare(
      "INSERT INTO tickets_escalations (ticket_id, tenant_id, reason) VALUES (?,?,?)",
    ).run(t.id, t.tenant_id, "P1 SLA first_response breached");
    db.prepare(
      `INSERT INTO audit_events (tenant_id, actor, action, target, after_json)
       VALUES (?,?,?,?,?)`,
    ).run(
      t.tenant_id,
      "system:escalation",
      "ticket.escalated",
      `ticket:${t.id}`,
      JSON.stringify({ reason: "sla_breached", priority: "P1" }),
    );
    created++;
  }
  return created;
}

/** RF-08: kill switch global é coberto por automation_policies (scope='global', enabled=0) — ver tickets.ai.ts. */
