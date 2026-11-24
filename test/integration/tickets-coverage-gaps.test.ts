// Fecha gaps de cobertura: onError 500, global_operator, KB, AI suggest,
// convert 404/409, mensagens 404, auth.tenantId nullish.
process.env.TICKETS_AUTH_TEST_MODE = "1";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import * as connection from "../../src/db/connection.js";
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
  db.prepare(
    "INSERT INTO tenant_memberships (tenant_id, principal_id, role) VALUES ('a', 'uid-admin', 'admin')",
  ).run();
  db.prepare(
    "INSERT INTO tenant_memberships (tenant_id, principal_id, role) VALUES ('a', 'uid-user', 'member')",
  ).run();
  db.prepare(
    "INSERT INTO tenant_memberships (tenant_id, principal_id, role) VALUES ('a', 'uid-global', 'global_operator')",
  ).run();
  db.prepare(
    `INSERT INTO knowledge_sources (id, scope, title, content, approved_for_auto_send)
     VALUES ('kb-1', 'global', 'FAQ PIANO', 'Resposta oficial da FAQ.', 1)`,
  ).run();
  return db;
}

function authHeader(uid: string) {
  return { authorization: `Bearer uid:${uid}` };
}

describe("tickets coverage gaps", () => {
  let app: App;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ":memory:";
    initDb();
    db = seed();
    app = makeApp();
  });

  it("onError: erro não-HttpError → 500 genérico", async () => {
    const spy = vi.spyOn(connection, "getDb").mockImplementation(() => {
      throw new Error("db exploded");
    });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
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
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Internal Server Error");
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it("global_operator não cria ticket de portal (sem tenant) → 403", async () => {
    const res = await app.request("/v1/tickets/portal/tickets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-global"),
      },
      body: JSON.stringify({
        subject: "Assunto global",
        description: "descrição válida",
        category: "support",
        priority: "P3",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("global_operator lista portal com escopo vazio (tenantId null)", async () => {
    db.prepare(
      `INSERT INTO tickets (id, tenant_id, source, status, priority, subject, description, requester_ref, created_by)
       VALUES ('t-a', 'a', 'portal', 'new', 'P3', 'A', 'd', 'uid-user', 'uid-user')`,
    ).run();
    const res = await app.request("/v1/tickets/portal/tickets", {
      headers: authHeader("uid-global"),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toEqual([]);
  });

  it("global_operator converte triage para qualquer tenant (assertTenantScope)", async () => {
    db.prepare(
      `INSERT INTO triage_requests (id, protocol, requester_name, requester_email, subject, message, consent_lgpd)
       VALUES ('tr-g', 'PROTO-G', 'M', 'm@e.com', 'S', 'msg', 1)`,
    ).run();
    const res = await app.request("/v1/tickets/admin/triage/tr-g/convert", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-global"),
      },
      body: JSON.stringify({ tenant_id: "b", note: "ops global" }),
    });
    expect(res.status).toBe(201);
    const audit = db
      .prepare(
        "SELECT before_json FROM audit_events WHERE action = 'triage.converted'",
      )
      .get() as { before_json: string };
    expect(JSON.parse(audit.before_json)).toEqual({ status: "new" });
  });

  it("convert triage inexistente → 404", async () => {
    const res = await app.request("/v1/tickets/admin/triage/missing/convert", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-admin"),
      },
      body: JSON.stringify({ tenant_id: "a" }),
    });
    expect(res.status).toBe(404);
  });

  it("convert triage já convertida → 409", async () => {
    db.prepare(
      `INSERT INTO triage_requests (id, protocol, requester_name, requester_email, subject, message, consent_lgpd, status)
       VALUES ('tr-done', 'PROTO-D', 'M', 'm@e.com', 'S', 'msg', 1, 'converted')`,
    ).run();
    const res = await app.request("/v1/tickets/admin/triage/tr-done/convert", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-admin"),
      },
      body: JSON.stringify({ tenant_id: "a" }),
    });
    expect(res.status).toBe(409);
  });

  it("mensagens de ticket inexistente → 404", async () => {
    const res = await app.request("/v1/tickets/portal/tickets/nope/messages", {
      headers: authHeader("uid-user"),
    });
    expect(res.status).toBe(404);
  });

  it("POST mensagem em ticket inexistente → 404", async () => {
    const res = await app.request("/v1/tickets/portal/tickets/nope/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-user"),
      },
      body: JSON.stringify({ body: "oi", visibility: "public" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /kb lista fontes não revogadas", async () => {
    const res = await app.request("/v1/tickets/kb");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string }[] };
    expect(json.data.map((r) => r.id)).toContain("kb-1");
  });

  it("POST /ai/suggest retorna draft com revisão humana", async () => {
    const res = await app.request("/v1/tickets/ai/suggest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-user"),
      },
      body: JSON.stringify({
        draft: "Resposta sugerida da FAQ",
        confidence: 0.99,
        category: "faq",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      suggestion: string;
      decision: string;
      requiresHumanReview: boolean;
      runId: string;
    };
    expect(json.suggestion).toContain("FAQ");
    expect(json.decision).toBe("draft");
    expect(json.requiresHumanReview).toBe(true);
    expect(json.runId).toBeTruthy();
  });

  it("detalhe de ticket inexistente no tenant → 404", async () => {
    const res = await app.request("/v1/tickets/portal/tickets/missing", {
      headers: authHeader("uid-user"),
    });
    expect(res.status).toBe(404);
  });

  it("GET ticket existente → 200", async () => {
    db.prepare(
      `INSERT INTO tickets (id, tenant_id, source, status, priority, subject, description, requester_ref, created_by)
       VALUES ('t-ok', 'a', 'portal', 'new', 'P3', 'Assunto', 'desc', 'uid-user', 'uid-user')`,
    ).run();
    const res = await app.request("/v1/tickets/portal/tickets/t-ok", {
      headers: authHeader("uid-user"),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; subject: string };
    expect(json.id).toBe("t-ok");
    expect(json.subject).toBe("Assunto");
  });

  it("global_operator: get/messages usam tenantId nullish (escopo vazio)", async () => {
    db.prepare(
      `INSERT INTO tickets (id, tenant_id, source, status, priority, subject, description, requester_ref, created_by)
       VALUES ('t-a2', 'a', 'portal', 'new', 'P3', 'A', 'd', 'uid-user', 'uid-user')`,
    ).run();
    const get = await app.request("/v1/tickets/portal/tickets/t-a2", {
      headers: authHeader("uid-global"),
    });
    expect(get.status).toBe(404);
    const msgs = await app.request("/v1/tickets/portal/tickets/t-a2/messages", {
      headers: authHeader("uid-global"),
    });
    expect(msgs.status).toBe(404);
    const post = await app.request("/v1/tickets/portal/tickets/t-a2/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-global"),
      },
      body: JSON.stringify({ body: "oi", visibility: "public" }),
    });
    expect(post.status).toBe(404);
  });

  it("convert sem note → note null no audit/update", async () => {
    db.prepare(
      `INSERT INTO triage_requests (id, protocol, requester_name, requester_email, subject, message, consent_lgpd)
       VALUES ('tr-note', 'PROTO-N', 'M', 'm@e.com', 'S', 'msg', 1)`,
    ).run();
    const res = await app.request("/v1/tickets/admin/triage/tr-note/convert", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-admin"),
      },
      body: JSON.stringify({ tenant_id: "a" }),
    });
    expect(res.status).toBe(201);
    const audit = db
      .prepare(
        "SELECT after_json FROM audit_events WHERE action = 'triage.converted' ORDER BY id DESC LIMIT 1",
      )
      .get() as { after_json: string };
    expect(JSON.parse(audit.after_json).note).toBeNull();
  });
});
