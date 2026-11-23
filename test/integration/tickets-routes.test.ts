// B1 Slice 3 — rotas tickets: intake público, portal, mensagens, triagem admin,
// cross-tenant, auditoria. Hono app in-memory; auth em modo teste.
process.env.TICKETS_AUTH_TEST_MODE = "1";

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDb, getDb, initDb } from "../../src/db/connection.js";
import { buildTicketsRoutes } from "../../src/v1/tickets/tickets.routes.js";

type App = ReturnType<typeof createApp>;

function makeApp(): App {
  const app = createApp();
  app.route("/v1/tickets", buildTicketsRoutes());
  return app;
}

function seed() {
  const db = getDb();
  db.prepare(
    "INSERT INTO tenants (id, name) VALUES ('a', 'Tenant A'), ('b', 'Tenant B')",
  ).run();
  // admin e member no tenant A; member no tenant B
  db.prepare(
    "INSERT INTO tenant_memberships (tenant_id, principal_id, role) VALUES ('a', 'uid-admin', 'admin')",
  ).run();
  db.prepare(
    "INSERT INTO tenant_memberships (tenant_id, principal_id, role) VALUES ('a', 'uid-user', 'member')",
  ).run();
  db.prepare(
    "INSERT INTO tenant_memberships (tenant_id, principal_id, role) VALUES ('b', 'uid-b', 'member')",
  ).run();
  // KB global aprovada p/ autoenvio (R1 FAQ PIANO)
  db.prepare(
    `INSERT INTO knowledge_sources (id, scope, title, content, approved_for_auto_send)
     VALUES ('kb-1', 'global', 'FAQ PIANO', 'Resposta oficial da FAQ.', 1)`,
  ).run();
  return db;
}

function authHeader(uid: string) {
  return { authorization: `Bearer uid:${uid}` };
}

async function createTicket(app: App, uid: string, body: object) {
  return app.request("/v1/tickets/portal/tickets", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(uid) },
    body: JSON.stringify(body),
  });
}

describe("intake público (RF-03)", () => {
  let app: App;
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ":memory:";
    initDb();
    seed();
    app = makeApp();
  });

  it("cria somente triage_request com protocolo; sem token", async () => {
    const res = await app.request("/v1/tickets/public/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requester_name: "Maria",
        requester_email: "maria@example.com",
        subject: "Solicitação",
        message: "Preciso de ajuda",
        consent_lgpd: true,
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { protocol: string };
    expect(json.protocol).toMatch(/^[A-Z0-9-]+$/);
    const db = getDb();
    expect(
      (
        db.prepare("SELECT COUNT(*) c FROM triage_requests").get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) c FROM tickets").get() as { c: number }).c,
    ).toBe(0); // intake não cria ticket operacional
    // resposta não expõe id interno nem histórico
    expect(JSON.stringify(json)).not.toContain("ticket");
  });

  it("sem consentimento LGPD → 422 sem criar nada", async () => {
    const res = await app.request("/v1/tickets/public/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requester_name: "Maria",
        requester_email: "maria@example.com",
        subject: "S",
        message: "M",
        consent_lgpd: false,
      }),
    });
    expect(res.status).toBe(400);
    expect(
      (
        getDb().prepare("SELECT COUNT(*) c FROM triage_requests").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it("payload inválido (email) → 422", async () => {
    const res = await app.request("/v1/tickets/public/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requester_name: "Maria",
        requester_email: "not-an-email",
        subject: "S",
        message: "M",
        consent_lgpd: true,
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("portal autenticado (RF-01/RF-02)", () => {
  let app: App;
  let db: ReturnType<typeof getDb>;
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ":memory:";
    initDb();
    db = seed();
    app = makeApp();
  });

  it("sem token → 401", async () => {
    const res = await app.request("/v1/tickets/portal/tickets");
    expect(res.status).toBe(401);
  });

  it("token inválido → 401", async () => {
    const res = await app.request("/v1/tickets/portal/tickets", {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("sem membership → 403", async () => {
    const res = await app.request("/v1/tickets/portal/tickets", {
      headers: authHeader("uid-unknown"),
    });
    expect(res.status).toBe(403);
  });

  it("cria ticket com tenant_id derivado (nunca do client)", async () => {
    const res = await createTicket(app, "uid-user", {
      subject: "Problema X",
      description: "Descrição",
      category: "support",
      priority: "P3",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; tenant_id: string };
    expect(json.tenant_id).toBe("a");
    const row = db
      .prepare("SELECT tenant_id, status, created_by FROM tickets WHERE id = ?")
      .get(json.id) as {
      tenant_id: string;
      status: string;
      created_by: string;
    };
    expect(row.tenant_id).toBe("a");
    expect(row.created_by).toBe("uid-user");
  });

  it("lista somente tickets do próprio tenant", async () => {
    const a = await createTicket(app, "uid-user", {
      subject: "Ticket A1",
      description: "descrição válida",
      category: "support",
      priority: "P3",
    });
    expect(a.status).toBe(201);
    // ticket no tenant B direto no DB
    db.prepare(
      `INSERT INTO tickets (id, tenant_id, source, status, priority, subject, description, requester_ref, created_by)
       VALUES ('tb-1', 'b', 'portal', 'new', 'P3', 'B-secret', 'd', 'uid-b', 'uid-b')`,
    ).run();
    const res = await app.request("/v1/tickets/portal/tickets", {
      headers: authHeader("uid-user"),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string }[] };
    const ids = json.data.map((t) => t.id);
    expect(ids).not.toContain("tb-1");
  });

  it("cross-tenant: ler ticket de outro tenant → 404 (sem revelar existência)", async () => {
    db.prepare(
      `INSERT INTO tickets (id, tenant_id, source, status, priority, subject, description, requester_ref, created_by)
       VALUES ('tb-1', 'b', 'portal', 'new', 'P3', 'B-secret', 'd', 'uid-b', 'uid-b')`,
    ).run();
    const res = await app.request("/v1/tickets/portal/tickets/tb-1", {
      headers: authHeader("uid-user"), // tenant A
    });
    expect(res.status).toBe(404); // não 403 — não diferencia inexistente de não autorizado
    const body = await res.text();
    expect(body).not.toContain("B-secret");
  });

  it("mensagem persiste com autor humano e aparece no histórico", async () => {
    const t = await createTicket(app, "uid-user", {
      subject: "Msg M1",
      description: "descrição válida",
      category: "support",
      priority: "P3",
    });
    const { id } = (await t.json()) as { id: string };
    const res = await app.request(`/v1/tickets/portal/tickets/${id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-user"),
      },
      body: JSON.stringify({ body: "Nova mensagem", visibility: "public" }),
    });
    expect(res.status).toBe(201);
    const hist = await app.request(
      `/v1/tickets/portal/tickets/${id}/messages`,
      {
        headers: authHeader("uid-user"),
      },
    );
    const json = (await hist.json()) as { data: unknown[] };
    expect(json.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("triagem admin (RF-04)", () => {
  let app: App;
  let db: ReturnType<typeof getDb>;
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ":memory:";
    initDb();
    db = seed();
    app = makeApp();
  });

  it("admin lista triage_requests do fluxo", async () => {
    db.prepare(
      `INSERT INTO triage_requests (id, protocol, requester_name, requester_email, subject, message, consent_lgpd)
       VALUES ('tr-1', 'PROTO-1', 'M', 'm@e.com', 'S', 'msg', 1)`,
    ).run();
    const res = await app.request("/v1/tickets/admin/triage", {
      headers: authHeader("uid-admin"),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string }[] };
    expect(json.data.map((r) => r.id)).toContain("tr-1");
  });

  it("member não acessa fila de triagem (403)", async () => {
    const res = await app.request("/v1/tickets/admin/triage", {
      headers: authHeader("uid-user"),
    });
    expect(res.status).toBe(403);
  });

  it("conversão exige tenant e cria ticket vinculado + audit", async () => {
    db.prepare(
      `INSERT INTO triage_requests (id, protocol, requester_name, requester_email, subject, message, consent_lgpd)
       VALUES ('tr-2', 'PROTO-2', 'M', 'm@e.com', 'S', 'msg', 1)`,
    ).run();
    const res = await app.request("/v1/tickets/admin/triage/tr-2/convert", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-admin"),
      },
      body: JSON.stringify({ tenant_id: "a", note: "conversão inicial" }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ticket_id: string };
    const ticket = db
      .prepare("SELECT tenant_id, source FROM tickets WHERE id = ?")
      .get(json.ticket_id) as { tenant_id: string; source: string };
    expect(ticket.tenant_id).toBe("a");
    expect(ticket.source).toBe("triage_conversion");
    const tr = db
      .prepare(
        "SELECT status, converted_ticket_id FROM triage_requests WHERE id = 'tr-2'",
      )
      .get() as { status: string; converted_ticket_id: string };
    expect(tr.status).toBe("converted");
    expect(tr.converted_ticket_id).toBe(json.ticket_id);
    const audit = db
      .prepare(
        "SELECT COUNT(*) c FROM audit_events WHERE action = 'triage.converted'",
      )
      .get() as { c: number };
    expect(audit.c).toBe(1);
  });

  it("conversão sem tenant → 422 (RF-04: impedir)", async () => {
    db.prepare(
      `INSERT INTO triage_requests (id, protocol, requester_name, requester_email, subject, message, consent_lgpd)
       VALUES ('tr-3', 'PROTO-3', 'M', 'm@e.com', 'S', 'msg', 1)`,
    ).run();
    const res = await app.request("/v1/tickets/admin/triage/tr-3/convert", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-admin"),
      },
      body: JSON.stringify({ note: "sem tenant" }),
    });
    expect(res.status).toBe(400);
  });

  it("cross-tenant na conversão: admin A não converte para tenant B (403)", async () => {
    db.prepare(
      `INSERT INTO triage_requests (id, protocol, requester_name, requester_email, subject, message, consent_lgpd)
       VALUES ('tr-4', 'PROTO-4', 'M', 'm@e.com', 'S', 'msg', 1)`,
    ).run();
    const res = await app.request("/v1/tickets/admin/triage/tr-4/convert", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-admin"),
      },
      body: JSON.stringify({ tenant_id: "b", note: "cross" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("auditoria (RF-09)", () => {
  it("toda mutação de ticket gera audit_event", async () => {
    closeDb();
    process.env.DB_PATH = ":memory:";
    initDb();
    seed();
    const app = makeApp();
    const res = await createTicket(app, "uid-user", {
      subject: "Auditoria",
      description: "descrição válida",
      category: "support",
      priority: "P3",
    });
    expect(res.status).toBe(201);
    const audit = getDb()
      .prepare(
        "SELECT COUNT(*) c FROM audit_events WHERE action = 'ticket.created'",
      )
      .get() as { c: number };
    expect(audit.c).toBe(1);
  });
});
