/**
 * SPEC central-tickets v1.0.0 (frozen 2026-11-21) — B1 API acceptance tests.
 * Isolamento tenant, RBAC, intake público, IA fail-closed, auditoria.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { verifyIdTokenMock } = vi.hoisted(() => ({
  verifyIdTokenMock: vi.fn(),
}));
vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(() => ({})),
  cert: vi.fn(() => ({})),
}));
vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({ verifyIdToken: verifyIdTokenMock })),
}));

import { Hono } from "hono";
import { getDb, initDb } from "../../src/db/connection.js";
import {
  requireTicketRole,
  type TicketsEnv,
  ticketsAuth,
} from "../../src/v1/tickets/auth.middleware.js";
import intakeRoutes from "../../src/v1/tickets/intake.routes.js";
import kbRoutes from "../../src/v1/tickets/kb.routes.js";
import ticketsRoutes from "../../src/v1/tickets/tickets.routes.js";

const U_NDAAD_CLIENT = { uid: "uid-ndaad-client", email: "cli@ndaad.org" };
const U_NDAAD_AGENT = { uid: "uid-ndaad-agent", email: "agente@ndaad.org" };
const U_OTHER_CLIENT = { uid: "uid-other-client", email: "cli@other.com" };

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function stubUser(u: { uid: string; email: string }) {
  verifyIdTokenMock.mockResolvedValue({ uid: u.uid, email: u.email });
}

async function seedMembership(
  tenant: string,
  uid: string,
  role: string,
): Promise<void> {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO tickets_memberships (tenant_id, firebase_uid, role) VALUES (?,?,?)",
    )
    .run(tenant, uid, role);
  await new Promise((r) => setTimeout(r, 5));
}

let app: Hono<TicketsEnv>;

beforeAll(() => {
  process.env.FIREBASE_SERVICE_ACCOUNT ??= JSON.stringify({ project_id: "t" });
  initDb();
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO tickets_tenants (id, name) VALUES ('other-co','Other')",
    )
    .run();
  app = new Hono<TicketsEnv>();
  app.route("/v1/tickets", ticketsRoutes);
  app.route("/v1/tickets-intake", intakeRoutes);
  app.route("/v1/tickets-kb", kbRoutes);
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("auth tenant-aware", () => {
  it("sem token → 401", async () => {
    const res = await app.request("/v1/tickets");
    expect(res.status).toBe(401);
  });

  it("token inválido → 401", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("bad token"));
    const res = await app.request("/v1/tickets", {
      headers: bearer("aaa.bbb.ccc"),
    });
    expect(res.status).toBe(401);
  });

  it("token válido sem membership → 403", async () => {
    stubUser(U_OTHER_CLIENT);
    const res = await app.request("/v1/tickets", {
      headers: bearer("aaa.bbb.ccc"),
    });
    expect(res.status).toBe(403);
  });
});

describe("isolamento cross-tenant", () => {
  it("cliente NDAAD não acessa ticket de outro tenant", async () => {
    stubUser(U_NDAAD_CLIENT);
    await seedMembership("ndaad", U_NDAAD_CLIENT.uid, "client");
    // cria ticket em tenant fictício direto no DB
    const db = getDb();
    const info = db
      .prepare(
        "INSERT INTO tickets (public_ref, tenant_id, subject) VALUES ('X-OTHER','other-co','assunto')",
      )
      .run();
    const otherId = Number(info.lastInsertRowid);
    const res = await app.request(`/v1/tickets/${otherId}`, {
      headers: bearer("aaa.bbb.ccc"),
    });
    expect(res.status).toBe(404);
  });

  it("listar tickets só retorna do próprio tenant", async () => {
    stubUser(U_NDAAD_CLIENT);
    await seedMembership("ndaad", U_NDAAD_CLIENT.uid, "client");
    const res = await app.request("/v1/tickets", {
      headers: bearer("aaa.bbb.ccc"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { tenant_id: string }[] };
    expect(body.items.every((t) => t.tenant_id === "ndaad")).toBe(true);
  });
});

describe("portal cliente", () => {
  it("cria ticket + primeira mensagem, status open", async () => {
    stubUser(U_NDAAD_CLIENT);
    await seedMembership("ndaad", U_NDAAD_CLIENT.uid, "client");
    const res = await app.request("/v1/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("aaa.bbb.ccc") },
      body: JSON.stringify({
        subject: "Não consigo baixar hinário",
        priority: "P3",
        message: "Download falha no Android 14.",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: number;
      public_ref: string;
      status: string;
    };
    expect(body.status).toBe("open");
    expect(body.public_ref).toMatch(/^TKT-/);
    const msgs = getDb()
      .prepare("SELECT * FROM tickets_messages WHERE ticket_id = ?")
      .all(body.id) as { author_type: string }[];
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.author_type).toBe("client");
  });

  it("cliente responde ticket próprio", async () => {
    stubUser(U_NDAAD_CLIENT);
    await seedMembership("ndaad", U_NDAAD_CLIENT.uid, "client");
    const create = await app.request("/v1/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("aaa.bbb.ccc") },
      body: JSON.stringify({
        subject: "segundo ticket",
        priority: "P4",
        message: "m",
      }),
    });
    const { id } = (await create.json()) as { id: number };
    const res = await app.request(`/v1/tickets/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("aaa.bbb.ccc") },
      body: JSON.stringify({ body: "continua falhando" }),
    });
    expect(res.status).toBe(201);
  });

  it("cliente não usa nota interna", async () => {
    stubUser(U_NDAAD_CLIENT);
    await seedMembership("ndaad", U_NDAAD_CLIENT.uid, "client");
    const create = await app.request("/v1/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("aaa.bbb.ccc") },
      body: JSON.stringify({
        subject: "terceiro ticket",
        priority: "P4",
        message: "m",
      }),
    });
    const { id } = (await create.json()) as { id: number };
    const res = await app.request(`/v1/tickets/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("aaa.bbb.ccc") },
      body: JSON.stringify({ body: "nota", internal_note: true }),
    });
    expect(res.status).toBe(403);
  });
});

describe("RBAC agente", () => {
  it("agente (não admin) não altera membership", async () => {
    stubUser(U_NDAAD_AGENT);
    await seedMembership("ndaad", U_NDAAD_AGENT.uid, "agent");
    const res = await app.request("/v1/tickets/memberships", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("aaa.bbb.ccc") },
      body: JSON.stringify({
        firebase_uid: "uid-x",
        role: "client",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("agente tria intake → converte em ticket", async () => {
    stubUser(U_NDAAD_AGENT);
    await seedMembership("ndaad", U_NDAAD_AGENT.uid, "agent");
    const intake = await app.request("/v1/tickets-intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Maria",
        email: "maria@ex.com",
        subject: "Problema no login",
        message: "Não consigo entrar",
      }),
    });
    expect(intake.status).toBe(201);
    const { id } = (await intake.json()) as { id: number; protocol: string };
    const res = await app.request(`/v1/tickets-intake/${id}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("aaa.bbb.ccc") },
      body: JSON.stringify({ priority: "P3", note: "convertido" }),
    });
    expect(res.status).toBe(201);
    const conv = (await res.json()) as {
      ticket_id: number;
      public_ref: string;
    };
    expect(conv.ticket_id).toBeGreaterThan(0);
    expect(conv.public_ref).toMatch(/^TKT-/);
  });
});

describe("KB global + tenant", () => {
  it("cliente lê artigos globais + do próprio tenant, não de outros", async () => {
    stubUser(U_NDAAD_CLIENT);
    await seedMembership("ndaad", U_NDAAD_CLIENT.uid, "client");
    const db = getDb();
    db.prepare(
      "INSERT OR IGNORE INTO tickets_kb_articles (tenant_id, slug, title, body, status) VALUES (NULL,'g1','Global','corpo','published')",
    ).run();
    db.prepare(
      "INSERT OR IGNORE INTO tickets_kb_articles (tenant_id, slug, title, body, status) VALUES ('ndaad','n1','NDAAD','corpo','published')",
    ).run();
    db.prepare(
      "INSERT OR IGNORE INTO tickets_kb_articles (tenant_id, slug, title, body, status) VALUES ('other-co','o1','Other','corpo','published')",
    ).run();
    const res = await app.request("/v1/tickets-kb", {
      headers: bearer("aaa.bbb.ccc"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { slug: string }[] };
    const slugs = body.items.map((a) => a.slug);
    expect(slugs).toContain("g1");
    expect(slugs).toContain("n1");
    expect(slugs).not.toContain("o1");
  });
});

describe("IA fail-closed", () => {
  it("policy disabled → sugestão negada (não gera resposta automática)", async () => {
    stubUser(U_NDAAD_AGENT);
    await seedMembership("ndaad", U_NDAAD_AGENT.uid, "agent");
    const create = await app.request("/v1/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("aaa.bbb.ccc") },
      body: JSON.stringify({ subject: "s-ia", priority: "P4", message: "m" }),
    });
    const { id } = (await create.json()) as { id: number };
    const res = await app.request(`/v1/tickets/${id}/ai-suggestion`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("aaa.bbb.ccc") },
      body: JSON.stringify({ opt_in: true }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/desativada/i);
  });
});

describe("auditoria append-only", () => {
  it("criação de ticket gera registro de audit", async () => {
    stubUser(U_NDAAD_CLIENT);
    await seedMembership("ndaad", U_NDAAD_CLIENT.uid, "client");
    await app.request("/v1/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("aaa.bbb.ccc") },
      body: JSON.stringify({
        subject: "s-audit",
        priority: "P4",
        message: "m",
      }),
    });
    const audit = getDb()
      .prepare(
        "SELECT * FROM tickets_audit WHERE action = 'ticket.created' ORDER BY id DESC LIMIT 1",
      )
      .get() as { tenant_id: string } | undefined;
    expect(audit).toBeDefined();
    expect(audit?.tenant_id).toBe("ndaad");
  });
});

describe("SLA", () => {
  it("P1 calcula due dates na criação", async () => {
    stubUser(U_NDAAD_AGENT);
    await seedMembership("ndaad", U_NDAAD_AGENT.uid, "agent");
    const res = await app.request("/v1/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("aaa.bbb.ccc") },
      body: JSON.stringify({ subject: "sla", priority: "P1", message: "m" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { firstResponseDue: string | null };
    expect(body.firstResponseDue).toBeTruthy();
  });
});

describe("requireTicketRole unit", () => {
  it("role insuficiente → 403", async () => {
    stubUser(U_NDAAD_CLIENT);
    await seedMembership("ndaad", U_NDAAD_CLIENT.uid, "client");
    const res = await app.request("/v1/tickets/intake", {
      headers: bearer("aaa.bbb.ccc"),
    });
    expect(res.status).toBe(403);
  });
});
