import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDb, initDb } from "../../src/db/connection.js";

const TEST_DB = "./data/test-remote-rendezvous.db";
const KEY = "test-remote-session-key-32-bytes!";

function hash(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

describe("remote rendezvous", () => {
  beforeEach(() => {
    process.env.DB_PATH = TEST_DB;
    process.env.REMOTE_SESSION_KEY = KEY;
    initDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.REMOTE_SESSION_KEY;
    try {
      unlinkSync(TEST_DB);
    } catch {}
  });

  it("cria código e permite claim uma única vez", async () => {
    const app = createApp();
    const created = await app.request("/v1/remote/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "ws://192.168.1.5:45678",
        token: "ABCDEF12",
      }),
    });
    expect(created.status).toBe(201);
    const offer = await created.json();
    expect(offer.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(offer.expiresAt).toBeTypeOf("string");

    const claim = await app.request(`/v1/remote/sessions/${offer.code}/claim`, {
      method: "POST",
    });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({
      endpoint: "ws://192.168.1.5:45678",
      token: "ABCDEF12",
    });

    const second = await app.request(
      `/v1/remote/sessions/${offer.code}/claim`,
      {
        method: "POST",
      },
    );
    expect(second.status).toBe(410);
  });

  it("rejeita endpoint não-LAN e código inexistente", async () => {
    const app = createApp();
    const invalid = await app.request("/v1/remote/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "ws://8.8.8.8:1234", token: "x" }),
    });
    expect(invalid.status).toBe(400);

    const missing = await app.request("/v1/remote/sessions/ABCD-1234/claim", {
      method: "POST",
    });
    expect(missing.status).toBe(404);
  });

  it("não persiste token em claro", async () => {
    const app = createApp();
    const res = await app.request("/v1/remote/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "ws://192.168.1.5:45678",
        token: "SECRET99",
      }),
    });
    const { code } = await res.json();
    const { getDb } = await import("../../src/db/connection.js");
    const row = getDb()
      .prepare(
        "SELECT code_hash, payload_ciphertext FROM remote_sessions WHERE code_hash = ?",
      )
      .get(hash(code.replace("-", ""))) as { payload_ciphertext: string };
    expect(row.payload_ciphertext).not.toContain("SECRET99");
  });
  it("sem chave não persiste credenciais", async () => {
    delete process.env.REMOTE_SESSION_KEY;
    const res = await createApp().request("/v1/remote/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "ws://10.0.0.1:1234",
        token: "SECRET99",
      }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "codigo_indisponivel" });
  });
  it.each(["broken", "00.00.00"])(
    "payload %s corrompido não libera credenciais",
    async (cipher) => {
      const { getDb } = await import("../../src/db/connection.js");
      const code = "ABCD-1234";
      getDb()
        .prepare(
          "INSERT INTO remote_sessions (code_hash, payload_ciphertext, expires_at, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          hash(code.replace("-", "")),
          cipher,
          Date.now() + 60000,
          Date.now(),
        );
      const res = await createApp().request(
        `/v1/remote/sessions/${code}/claim`,
        { method: "POST" },
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "sessao_invalida" });
    },
  );
  it("JSON malformado retorna erro de endpoint", async () => {
    const res = await createApp().request("/v1/remote/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "endpoint_lan_invalido" });
  });
  it.each(["ws://172.16.0.1:4567", "ws://203.0.113.1:4567"])(
    "valida alcance LAN de %s",
    async (endpoint) => {
      const res = await createApp().request("/v1/remote/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint, token: "SECRET99" }),
      });
      expect(res.status).toBe(endpoint.includes("172.16") ? 201 : 400);
    },
  );
  it("claim que perde disputa atômica não expõe payload", async () => {
    const app = createApp();
    const created = await app.request("/v1/remote/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "ws://10.0.0.1:4567",
        token: "SECRET99",
      }),
    });
    const { code } = await created.json();
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb(),
      prepare = db.prepare.bind(db);
    const spy = vi
      .spyOn(db, "prepare")
      .mockImplementation((sql) =>
        sql.includes("UPDATE remote_sessions SET claimed_at")
          ? ({ run: () => ({ changes: 0 }) } as ReturnType<typeof prepare>)
          : prepare(sql),
      );
    try {
      const res = await app.request(`/v1/remote/sessions/${code}/claim`, {
        method: "POST",
      });
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({
        error: "codigo_expirado_ou_utilizado",
      });
    } finally {
      spy.mockRestore();
    }
  });
});
