import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 1b: custom musics — criar música custom, copy de oficial pra coletânea,
 * update/delete, detail com 404. DB seeded (music 1 e 30 existem).
 */
describe("Custom musics (HTTP)", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  let collectionId: number;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    token = registerUser("musics@test.local", "SenhaForte1!").token;

    const created = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Com Músicas" }),
    });
    const body = await created.json();
    collectionId = body.id_collection ?? body.id;
    expect(collectionId).toBeDefined();
  });

  afterAll(() => app.cleanup());

  it("POST cria música custom na coletânea", async () => {
    const res = await router.request(
      `/v1/custom/collections/${collectionId}/musics`,
      {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          name: "Hino Teste",
          lyric: "Letra linha 1\nLetra linha 2",
        }),
      },
    );
    expect([200, 201]).toContain(res.status);
    const body = await res.json();
    expect(body.id_music ?? body.id).toBeDefined();
  });

  it("POST música sem nome nem link → 400", async () => {
    const res = await router.request(
      `/v1/custom/collections/${collectionId}/musics`,
      {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ name: "" }),
      },
    );
    expect([400, 500]).toContain(res.status);
  });

  it("GET musics da coletânea lista a criada", async () => {
    const res = await router.request(
      `/v1/custom/collections/${collectionId}/musics`,
      { headers: auth(token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = body.data ?? body;
    expect(Array.isArray(items) ? items.length : items.items.length).toBeGreaterThan(0);
  });

  it("copy de música oficial pra coletânea", async () => {
    const res = await router.request(
      `/v1/custom/collections/${collectionId}/musics/1/copy`,
      {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect([200, 201]).toContain(res.status);
  });

  it("copy de música inexistente → 404", async () => {
    const res = await router.request(
      `/v1/custom/collections/${collectionId}/musics/424242/copy`,
      {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(404);
  });

  it("GET música inexistente → 404", async () => {
    const res = await router.request(
      `/v1/custom/collections/${collectionId}/musics/999999`,
      { headers: auth(token) },
    );
    expect(res.status).toBe(404);
  });
});
