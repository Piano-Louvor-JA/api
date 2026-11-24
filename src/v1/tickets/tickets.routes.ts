/**
 * central-tickets B1.1 — rotas de tickets (portal + agente).
 * Todo acesso escopa por tenantId do contexto (isolamento rígido).
 */
import { randomBytes } from "node:crypto";
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { getDb } from "../../db/connection.js";
import { audit } from "./audit.service.js";
import {
  requireTicketRole,
  type TicketsEnv,
  ticketsAuth,
} from "./auth.middleware.js";
import { computeDueDates } from "./sla.service.js";

const app = new OpenAPIHono<TicketsEnv>();

// Auth tenant-aware aplicada pelo próprio router (montagem indepentente)
app.use("*", ticketsAuth);

function newRef(): string {
  return `TKT-${new Date().getUTCFullYear()}-${randomBytes(4)
    .toString("hex")
    .toUpperCase()}`;
}

const TicketCreate = z.object({
  subject: z.string().min(3).max(200),
  priority: z.enum(["P1", "P2", "P3", "P4"]).default("P4"),
  message: z.string().min(1).max(8000),
});

const MessageCreate = z.object({
  body: z.string().min(1).max(8000),
  internal_note: z.boolean().default(false),
});

type TicketRow = {
  id: number;
  public_ref: string;
  tenant_id: string;
  created_by_uid: string | null;
  status: string;
};

/** Busca ticket garantindo tenant; 404 uniforme se de outro tenant. */
function findTicket(id: number, tenantId: string): TicketRow | undefined {
  return getDb()
    .prepare("SELECT * FROM tickets WHERE id = ? AND tenant_id = ?")
    .get(id, tenantId) as TicketRow | undefined;
}

/** Operador global de facto nesta fase: admin do tenant piano (SPEC-B1.1 §3). */
function isGlobalOperator(u: { tenantId: string; role: string }): boolean {
  return u.tenantId === "piano" && u.role === "admin";
}

// --- list (client vê próprios; agent/admin vê todos do tenant) ---
app.get("/", requireTicketRole("client"), (c) => {
  const u = c.get("ticketsUser");
  const db = getDb();
  const items =
    u.role === "client"
      ? db
          .prepare(
            "SELECT * FROM tickets WHERE tenant_id = ? AND created_by_uid = ? ORDER BY id DESC LIMIT 100",
          )
          .all(u.tenantId, u.uid)
      : db
          .prepare(
            "SELECT * FROM tickets WHERE tenant_id = ? ORDER BY id DESC LIMIT 100",
          )
          .all(u.tenantId);
  return c.json({ items });
});

// --- create ---
app.post("/", requireTicketRole("client"), async (c) => {
  const u = c.get("ticketsUser");
  const body = TicketCreate.parse(await c.req.json());
  const nowIso = new Date().toISOString();
  const due = computeDueDates(u.tenantId, body.priority, nowIso);
  const db = getDb();
  const ref = newRef();
  const info = db
    .prepare(
      `INSERT INTO tickets (public_ref, tenant_id, subject, priority, channel, created_by_uid, first_response_due_at, resolve_due_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      ref,
      u.tenantId,
      body.subject,
      body.priority,
      "portal",
      u.uid,
      due.firstResponseDue,
      due.resolveDue,
    );
  const id = Number(info.lastInsertRowid);
  db.prepare(
    "INSERT INTO tickets_messages (ticket_id, tenant_id, author_type, author_uid, body) VALUES (?,?,?,?,?)",
  ).run(id, u.tenantId, "client", u.uid, body.message);
  audit({
    tenantId: u.tenantId,
    actorUid: u.uid,
    action: "ticket.created",
    entityType: "ticket",
    entityId: id,
    metadata: { priority: body.priority },
  });
  return c.json({ id, public_ref: ref, status: "open", ...due }, 201);
});

// --- get one (tenant-scoped) ---
app.get("/:id{[0-9]+}", requireTicketRole("client"), (c) => {
  const u = c.get("ticketsUser");
  const id = Number(c.req.param("id"));
  const t = findTicket(id, u.tenantId);
  if (!t) return c.json({ error: "Not Found" }, 404);
  if (u.role === "client" && t.created_by_uid !== u.uid) {
    return c.json({ error: "Not Found" }, 404);
  }
  return c.json(t);
});

// --- messages: append client/agent ---
app.post("/:id{[0-9]+}/messages", requireTicketRole("client"), async (c) => {
  const u = c.get("ticketsUser");
  const id = Number(c.req.param("id"));
  const t = findTicket(id, u.tenantId);
  if (!t) return c.json({ error: "Not Found" }, 404);
  if (u.role === "client" && t.created_by_uid !== u.uid) {
    return c.json({ error: "Not Found" }, 404);
  }
  const body = MessageCreate.parse(await c.req.json());
  if (body.internal_note && u.role === "client") {
    return c.json({ error: "Sem permissão" }, 403);
  }
  const db = getDb();
  db.prepare(
    "INSERT INTO tickets_messages (ticket_id, tenant_id, author_type, author_uid, author_name, body, internal_note) VALUES (?,?,?,?,?,?,?)",
  ).run(
    id,
    u.tenantId,
    u.role === "client" ? "client" : "agent",
    u.uid,
    u.email,
    body.body,
    body.internal_note ? 1 : 0,
  );
  db.prepare(
    "UPDATE tickets SET updated_at = datetime('now'), status = CASE WHEN ? = 'client' THEN 'open' ELSE status END WHERE id = ?",
  ).run(u.role, id);
  audit({
    tenantId: u.tenantId,
    actorUid: t.created_by_uid ?? u.uid,
    action: "ticket.message_added",
    entityType: "ticket",
    entityId: id,
  });
  return c.json({ ok: true }, 201);
});

// --- messages: list (notas internas só para agent/admin; filtradas por tenant) ---
app.get("/:id{[0-9]+}/messages", requireTicketRole("client"), (c) => {
  const u = c.get("ticketsUser");
  const id = Number(c.req.param("id"));
  const t = findTicket(id, u.tenantId);
  if (!t) return c.json({ error: "Not Found" }, 404);
  if (u.role === "client" && t.created_by_uid !== u.uid) {
    return c.json({ error: "Not Found" }, 404);
  }
  const rows = getDb()
    .prepare(
      "SELECT * FROM tickets_messages WHERE ticket_id = ? AND tenant_id = ? AND (? = 1 OR internal_note = 0) ORDER BY id",
    )
    .all(id, u.tenantId, u.role === "client" ? 0 : 1);
  return c.json({ items: rows });
});

// --- status transitions (agent+); PATCH conforme SPEC-B1.1 §6.1 ---
const StatusBody = z.object({
  status: z.enum(["open", "pending_user", "resolved", "closed", "spam"]),
});

function createStatusHandler(): MiddlewareHandler<TicketsEnv> {
  return async (c) => {
    const u = c.get("ticketsUser");
    const id = Number(c.req.param("id"));
    const t = findTicket(id, u.tenantId);
    if (!t) return c.json({ error: "Not Found" }, 404);
    const body = StatusBody.parse(await c.req.json());
    const db = getDb();

    // Reabertura (SPEC-B1.1 §6.1): resolved|closed → open por humano (agent+)
    const isReopen =
      (t.status === "resolved" || t.status === "closed") &&
      body.status === "open";
    if (isReopen) {
      db.prepare(
        "UPDATE tickets SET status = ?, updated_at = datetime('now'), reopened_at = datetime('now'), reopen_count = reopen_count + 1, resolved_at = NULL, closed_at = NULL WHERE id = ?",
      ).run(body.status, id);
      audit({
        tenantId: u.tenantId,
        actorUid: u.uid,
        action: "ticket.reopened",
        entityType: "ticket",
        entityId: id,
        metadata: { from: t.status, to: body.status },
      });
      return c.json({ ok: true, reopened: true });
    }
    db.prepare(
      "UPDATE tickets SET status = ?, updated_at = datetime('now'), resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE resolved_at END, closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE closed_at END WHERE id = ?",
    ).run(body.status, body.status, body.status, id);
    audit({
      tenantId: u.tenantId,
      actorUid: u.uid,
      action: "ticket.status_changed",
      entityType: "ticket",
      entityId: id,
      metadata: { to: body.status },
    });
    return c.json({ ok: true });
  };
}

app.patch(
  "/:id{[0-9]+}/status",
  requireTicketRole("agent"),
  createStatusHandler(),
);
// Compat: POST aceito na v1 B1 (site B2 usava POST) — mesmo handler
app.post(
  "/:id{[0-9]+}/status",
  requireTicketRole("agent"),
  createStatusHandler(),
);

// --- memberships admin ---
app.post("/memberships", requireTicketRole("admin"), async (c) => {
  const u = c.get("ticketsUser");
  const body = z
    .object({
      firebase_uid: z.string().min(4),
      role: z.enum(["client", "agent", "admin"]).default("client"),
    })
    .parse(await c.req.json());
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO tickets_memberships (tenant_id, firebase_uid, role) VALUES (?,?,?)",
    )
    .run(u.tenantId, body.firebase_uid, body.role);
  audit({
    tenantId: u.tenantId,
    actorUid: u.uid,
    action: "membership.created",
    entityType: "membership",
    entityId: body.firebase_uid,
  });
  return c.json({ ok: true }, 201);
});

// --- AI suggestion: fail-closed, R1 FAQ global, opt-in ---
app.post(
  "/:id{[0-9]+}/ai-suggestion",
  requireTicketRole("agent"),
  async (c) => {
    const u = c.get("ticketsUser");
    const id = Number(c.req.param("id"));
    const t = findTicket(id, u.tenantId);
    if (!t) return c.json({ error: "Not Found" }, 404);
    z.object({ opt_in: z.literal(true) }).parse(await c.req.json());

    const policy = getDb()
      .prepare("SELECT * FROM tickets_ai_policies WHERE tenant_id = ?")
      .get(u.tenantId) as { enabled: number } | undefined;
    if (!policy || policy.enabled !== 1) {
      return c.json({ error: "IA desativada para este tenant" }, 403);
    }
    // v1: nenhum provedor externo — sempre "sem sugestão" até R1 existir
    return c.json({ suggestion: null, confidence: 0, reason: "no_provider" });
  },
);

// intake list (agent+) — SPEC-B1.1 §1.1: fila global de triagem, sem PII
app.get("/intake", requireTicketRole("agent"), (c) => {
  const rows = getDb()
    .prepare(
      "SELECT id, protocol, subject, status, created_at FROM tickets_intake WHERE status = 'new' ORDER BY id DESC LIMIT 100",
    )
    .all();
  return c.json({ items: rows });
});

// kill switch global (SPEC-B1.1 §6.2) — admin piano (operador global)
app.get("/admin/kill-switch", requireTicketRole("agent"), (c) => {
  const u = c.get("ticketsUser");
  if (!isGlobalOperator(u)) return c.json({ error: "Sem permissão" }, 403);
  const row = getDb()
    .prepare("SELECT enabled FROM tickets_global_switch WHERE id = 1")
    .get() as { enabled: number } | undefined;
  return c.json({ enabled: row ? row.enabled === 1 : false });
});

app.put("/admin/kill-switch", requireTicketRole("agent"), async (c) => {
  const u = c.get("ticketsUser");
  if (!isGlobalOperator(u)) return c.json({ error: "Sem permissão" }, 403);
  const body = z
    .object({
      enabled: z.boolean(),
      reason: z.string().min(3).max(500),
    })
    .parse(await c.req.json());
  const prev = getDb()
    .prepare("SELECT enabled FROM tickets_global_switch WHERE id = 1")
    .get() as { enabled: number } | undefined;
  const prevEnabled = prev ? prev.enabled === 1 : false;
  getDb()
    .prepare(
      "UPDATE tickets_global_switch SET enabled = ?, updated_at = datetime('now') WHERE id = 1",
    )
    .run(body.enabled ? 1 : 0);
  audit({
    tenantId: "public",
    actorUid: u.uid,
    action: "kill_switch",
    entityType: "global_switch",
    entityId: 1,
    metadata: { previous: prevEnabled, new: body.enabled, reason: body.reason },
  });
  return c.json({ ok: true, enabled: body.enabled });
});

export default app;
