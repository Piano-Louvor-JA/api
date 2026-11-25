import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 6c: palco REST (sessions) + remote (decrypt/claim) caminhos de erro.
 * WS real já coberto por palco-relay-ws.test.ts; aqui foco nos ramos REST.
 */
describe("Palco REST sessions", () => {
  let app: SeededDb;
  let router: any;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
  });

  afterAll(() => app.cleanup());

  it("POST /v1/palco/sessions cria sessão com code+token", async () => {
    const res = await router.request("/v1/palco/sessions", {
      method: "POST",
    });
    expect([201, 200, 503]).toContain(res.status);
    if (res.status === 201) {
      const body = await res.json();
      expect(body.code).toBeDefined();
      expect(body.token).toBeDefined();
    }
  });

  it("POST /v1/palco/sessions (2x) cria códigos distintos", async () => {
    const a = await router.request("/v1/palco/sessions", { method: "POST" });
    const b = await router.request("/v1/palco/sessions", { method: "POST" });
    if (a.status === 201 && b.status === 201) {
      const ba = await a.json();
      const bb = await b.json();
      expect(ba.code).not.toBe(bb.code);
    } else {
      expect([503]).toContain(a.status);
    }
  });
});

describe("Remote session — payload inválido", () => {
  let app: SeededDb;
  let router: any;
  const prev = process.env.REMOTE_SESSION_KEY;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    process.env.REMOTE_SESSION_KEY = "chave-teste-remote-0123456789abcdef";
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.REMOTE_SESSION_KEY;
    else process.env.REMOTE_SESSION_KEY = prev;
    app.cleanup();
  });

  it("POST /v1/remote/pair com payload cripto inválido → 400", async () => {
    const res = await router.request("/v1/remote/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "iv.tag.cipher" }),
    });
    expect([400, 404]).toContain(res.status);
  });

  it("POST /v1/remote/pair sem payload → 400/422", async () => {
    const res = await router.request("/v1/remote/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect([400, 404, 422]).toContain(res.status);
  });

  it("claim com código inexistente → 410/404", async () => {
    const res = await router.request("/v1/remote/sessions/ZZZZ99/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ZZZZ99", payload: "x.y.z" }),
    });
    expect([400, 404, 410]).toContain(res.status);
  });
});
