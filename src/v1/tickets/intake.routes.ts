/**
 * central-tickets B1 — intake público (sem autenticação).
 * Só cria solicitação + protocolo. Sem histórico, sem tickets, sem dados
 * de outros solicitantes. Rate limit herdado do rateLimit global.
 */
import { randomBytes } from "node:crypto";
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { getDb } from "../../db/connection.js";
import { audit } from "./audit.service.js";
import {
  requireTicketRole,
  type TicketsEnv,
  ticketsAuth,
} from "./auth.middleware.js";
import { computeDueDates } from "./sla.service.js";

const app = new OpenAPIHono<TicketsEnv>();

// POST público é registrado antes; triage exige auth (aplicada por rota).
app.use("/:id{[0-9]+}/triage", ticketsAuth);

const IntakeCreate = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  subject: z.string().min(3).max(200),
  message: z.string().min(1).max(8000),
});

function newProtocol(): string {
  return `PRC-${randomBytes(5).toString("hex").toUpperCase()}`;
}

// POST público — cria apenas a solicitação
app.post("/", async (c) => {
  const body = IntakeCreate.parse(await c.req.json());
  const protocol = newProtocol();
  const info = getDb()
    .prepare(
      "INSERT INTO tickets_intake (protocol, name, email, subject, message) VALUES (?,?,?,?,?)",
    )
    .run(protocol, body.name, body.email, body.subject, body.message);
  audit({
    tenantId: "public",
    action: "intake.created",
    entityType: "intake",
    entityId: Number(info.lastInsertRowid),
  });
  return c.json({ id: Number(info.lastInsertRowid), protocol }, 201);
});

// GET protocolo público — só status, sem conteúdo/histórico
app.get("/status/:protocol", (c) => {
  const row = getDb()
    .prepare("SELECT protocol, status FROM tickets_intake WHERE protocol = ?")
    .get(c.req.param("protocol")) as
    | { protocol: string; status: string }
    | undefined;
  if (!row) return c.json({ error: "Not Found" }, 404);
  return c.json(row);
});

// triagem (agent+): define prioridade e converte em ticket do tenant
app.post("/:id/triage", requireTicketRole("agent"), async (c) => {
  const u = c.get("ticketsUser");
  const id = Number(c.req.param("id"));
  const body = z
    .object({
      priority: z.enum(["P1", "P2", "P3", "P4"]).default("P3"),
      note: z.string().max(2000).optional(),
    })
    .parse(await c.req.json());
  const db = getDb();
  const intake = db
    .prepare("SELECT * FROM tickets_intake WHERE id = ?")
    .get(id) as
    | {
        id: number;
        name: string;
        email: string;
        subject: string;
        message: string;
        status: string;
      }
    | undefined;
  if (!intake) return c.json({ error: "Not Found" }, 404);
  if (intake.status === "converted") {
    return c.json({ error: "Já convertido" }, 409);
  }

  const nowIso = new Date().toISOString();
  const due = computeDueDates(u.tenantId, body.priority, nowIso);
  const ref = `TKT-${new Date().getUTCFullYear()}-${randomBytes(4)
    .toString("hex")
    .toUpperCase()}`;
  const ticketInfo = db
    .prepare(
      `INSERT INTO tickets (public_ref, tenant_id, subject, priority, channel, first_response_due_at, resolve_due_at)
         VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      ref,
      u.tenantId,
      intake.subject,
      body.priority,
      "intake",
      due.firstResponseDue,
      due.resolveDue,
    );
  const ticketId = Number(ticketInfo.lastInsertRowid);
  db.prepare(
    "INSERT INTO tickets_messages (ticket_id, author_type, author_name, body) VALUES (?,?,?,?)",
  ).run(ticketId, "client", intake.name, intake.message);
  db.prepare(
    "UPDATE tickets_intake SET status = 'converted', triage_priority = ?, triage_note = ?, triaged_at = datetime('now'), triaged_by_uid = ?, converted_ticket_id = ? WHERE id = ?",
  ).run(body.priority, body.note ?? null, u.uid, ticketId, id);

  audit({
    tenantId: u.tenantId,
    actorUid: u.uid,
    action: "intake.triaged",
    entityType: "intake",
    entityId: id,
    metadata: { ticket_id: ticketId, priority: body.priority },
  });
  return c.json({ ticket_id: ticketId, public_ref: ref }, 201);
});

export default app;
