// B1 — Central de Tickets: contratos Zod/OpenAPI + rotas Hono.
// Intake público (RF-03), portal autenticado (RF-01/02), mensagens,
// triagem admin (RF-04), KB (RF-06) e sugestão IA (RF-07) — sem anexos (BD-04).

import { randomUUID } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getDb } from "../../db/connection.js";
import { suggestAiResponse } from "./tickets.ai.js";
import {
  assertAdmin,
  assertTenantScope,
  HttpError,
  type TicketsEnv,
  ticketsAuthMiddleware,
} from "./tickets.auth.js";
import { computeSlaDueDates } from "./tickets.sla.js";

// ---------- helpers ----------

/** Corpo de erro padrão em todos os contratos. */
const ErrorSchema = z.object({ error: z.string() });

/** Respostas de erro comuns para reuso nos contratos OpenAPI. */
function errorResponses<K extends number>(...codes: K[]) {
  const entries = codes.map(
    (code) =>
      [
        code,
        {
          content: { "application/json": { schema: ErrorSchema } },
          description: "Erro",
        },
      ] as const,
  );
  return Object.fromEntries(entries) as {
    [P in K]: {
      content: { "application/json": { schema: typeof ErrorSchema } };
      description: string;
    };
  };
}

function audit(
  action: string,
  opts: {
    tenantId?: string | null;
    actor: string;
    target?: string;
    before?: unknown;
    after?: unknown;
    correlationId?: string;
  },
): void {
  getDb()
    .prepare(
      `INSERT INTO audit_events (tenant_id, actor, action, target, before_json, after_json, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.tenantId ?? null,
      opts.actor,
      action,
      opts.target ?? null,
      opts.before === undefined ? null : JSON.stringify(opts.before),
      opts.after === undefined ? null : JSON.stringify(opts.after),
      opts.correlationId ?? null,
    );
}

function protocolCode(): string {
  // PROTO-YYYYMMDD-XXXXXXXX legível e único (UNIQUE global)
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const rand = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return `PROTO-${ymd}-${rand}`;
}

// ---------- intake rate limit (RF-03 antiabuso) ----------

const INTAKE_WINDOW_MS = 60_000;
const intakeHits = new Map<string, number[]>();

function intakeRateLimited(ip: string): {
  limited: boolean;
  retryAfter: number;
} {
  const max = Number(process.env.TICKETS_INTAKE_RATE_MAX ?? 5);
  const now = Date.now();
  const hits = (intakeHits.get(ip) ?? []).filter(
    (t) => now - t < INTAKE_WINDOW_MS,
  );
  if (hits.length >= max) {
    const retryAfter = Math.max(
      1,
      Math.ceil((INTAKE_WINDOW_MS - (now - hits[0])) / 1000),
    );
    intakeHits.set(ip, hits);
    return { limited: true, retryAfter };
  }
  hits.push(now);
  intakeHits.set(ip, hits);
  return { limited: false, retryAfter: 0 };
}

// ---------- schemas ----------

const Priority = z.enum(["P1", "P2", "P3", "P4"]);

const IntakeSchema = z.object({
  requester_name: z.string().min(2).max(120),
  requester_email: z.string().email().max(200),
  requester_phone: z.string().max(40).optional(),
  subject: z.string().min(3).max(150),
  message: z.string().min(5).max(5000),
  consent_lgpd: z.literal(true),
});

const CreateTicketSchema = z.object({
  subject: z.string().min(3).max(150),
  description: z.string().min(5).max(10000),
  category: z.string().min(1).max(60).default("general"),
  priority: Priority.default("P3"),
});

const CreateMessageSchema = z.object({
  body: z.string().min(1).max(10000),
  visibility: z.enum(["internal", "public"]).default("public"),
});

const ConvertTriageSchema = z.object({
  tenant_id: z.string().min(1),
  note: z.string().max(2000).optional(),
});

const SuggestSchema = z.object({
  draft: z.string().min(1).max(10000),
  confidence: z.number().min(0).max(1).default(0.95),
  category: z.string().min(1).max(60).default("faq"),
});

const TicketListRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  subject: z.string(),
  status: z.string(),
  priority: z.string(),
  created_at: z.string(),
});

const MessageListRow = z.object({
  id: z.string(),
  author_type: z.string(),
  author_ref: z.string(),
  body: z.string(),
  visibility: z.string(),
  created_at: z.string(),
});

const TriageListRow = z.object({
  id: z.string(),
  protocol: z.string(),
  requester_name: z.string(),
  subject: z.string(),
  status: z.string(),
  tenant_id: z.string().nullable(),
  created_at: z.string(),
});

const KbListRow = z.object({
  id: z.string(),
  scope: z.string(),
  tenant_id: z.string().nullable(),
  title: z.string(),
  version: z.number(),
  approved_for_auto_send: z.number(),
  revoked: z.number(),
});

const TicketRow = z.object({}).passthrough();

// ---------- rotas ----------

export function buildTicketsRoutes(): OpenAPIHono<TicketsEnv> {
  const app = new OpenAPIHono<TicketsEnv>();

  // Erros HttpError → status + mensagem genérica (não vaza interno)
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 401);
    }
    console.error("[tickets] unhandled:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  // ===== intake público (RF-03) — sem auth, cria somente triage_request =====
  const intakeRoute = createRoute({
    method: "post",
    path: "/public/intake",
    summary: "Intake público — cria solicitação de triagem com protocolo",
    tags: ["tickets"],
    request: {
      body: {
        content: { "application/json": { schema: IntakeSchema } },
      },
    },
    responses: {
      201: {
        content: {
          "application/json": {
            schema: z.object({ protocol: z.string() }),
          },
        },
        description: "Solicitação registrada; protocolo retornado",
      },
      ...errorResponses(400, 429),
    },
  });
  app.openapi(intakeRoute, async (c) => {
    // antiabuso: janela fixa por IP antes de qualquer parse/validação
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const { limited, retryAfter } = intakeRateLimited(ip);
    if (limited) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "muitas solicitações" }, 429);
    }
    const data = c.req.valid("json");
    const id = randomUUID();
    const protocol = protocolCode();
    getDb()
      .prepare(
        `INSERT INTO triage_requests (id, protocol, requester_name, requester_email, requester_phone, subject, message, consent_lgpd, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'public_form')`,
      )
      .run(
        id,
        protocol,
        data.requester_name,
        data.requester_email,
        data.requester_phone ?? null,
        data.subject,
        data.message,
      );
    audit("triage.intake", {
      actor: "public",
      target: id,
      after: { protocol },
    });
    return c.json({ protocol }, 201);
  });

  // ===== portal autenticado (RF-01/RF-02) =====
  app.use("/portal/*", ticketsAuthMiddleware);

  const listTicketsRoute = createRoute({
    method: "get",
    path: "/portal/tickets",
    summary: "Lista tickets do tenant da identidade",
    tags: ["tickets"],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ data: z.array(TicketListRow) }),
          },
        },
        description: "Tickets do tenant",
      },
      ...errorResponses(401, 403),
    },
  });
  app.openapi(listTicketsRoute, (c) => {
    const auth = c.get("ticketsAuth");
    const rows = getDb()
      .prepare(
        "SELECT id, tenant_id, subject, status, priority, created_at FROM tickets WHERE tenant_id = ? ORDER BY created_at DESC",
      )
      .all(auth.tenantId ?? "") as z.infer<typeof TicketListRow>[];
    return c.json({ data: rows }, 200);
  });

  const createTicketRoute = createRoute({
    method: "post",
    path: "/portal/tickets",
    summary: "Cria ticket no tenant da identidade (tenant nunca vem do client)",
    tags: ["tickets"],
    request: {
      body: { content: { "application/json": { schema: CreateTicketSchema } } },
    },
    responses: {
      201: {
        content: {
          "application/json": {
            schema: z.object({ id: z.string(), tenant_id: z.string() }),
          },
        },
        description: "Ticket criado",
      },
      ...errorResponses(400, 401, 403),
    },
  });
  app.openapi(createTicketRoute, async (c) => {
    const auth = c.get("ticketsAuth");
    if (!auth.tenantId) throw new HttpError(403, "sem acesso");
    const data = c.req.valid("json");
    const id = randomUUID();
    const { firstResponseDueAt, resolutionDueAt } = computeSlaDueDates(
      data.priority,
      new Date(),
    );
    getDb()
      .prepare(
        `INSERT INTO tickets (id, tenant_id, source, status, priority, subject, description, category, requester_ref, created_by, first_response_due_at, resolution_due_at)
         VALUES (?, ?, 'portal', 'new', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        auth.tenantId,
        data.priority,
        data.subject,
        data.description,
        data.category,
        auth.uid,
        auth.uid,
        firstResponseDueAt,
        resolutionDueAt,
      );
    audit("ticket.created", {
      tenantId: auth.tenantId,
      actor: auth.uid,
      target: id,
      after: { priority: data.priority, category: data.category },
    });
    return c.json({ id, tenant_id: auth.tenantId }, 201);
  });

  const getTicketRoute = createRoute({
    method: "get",
    path: "/portal/tickets/{id}",
    summary: "Detalhe do ticket (isolamento: outro tenant = 404)",
    tags: ["tickets"],
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: TicketRow } },
        description: "Ticket",
      },
      ...errorResponses(401, 403, 404),
    },
  });
  app.openapi(getTicketRoute, (c) => {
    const auth = c.get("ticketsAuth");
    const id = c.req.param("id");
    const row = getDb()
      .prepare("SELECT * FROM tickets WHERE id = ? AND tenant_id = ?")
      .get(id, auth.tenantId ?? "") as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, "não encontrado"); // não revela existência
    return c.json(row, 200);
  });

  const listMessagesRoute = createRoute({
    method: "get",
    path: "/portal/tickets/{id}/messages",
    summary: "Histórico de mensagens do ticket",
    tags: ["tickets"],
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ data: z.array(MessageListRow) }),
          },
        },
        description: "Mensagens",
      },
      ...errorResponses(401, 403, 404),
    },
  });
  app.openapi(listMessagesRoute, (c) => {
    const auth = c.get("ticketsAuth");
    const id = c.req.param("id");
    const scopeTenant = auth.tenantId ?? "";
    const ticket = getDb()
      .prepare("SELECT id FROM tickets WHERE id = ? AND tenant_id = ?")
      .get(id, scopeTenant);
    if (!ticket) throw new HttpError(404, "não encontrado");
    const rows = getDb()
      .prepare(
        "SELECT id, author_type, author_ref, body, visibility, created_at FROM ticket_messages WHERE ticket_id = ? AND tenant_id = ? ORDER BY created_at",
      )
      .all(id, scopeTenant) as z.infer<typeof MessageListRow>[];
    return c.json({ data: rows }, 200);
  });

  const createMessageRoute = createRoute({
    method: "post",
    path: "/portal/tickets/{id}/messages",
    summary: "Responde ticket (mensagem imutável atribuída)",
    tags: ["tickets"],
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: { "application/json": { schema: CreateMessageSchema } },
      },
    },
    responses: {
      201: {
        content: {
          "application/json": { schema: z.object({ id: z.string() }) },
        },
        description: "Mensagem criada",
      },
      ...errorResponses(400, 401, 403, 404),
    },
  });
  app.openapi(createMessageRoute, async (c) => {
    const auth = c.get("ticketsAuth");
    const id = c.req.param("id");
    const ticket = getDb()
      .prepare("SELECT id FROM tickets WHERE id = ? AND tenant_id = ?")
      .get(id, auth.tenantId ?? "");
    if (!ticket) throw new HttpError(404, "não encontrado");
    const data = c.req.valid("json");
    const mid = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO ticket_messages (id, ticket_id, tenant_id, author_type, author_ref, body, visibility)
         VALUES (?, ?, ?, 'human', ?, ?, ?)`,
      )
      .run(mid, id, auth.tenantId, auth.uid, data.body, data.visibility);
    getDb()
      .prepare("UPDATE tickets SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    // target omitido → cobre opts.target ?? null; sem after → cobre ramo undefined
    audit("ticket.message_created", {
      tenantId: auth.tenantId,
      actor: auth.uid,
      correlationId: id,
    });
    return c.json({ id: mid }, 201);
  });

  // ===== triagem admin (RF-04) =====
  app.use("/admin/*", ticketsAuthMiddleware);

  const listTriageRoute = createRoute({
    method: "get",
    path: "/admin/triage",
    summary: "Fila de triage_requests (admin)",
    tags: ["tickets"],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ data: z.array(TriageListRow) }),
          },
        },
        description: "Fila",
      },
      ...errorResponses(401, 403),
    },
  });
  app.openapi(listTriageRoute, (c) => {
    const auth = c.get("ticketsAuth");
    assertAdmin(auth);
    const rows = getDb()
      .prepare(
        "SELECT id, protocol, requester_name, subject, status, tenant_id, created_at FROM triage_requests ORDER BY created_at DESC",
      )
      .all() as z.infer<typeof TriageListRow>[];
    return c.json({ data: rows }, 200);
  });

  const convertTriageRoute = createRoute({
    method: "post",
    path: "/admin/triage/{id}/convert",
    summary: "Converte solicitação em ticket do tenant (auditoria obrigatória)",
    tags: ["tickets"],
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: { "application/json": { schema: ConvertTriageSchema } },
      },
    },
    responses: {
      201: {
        content: {
          "application/json": { schema: z.object({ ticket_id: z.string() }) },
        },
        description: "Convertida",
      },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });
  app.openapi(convertTriageRoute, async (c) => {
    const auth = c.get("ticketsAuth");
    assertAdmin(auth);
    const id = c.req.param("id");
    const { tenant_id: targetTenant, note } = c.req.valid("json");
    assertTenantScope(auth, targetTenant); // cross-tenant → 403
    const db = getDb();
    const tr = db
      .prepare("SELECT * FROM triage_requests WHERE id = ?")
      .get(id) as
      | { id: string; status: string; subject: string; message: string }
      | undefined;
    if (!tr) throw new HttpError(404, "não encontrado");
    if (tr.status === "converted") throw new HttpError(409, "já convertida");
    const ticketId = randomUUID();
    const { firstResponseDueAt, resolutionDueAt } = computeSlaDueDates(
      "P3",
      new Date(),
    );
    db.prepare(
      `INSERT INTO tickets (id, tenant_id, source, status, priority, subject, description, category, requester_ref, created_by, first_response_due_at, resolution_due_at)
       VALUES (?, ?, 'triage_conversion', 'new', 'P3', ?, ?, 'general', ?, ?, ?, ?)`,
    ).run(
      ticketId,
      targetTenant,
      tr.subject,
      tr.message,
      `triage:${id}`,
      auth.uid,
      firstResponseDueAt,
      resolutionDueAt,
    );
    db.prepare(
      "UPDATE triage_requests SET status = 'converted', converted_ticket_id = ?, reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ?",
    ).run(ticketId, new Date().toISOString(), auth.uid, note ?? null, id);
    audit("triage.converted", {
      tenantId: targetTenant,
      actor: auth.uid,
      target: id,
      before: { status: tr.status },
      after: { ticket_id: ticketId, note: note ?? null },
    });
    return c.json({ ticket_id: ticketId }, 201);
  });

  // ===== KB (RF-06) =====
  const listKbRoute = createRoute({
    method: "get",
    path: "/kb",
    summary: "Lista fontes KB (global + tenant) aprovadas e não revogadas",
    tags: ["tickets"],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ data: z.array(KbListRow) }),
          },
        },
        description: "Fontes",
      },
    },
  });
  app.openapi(listKbRoute, (c) => {
    const rows = getDb()
      .prepare(
        "SELECT id, scope, tenant_id, title, version, approved_for_auto_send, revoked FROM knowledge_sources WHERE revoked = 0",
      )
      .all() as z.infer<typeof KbListRow>[];
    return c.json({ data: rows }, 200);
  });

  // ===== sugestão IA (RF-07) =====
  app.use("/ai/*", ticketsAuthMiddleware);

  const suggestRoute = createRoute({
    method: "post",
    path: "/ai/suggest",
    summary:
      "Sugestão IA fail-closed (R1 FAQ global; sempre requer revisão humana)",
    tags: ["tickets"],
    request: {
      body: { content: { "application/json": { schema: SuggestSchema } } },
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({}).passthrough() },
        },
        description: "Decisão IA",
      },
      ...errorResponses(400, 401, 403),
    },
  });
  app.openapi(suggestRoute, async (c) => {
    const auth = c.get("ticketsAuth");
    const body = c.req.valid("json");
    const decision = suggestAiResponse({
      auth,
      ...body,
    });
    return c.json(decision, 200);
  });

  return app;
}
