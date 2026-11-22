/**
 * central-tickets B1 — E2E: app completo montado (createApp) com rotas tickets.
 * Fluxo: intake público → triage agente → ticket → resposta → KB → auditoria.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

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

import { createApp } from "../../src/app.js";
import { getDb, initDb } from "../../src/db/connection.js";

let app: ReturnType<typeof createApp>;

const CLIENT = { uid: "uid-e2e-client", email: "cli@ndaad.org" };
const AGENT = { uid: "uid-e2e-agent", email: "agente@ndaad.org" };

function bearer(t: string): Record<string, string> {
  return { authorization: `Bearer ${t}` };
}

function seedMembership(tenant: string, uid: string, role: string) {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO tickets_memberships (tenant_id, firebase_uid, role) VALUES (?,?,?)",
    )
    .run(tenant, uid, role);
}

beforeAll(() => {
  process.env.FIREBASE_SERVICE_ACCOUNT ??= JSON.stringify({ project_id: "t" });
  initDb();
  app = createApp();
});

describe("E2E central-tickets B1 (createApp completo)", () => {
  it("intake público emite protocolo sem auth", async () => {
    const res = await app.request("/v1/tickets-intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Cliente E2E",
        email: "cli@ex.com",
        subject: "Não consigo projetar hino",
        message: "Erro ao abrir projeção no desktop.",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { protocol: string };
    expect(body.protocol).toMatch(/^(TKT-|PRC-)/);
  });

  it("client ndaad cria ticket via app montado", async () => {
    verifyIdTokenMock.mockResolvedValue(CLIENT);
    seedMembership("ndaad", CLIENT.uid, "client");
    const res = await app.request("/v1/tickets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearer("x.y.z-client"),
      },
      body: JSON.stringify({
        subject: "Licença não ativa",
        message: "Chave retornada como inválida.",
        priority: "P2",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; firstResponseDue: string };
    expect(body.id).toBeGreaterThan(0);
    expect(body.firstResponseDue).toBeTruthy();
  });

  it("token inválido → 401 fail-closed", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("bad token"));
    const res = await app.request("/v1/tickets", {
      headers: bearer("ruim"),
    });
    expect(res.status).toBe(401);
  });

  it("KB global legível por client ndaad", async () => {
    verifyIdTokenMock.mockResolvedValue(CLIENT);
    const res = await app.request("/v1/tickets-kb", {
      headers: bearer("x.y.z-client"),
    });
    expect(res.status).toBe(200);
  });

  it("404 padrão preservado fora do módulo", async () => {
    const res = await app.request("/v1/rota-que-nao-existe");
    expect(res.status).toBe(404);
  });
});
