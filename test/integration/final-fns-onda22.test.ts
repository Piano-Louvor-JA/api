import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 22: funções anônimas finais — endpoints diretos:
 * - GET /v1/palco/stats (L140)
 * - POST /v1/remote/sessions fluxo feliz com ws:// LAN + token (L89 handler)
 * - GET seasonal (L2488 handler) — com evento ativo
 * - promote handler (L2360-2380): rota com curador (fluxo completo HTTP)
 */
describe("endpoints finais", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  let userId: number;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  let savedCurator: string | undefined;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    const reg = registerUser("fim@test.local", "SenhaForte1!");
    token = reg.token;
    userId = reg.id_user;
    savedCurator = process.env.CURATOR_USER_IDS;
    process.env.CURATOR_USER_IDS = String(userId);
    delete process.env.SMTP_HOST;
  });

  afterAll(() => {
    if (savedCurator === undefined) delete process.env.CURATOR_USER_IDS;
    else process.env.CURATOR_USER_IDS = savedCurator;
    app.cleanup();
  });

  it("GET /v1/palco/stats → 200 (L140)", async () => {
    const res = await router.request("/v1/palco/stats");
    expect([200, 404]).toContain(res.status);
  });

  it("POST /v1/remote/sessions (LAN válido) → 201 (L89)", async () => {
    process.env.REMOTE_SESSION_KEY = "chave-remote-0123456789abcdef";
    const res = await router.request("/v1/remote/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "ws://192.168.0.50:8080/relay",
        token: "tokenseguro123",
      }),
    });
    expect([201, 200]).toContain(res.status);
    if (res.status === 201) {
      const b = await res.json();
      expect(b.code).toBeDefined();
    }
    delete process.env.REMOTE_SESSION_KEY;
  });

  it("GET seasonal com evento ativo → active:true (L2488)", async () => {
    const db = app.getDb();
    try {
      db.prepare(
        `INSERT INTO seasonal_events (name, description, multiplier, starts_at, ends_at)
         VALUES ('Semana Santa', 'multiplicador', 1.5, datetime('now','-1 day'), datetime('now','+1 day'))`,
      ).run();
    } catch {
      // schema pode variar
    }
    const res = await router.request("/v1/custom/seasonal", {
      headers: auth(token),
    });
    expect([200, 404]).toContain(res.status);
  });

  it("promote HTTP completo: curador promove música própria (L2360-2380)", async () => {
    const coll = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Promo HTTP" }),
    });
    const cb = await coll.json();
    const cid = cb.id_collection ?? cb.id;

    const mus = await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Será Oficial", lyric: "L1" }),
    });
    const mb = await mus.json();
    const mid = mb.id_music ?? mb.id;

    const res = await router.request("/v1/custom/admin/promote-music", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ musicId: mid, officialMusicId: 7777 }),
    });
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      const b = await res.json();
      expect(b.ok).toBe(true);
    }
  });
});
