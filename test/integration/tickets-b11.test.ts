/**
 * SPEC-B1.1 QA Remediation (frozen 2026-11-22) — P0/P1 acceptance tests.
 * Isolamento intake, tenant explícito 403, KB global, mensagens tenant, CORS, IA/kill/audit.
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

const U_NDAAD_AGENT = { uid: "uid-b11-agent", email: "agente@ndaad.org" };
const U_NDAAD_ADMIN = { uid: "uid-b11-admin", email: "admin@ndaad.org" };
const U_PIANO_ADMIN = { uid: "uid-b11-piano-admin", email: "admin@pianolouvorja.com.br" };
const U_OTHER_AGENT = { uid: "uid-b11-other-agent", email: "agente@other.com" };

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function stubUser(u: { uid: string; email: string }) {
  verifyIdTokenMock.mockResolvedValue({ uid: u.uid, email: u.email });
}

function seedMembership(tenant: string, uid: string, role: string) {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO tickets_memberships (tenant_id, firebase_uid, role) VALUES (?,?,?)",
    )
    .run(tenant, uid, role);
}

async function createIntake(subject = "Ajuda projeção B1.1") {
  const res = await app.request("/v1/tickets-intake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Cliente B11",
      email: "cli@ex.com",
      subject,
      message: "Mensagem intake B11.",
    }),
  });
  const b = (await res.json()) as { protocol: string };
  return b.protocol;
}

let app: Hono<TicketsEnv>;

beforeAll(() => {
  process.env.FIREBASE_SERVICE_ACCOUNT ??= JSON.stringify({ project_id: "t" });
  initDb();
  getDb()
    .prepare("INSERT OR IGNORE INTO tickets_tenants (id, name) VALUES ('other-co','Other')")
    .run();
  getDb()
    .prepare("INSERT OR IGNORE INTO tickets_tenants (id, name) VALUES ('piano','PIANO')")
    .run();
  seedMembership("ndaad", U_NDAAD_AGENT.uid, "agent");
  seedMembership("ndaad", U_NDAAD_ADMIN.uid, "admin");
  seedMembership("piano", U_PIANO_ADMIN.uid, "admin");
  seedMembership("other-co", U_OTHER_AGENT.uid, "agent");
  app = new Hono<TicketsEnv>();
  app.route("/v1/tickets", ticketsRoutes);
  app.route("/v1/tickets-intake", intakeRoutes);
  app.route("/v1/tickets-kb", kbRoutes);
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("P0-1 GET /intake não vaza PII nem intake fora da fila", () => {
  it("agente vê apenas fila new sem campos name/email/message", async () => {
    await createIntake("Intake fila 1");
    stubUser(U_NDAAD_AGENT);
    const res = await app.request("/v1/tickets/intake", {
      headers: bearer("x.y.z-agent"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.status).toBe("new");
      expect(item).not.toHaveProperty("name");
      expect(item).not.toHaveProperty("email");
      expect(item).not.toHaveProperty("message");
    }
  });

  it("intake triaged/converted/rejected sai da fila", async () => {
    const protocol = await createIntake("Intake velho");
    getDb()
      .prepare("UPDATE tickets_intake SET status='triaged' WHERE protocol=?")
      .run(protocol);
    stubUser(U_NDAAD_AGENT);
    const res = await app.request("/v1/tickets/intake", {
      headers: bearer("x.y.z-agent"),
    });
    const body = (await res.json()) as { items: { protocol: string }[] };
    expect(body.items.find((i) => i.protocol === protocol)).toBeUndefined();
  });

  it("triage grava auditoria com ator e tenant", async () => {
    const protocol = await createIntake("Intake audit triage");
    const id = (
      getDb()
        .prepare("SELECT id FROM tickets_intake WHERE protocol=?")
        .get(protocol) as { id: number }
    ).id;
    stubUser(U_NDAAD_AGENT);
    const res = await app.request(`/v1/tickets-intake/${id}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("x.y.z-agent") },
      body: JSON.stringify({ priority: "P3", note: "converte B11" }),
    });
    expect(res.status).toBe(201);
    const audit = getDb()
      .prepare(
        "SELECT tenant_id, actor_uid, action FROM tickets_audit WHERE action = 'intake.triaged' ORDER BY id DESC LIMIT 1",
      )
      .get() as { tenant_id: string; actor_uid: string; action: string };
    expect(audit.tenant_id).toBe("ndaad");
    expect(audit.actor_uid).toBe(U_NDAAD_AGENT.uid);
  });
});

describe("P0-2 tenant explícito não autorizado → 403", () => {
  it("?tenant= de outra empresa → 403 (sem fallback)", async () => {
    stubUser(U_NDAAD_AGENT);
    const res = await app.request("/v1/tickets?tenant=other-co", {
      headers: bearer("x.y.z-agent"),
    });
    expect(res.status).toBe(403);
  });

  it("X-Tenant header não autorizado → 403", async () => {
    stubUser(U_NDAAD_AGENT);
    const res = await app.request("/v1/tickets", {
      headers: { ...bearer("x.y.z-agent"), "x-tenant": "other-co" },
    });
    expect(res.status).toBe(403);
  });

  it("sem tenant informado → default primeira membership", async () => {
    stubUser(U_NDAAD_AGENT);
    const res = await app.request("/v1/tickets", {
      headers: bearer("x.y.z-agent"),
    });
    expect(res.status).toBe(200);
  });
});

describe("P1-3 KB global só operador global (admin piano)", () => {
  it("agent ndaad cria KB global → 403", async () => {
    stubUser(U_NDAAD_AGENT);
    const res = await app.request("/v1/tickets-kb", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("x.y.z-agent") },
      body: JSON.stringify({
        slug: "global-indevida-agent",
        title: "Global indevida",
        body: "x",
        scope: "global",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("admin ndaad cria KB global → 403", async () => {
    stubUser(U_NDAAD_ADMIN);
    const res = await app.request("/v1/tickets-kb", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("x.y.z-nadmin") },
      body: JSON.stringify({
        slug: "global-indevida-nadmin",
        title: "Global indevida 2",
        body: "x",
        scope: "global",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("admin piano cria KB global → 201", async () => {
    stubUser(U_PIANO_ADMIN);
    const res = await app.request("/v1/tickets-kb", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("x.y.z-padmin") },
      body: JSON.stringify({
        slug: "global-ok-b11",
        title: "Global ok",
        body: "conteúdo",
        scope: "global",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("admin ndaad cria KB própria → 201", async () => {
    stubUser(U_NDAAD_ADMIN);
    const res = await app.request("/v1/tickets-kb", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("x.y.z-nadmin") },
      body: JSON.stringify({
        slug: "kb-ndaad-b11",
        title: "KB ndaad",
        body: "conteúdo",
        scope: "tenant",
      }),
    });
    expect(res.status).toBe(201);
  });
});

describe("P1-4 tickets_messages.tenant_id (migration 037)", () => {
  it("coluna tenant_id existe e é preenchida no backfill/novas mensagens", async () => {
    const cols = getDb()
      .prepare("PRAGMA table_info(tickets_messages)")
      .all() as { name: string; notnull: number }[];
    const tenantCol = cols.find((c) => c.name === "tenant_id");
    expect(tenantCol).toBeDefined();
    stubUser(U_NDAAD_AGENT);
    // ticket ndaad + mensagem nova
    const t = await app.request("/v1/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("x.y.z-agent") },
      body: JSON.stringify({ subject: "Msg tenant", message: "m", priority: "P3" }),
    });
    const tb = (await t.json()) as { id: number };
    await app.request(`/v1/tickets/${tb.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("x.y.z-agent") },
      body: JSON.stringify({ body: "primeira resposta" }),
    });
    const msg = getDb()
      .prepare("SELECT tenant_id FROM tickets_messages WHERE ticket_id=? ORDER BY id DESC")
      .get(tb.id) as { tenant_id: string };
    expect(msg.tenant_id).toBe("ndaad");
  });

  it("mensagens cross-tenant não aparecem (filtro por contexto)", async () => {
    // client other-co cria ticket próprio; agente ndaad não vê mensagens dele
    stubUser(U_OTHER_AGENT);
    const t = await app.request("/v1/tickets?tenant=other-co", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("x.y.z-oagent") },
      body: JSON.stringify({ subject: "Other ticket", message: "m", priority: "P4" }),
    });
    const tb = (await t.json()) as { id: number };
    await app.request(`/v1/tickets/${tb.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("x.y.z-oagent") },
      body: JSON.stringify({ body: "secreta other" }),
    });
    stubUser(U_NDAAD_AGENT);
    const res = await app.request(`/v1/tickets/${tb.id}/messages`, {
      headers: bearer("x.y.z-agent"),
    });
    expect(res.status).toBe(404); // cross-tenant: 404 uniforme, sem vazamento
    const list = await app.request("/v1/tickets", { headers: bearer("x.y.z-agent") });
    const lb = (await list.json()) as { items: { id: number }[] };
    expect(lb.items.find((i) => i.id === tb.id)).toBeUndefined();
  });
});

describe("P1-5 CORS fail-closed", () => {
  it("sem CORS_ORIGINS em produção → não reflete origem pedida", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevCors = process.env.CORS_ORIGINS;
    delete process.env.CORS_ORIGINS;
    process.env.NODE_ENV = "production";
    const { createApp } = await import("../../src/app.js");
    const prodApp = createApp();
    const res = await prodApp.request("/health", {
      headers: { origin: "https://evil.example" },
    });
    const allow = res.headers.get("access-control-allow-origin");
    process.env.NODE_ENV = prevNodeEnv;
    if (prevCors !== undefined) process.env.CORS_ORIGINS = prevCors;
    expect(allow === null || allow === "*").toBe(true);
    expect(allow).not.toBe("https://evil.example");
  });
});

describe("P1-6 RF-05 reabertura/escalada + RF-07/08/09 IA kill/audit", () => {
  async function createTicketAsAgent(subject: string) {
    stubUser(U_NDAAD_AGENT);
    const res = await app.request("/v1/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("x.y.z-agent") },
      body: JSON.stringify({ subject, message: "m", priority: "P3" }),
    });
    return ((await res.json()) as { id: number }).id;
  }

  it("reabertura resolved→open grava reopened_at/reopen_count e auditoria", async () => {
    const id = await createTicketAsAgent("Reabertura B11");
    await app.request(`/v1/tickets/${id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bearer("x.y.z-agent") },
      body: JSON.stringify({ status: "resolved" }),
    });
    const res = await app.request(`/v1/tickets/${id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bearer("x.y.z-agent") },
      body: JSON.stringify({ status: "open" }),
    });
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare("SELECT reopened_at, reopen_count FROM tickets WHERE id=?")
      .get(id) as { reopened_at: string | null; reopen_count: number };
    expect(row.reopened_at).not.toBeNull();
    expect(row.reopen_count).toBe(1);
  });

  it("histórico de mensagens preservado após reabertura", async () => {
    const id = await createTicketAsAgent("Histórico reabertura");
    await app.request(`/v1/tickets/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer("x.y.z-agent") },
      body: JSON.stringify({ body: "antes de resolver" }),
    });
    await app.request(`/v1/tickets/${id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bearer("x.y.z-agent") },
      body: JSON.stringify({ status: "resolved" }),
    });
    await app.request(`/v1/tickets/${id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bearer("x.y.z-agent") },
      body: JSON.stringify({ status: "open" }),
    });
    const res = await app.request(`/v1/tickets/${id}/messages`, {
      headers: bearer("x.y.z-agent"),
    });
    const body = (await res.json()) as { items: { body: string }[] };
    expect(body.items.some((m) => m.body === "antes de resolver")).toBe(true);
  });

  it("P1 SLA breached → escalada humana criada (job determinístico)", async () => {
    const id = await createTicketAsAgent("Escalada SLA");
    getDb().prepare("UPDATE tickets SET priority='P1' WHERE id=?").run(id);
    getDb()
      .prepare(
        "UPDATE tickets SET first_response_due_at = datetime('now','-2 hours') WHERE id=?",
      )
      .run(id);
    const { escalateBreached } = await import("../../src/v1/tickets/escalation.js");
    const n = escalateBreached();
    expect(n).toBeGreaterThanOrEqual(1);
    const esc = getDb()
      .prepare("SELECT reason, tenant_id FROM tickets_escalations WHERE ticket_id=?")
      .get(id) as { reason: string; tenant_id: string };
    expect(esc.tenant_id).toBe("ndaad");
    expect(esc.reason).toMatch(/sla|SLA/);
  });

  it("autoSendEligible: matriz R0–R3 + sinais", async () => {
    const { autoSendEligible } = await import("../../src/v1/tickets/ai.policy.js");
    const base = {
      tenantOptIn: true,
      globalKill: false,
      tenantKill: false,
      risk: "R0" as const,
      reopened: false,
      slaCritical: false,
      categoryAllowlisted: true,
      confidence: 0.95,
      approvedSourcesOnly: true,
      noSensitiveData: true,
    };
    expect(autoSendEligible({ ...base })).toBe(true);
    expect(autoSendEligible({ ...base, risk: "R1" })).toBe(true);
    expect(autoSendEligible({ ...base, risk: "R2" })).toBe(false);
    expect(autoSendEligible({ ...base, risk: "R3" })).toBe(false);
    expect(autoSendEligible({ ...base, tenantOptIn: false })).toBe(false);
    expect(autoSendEligible({ ...base, globalKill: true })).toBe(false);
    expect(autoSendEligible({ ...base, tenantKill: true })).toBe(false);
    expect(autoSendEligible({ ...base, reopened: true })).toBe(false);
    expect(autoSendEligible({ ...base, slaCritical: true })).toBe(false);
    expect(autoSendEligible({ ...base, categoryAllowlisted: false })).toBe(false);
    expect(autoSendEligible({ ...base, confidence: 0.5 })).toBe(false);
    expect(autoSendEligible({ ...base, approvedSourcesOnly: false })).toBe(false);
    expect(autoSendEligible({ ...base, noSensitiveData: false })).toBe(false);
  });

  it("kill switch global: GET/PUT por admin piano + auditoria antes/depois", async () => {
    stubUser(U_PIANO_ADMIN);
    const put = await app.request("/v1/tickets/admin/kill-switch", {
      method: "PUT",
      headers: { "content-type": "application/json", ...bearer("x.y.z-padmin") },
      body: JSON.stringify({ enabled: true, reason: "teste B11" }),
    });
    expect(put.status).toBe(200);
    const get = await app.request("/v1/tickets/admin/kill-switch", {
      headers: bearer("x.y.z-padmin"),
    });
    const gb = (await get.json()) as { enabled: boolean };
    expect(gb.enabled).toBe(true);
    const audit = getDb()
      .prepare(
        "SELECT metadata FROM tickets_audit WHERE action='kill_switch' ORDER BY id DESC LIMIT 1",
      )
      .get() as { metadata: string };
    expect(audit.metadata).toContain("teste B11");
    // restore
    await app.request("/v1/tickets/admin/kill-switch", {
      method: "PUT",
      headers: { "content-type": "application/json", ...bearer("x.y.z-padmin") },
      body: JSON.stringify({ enabled: false, reason: "restore" }),
    });
  });

  it("kill global on → enqueue bloqueado; decisão auditada como fila humana", async () => {
    stubUser(U_PIANO_ADMIN);
    await app.request("/v1/tickets/admin/kill-switch", {
      method: "PUT",
      headers: { "content-type": "application/json", ...bearer("x.y.z-padmin") },
      body: JSON.stringify({ enabled: true, reason: "bloqueio teste" }),
    });
    const { enqueueAutoReplies } = await import("../../src/v1/tickets/ai.policy.js");
    const out = enqueueAutoReplies();
    expect(out.enqueued).toBe(0);
    const audit = getDb()
      .prepare(
        "SELECT metadata FROM tickets_audit WHERE action='ai_decision' ORDER BY id DESC LIMIT 1",
      )
      .get() as { metadata: string };
    expect(audit.metadata).toContain("kill");
    await app.request("/v1/tickets/admin/kill-switch", {
      method: "PUT",
      headers: { "content-type": "application/json", ...bearer("x.y.z-padmin") },
      body: JSON.stringify({ enabled: false, reason: "restore" }),
    });
  });

  it("kill switch alterado por admin de tenant → 403", async () => {
    stubUser(U_NDAAD_ADMIN);
    const res = await app.request("/v1/tickets/admin/kill-switch", {
      method: "PUT",
      headers: { "content-type": "application/json", ...bearer("x.y.z-nadmin") },
      body: JSON.stringify({ enabled: true, reason: "indevido" }),
    });
    expect(res.status).toBe(403);
  });
});
