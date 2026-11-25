// Teste SEC-7 do anti-bot contra o APP REAL (createApp) — review da PR #141:
// o middleware precisa interceptar /v1/* (a API real), e /v1/health precisa
// continuar acessível para healthchecks (docker + monitores Hostinger usam curl).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDb, initDb } from "../../src/db/connection.js";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  process.env.DB_PATH = ":memory:";
  initDb();
  app = createApp();
});

afterAll(() => {
  closeDb();
});

describe("SEC-7: anti-bot intercepta a API real (/v1/*)", () => {
  it("bloqueia user-agent de bot em endpoint /v1", async () => {
    const res = await app.request("http://localhost/v1/albums", {
      headers: { "user-agent": "curl/7.88.1" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "User-Agent não suportado. Utilize um cliente HTTP padrão.",
    });
  });

  it("aceita user-agent normal em endpoint /v1", async () => {
    const res = await app.request("http://localhost/v1/albums?lang=pt", {
      headers: { "user-agent": "Mozilla/5.0" },
    });
    expect(res.status).toBe(200);
  });

  it("/v1/health permanece acessível mesmo com UA de bot (healthcheck)", async () => {
    const res = await app.request("http://localhost/v1/health", {
      headers: { "user-agent": "curl/7.88.1" },
    });
    expect(res.status).toBe(200);
  });
});
