// B1.2 delta sobre staging — reopen_count, PATCH status, escalada P1 SLA.
process.env.TICKETS_AUTH_TEST_MODE = "1";

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDb, getDb, initDb } from "../../src/db/connection.js";
import { escalateBreached } from "../../src/v1/tickets/escalation.js";
import { buildTicketsRoutes } from "../../src/v1/tickets/tickets.routes.js";

type App = ReturnType<typeof createApp>;

function makeApp(): App {
  const app = createApp();
  app.route("/v1/tickets", buildTicketsRoutes());
  return app;
}

function seed() {
  const db = getDb();
  db.prepare("INSERT INTO tenants (id, name) VALUES ('a', 'Tenant A')").run();
  db.prepare(
    "INSERT INTO tenant_memberships (tenant_id, principal_id, role) VALUES ('a', 'uid-admin', 'admin')",
  ).run();
  db.prepare(
    `INSERT INTO knowledge_sources (id, scope, title, content, approved_for_auto_send)
     VALUES ('kb-1', 'global', 'FAQ PIANO', 'Resposta oficial.', 1)`,
  ).run();
}

function authHeader(uid: string) {
  return { authorization: `Bearer uid:${uid}` };
}

describe("B1.2 delta: PATCH status + reopen_count", () => {
  let app: App;
  let ticketId: string;
  beforeEach(async () => {
    closeDb();
    process.env.DB_PATH = ":memory:";
    initDb();
    seed();
    app = makeApp();
    const res = await app.request("/v1/tickets/portal/tickets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-admin"),
      },
      body: JSON.stringify({
        subject: "Assunto teste",
        description: "Descrição completa do ticket.",
        priority: "P3",
      }),
    });
    const j = (await res.json()) as { id: string };
    ticketId = j.id;
  });

  it("PATCH resolved → reopened incrementa reopen_count e grava reopened_at + audit", async () => {
    await app.request(`/v1/tickets/portal/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-admin"),
      },
      body: JSON.stringify("resolved"),
    });
    const res = await app.request(
      `/v1/tickets/portal/tickets/${ticketId}/status`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...authHeader("uid-admin"),
        },
        body: JSON.stringify("reopened"),
      },
    );
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare(
        "SELECT status, reopen_count, reopened_at FROM tickets WHERE id = ?",
      )
      .get(ticketId) as {
      status: string;
      reopen_count: number;
      reopened_at: string;
    };
    expect(row.status).toBe("reopened");
    expect(row.reopen_count).toBe(1);
    expect(row.reopened_at).toBeTruthy();
    const audit = getDb()
      .prepare(
        "SELECT action FROM audit_events WHERE action = 'ticket.reopened'",
      )
      .get();
    expect(audit).toBeTruthy();
  });

  it("cross-tenant PATCH → 404", async () => {
    getDb()
      .prepare(
        "INSERT INTO tenant_memberships (tenant_id, principal_id, role) VALUES ('a', 'uid-x', 'member')",
      )
      .run();
    getDb().prepare("INSERT INTO tenants (id, name) VALUES ('b', 'B')").run();
    getDb()
      .prepare(
        "INSERT INTO tenant_memberships (tenant_id, principal_id, role) VALUES ('b', 'uid-b', 'admin')",
      )
      .run();
    const res = await app.request(
      `/v1/tickets/portal/tickets/${ticketId}/status`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeader("uid-b") },
        body: JSON.stringify("closed"),
      },
    );
    expect(res.status).toBe(404);
  });

  it("global_operator (tenantId null) PATCH → 404 sem tenant escopo", async () => {
    getDb()
      .prepare(
        "INSERT INTO tenant_memberships (tenant_id, principal_id, role) VALUES ('a', 'uid-global', 'global_operator')",
      )
      .run();
    const res = await app.request(
      `/v1/tickets/portal/tickets/${ticketId}/status`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...authHeader("uid-global"),
        },
        body: JSON.stringify("closed"),
      },
    );
    // ticket existe em tenant 'a' mas global_operator tem tenantId null (?? "")
    expect(res.status).toBe(404);
  });
});

describe("B1.2 delta: escalada P1 SLA", () => {
  let app: App;
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ":memory:";
    initDb();
    seed();
    app = makeApp();
  });

  it("P1 com first_response vencido e aberto → escalada única + audit", async () => {
    const res = await app.request("/v1/tickets/portal/tickets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeader("uid-admin"),
      },
      body: JSON.stringify({
        subject: "Assunto P1",
        description: "Descrição completa do ticket.",
        priority: "P1",
      }),
    });
    const j = (await res.json()) as { id: string };
    getDb()
      .prepare(
        "UPDATE tickets SET first_response_due_at = datetime('now', '-1 hour') WHERE id = ?",
      )
      .run(j.id);
    const created = escalateBreached();
    expect(created).toBe(1);
    expect(escalateBreached()).toBe(0); // idempotente
    const esc = getDb()
      .prepare("SELECT reason FROM tickets_escalations WHERE ticket_id = ?")
      .get(j.id) as { reason: string };
    expect(esc.reason).toContain("breached");
    const audit = getDb()
      .prepare(
        "SELECT action FROM audit_events WHERE action = 'ticket.escalated'",
      )
      .get();
    expect(audit).toBeTruthy();
  });
});
