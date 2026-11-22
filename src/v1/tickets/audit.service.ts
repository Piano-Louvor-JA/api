/** central-tickets B1 — auditoria append-only. */
import { getDb } from "../../db/connection.js";

export function audit(input: {
  tenantId: string;
  actorUid?: string | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  metadata?: unknown;
}): void {
  getDb()
    .prepare(
      `INSERT INTO tickets_audit (tenant_id, actor_uid, action, entity_type, entity_id, metadata)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      input.tenantId,
      input.actorUid ?? null,
      input.action,
      input.entityType,
      input.entityId != null ? String(input.entityId) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
}
