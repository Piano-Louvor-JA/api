import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 2a: music update/delete + lyrics CRUD (custom.routes 45.9%→).
 * DB seeded: music 1 (oficial, com lyric 1) e 30 existem.
 */
describe("Custom musics update/delete + lyrics", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  let otherToken: string;
  let collectionId: number;
  let musicId: number;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  async function createCollection(name: string): Promise<number> {
    const r = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const b = await r.json();
    return b.id_collection ?? b.id;
  }

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    token = registerUser("onda2@test.local", "SenhaForte1!").token;
    otherToken = registerUser("onda2-outro@test.local", "SenhaForte1!").token;
    collectionId = await createCollection("Onda 2");
    expect(collectionId).toBeDefined();

    // cria custom music direto (copy só funciona entre custom_musics)
    const created = await router.request(
      `/v1/custom/collections/${collectionId}/musics`,
      {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ name: "Onda2 Música", lyric: "L1\nL2" }),
      },
    );
    expect([200, 201]).toContain(created.status);
    const cb = await created.json();
    musicId = cb.id_music ?? cb.id;
    expect(musicId).toBeDefined();
  });

  afterAll(() => app.cleanup());

  it("PUT update music: renomeia e reflete no GET", async () => {
    const res = await router.request(`/v1/custom/musics/${musicId}`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Nome Editado" }),
    });
    expect([200, 204]).toContain(res.status);

    const got = await router.request(`/v1/custom/musics/${musicId}`, {
      headers: auth(token),
    });
    if (got.status === 200) {
      const body = await got.json();
      expect(body.name ?? body.data?.name).toBe("Nome Editado");
    }
  });

  it("PUT update music de outro usuário → 403/404", async () => {
    const res = await router.request(`/v1/custom/musics/${musicId}`, {
      method: "PUT",
      headers: { ...auth(otherToken), "content-type": "application/json" },
      body: JSON.stringify({ name: "Hack" }),
    });
    expect([403, 404]).toContain(res.status);
  });

  it("POST cria lyric na música custom", async () => {
    const res = await router.request(`/v1/custom/musics/${musicId}/lyrics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ lyric: "Estrofe nova", order: 2 }),
    });
    expect([200, 201]).toContain(res.status);
  });

  it("GET lyrics da música lista", async () => {
    const res = await router.request(`/v1/custom/musics/${musicId}/lyrics`, {
      headers: auth(token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = body.data ?? body;
    expect((Array.isArray(items) ? items : items.items ?? []).length).toBeGreaterThan(0);
  });

  it("PUT update lyric edita estrofe", async () => {
    // pega id de uma lyric
    const list = await router.request(`/v1/custom/musics/${musicId}/lyrics`, {
      headers: auth(token),
    });
    const lb = await list.json();
    const items = lb.data ?? lb;
    const arr = Array.isArray(items) ? items : items.items ?? [];
    expect(arr.length).toBeGreaterThan(0);
    const lyricId = arr[0].id_lyric ?? arr[0].id;

    const res = await router.request(`/v1/custom/lyrics/${lyricId}`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ lyric: "Estrofe editada" }),
    });
    expect([200, 204]).toContain(res.status);
  });

  it("DELETE lyric remove", async () => {
    const list = await router.request(`/v1/custom/musics/${musicId}/lyrics`, {
      headers: auth(token),
    });
    const lb = await list.json();
    const items = lb.data ?? lb;
    const arr = Array.isArray(items) ? items : items.items ?? [];
    const lyricId = arr[arr.length - 1]?.id_lyric ?? arr[arr.length - 1]?.id;

    const res = await router.request(`/v1/custom/lyrics/${lyricId}`, {
      method: "DELETE",
      headers: auth(token),
    });
    expect([200, 204]).toContain(res.status);
  });

  it("DELETE music remove; GET depois → 404", async () => {
    const res = await router.request(`/v1/custom/musics/${musicId}`, {
      method: "DELETE",
      headers: auth(token),
    });
    expect([200, 204]).toContain(res.status);

    const got = await router.request(`/v1/custom/musics/${musicId}`, {
      headers: auth(token),
    });
    expect(got.status).toBe(404);
  });

  it("DELETE music de outro usuário → 403/404", async () => {
    const cid = await createCollection("Onda 2b");
    const copy = await router.request(
      `/v1/custom/collections/${cid}/musics/30/copy`,
      {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const cb = await copy.json();
    const mid = cb.id_music ?? cb.id;

    const res = await router.request(`/v1/custom/musics/${mid}`, {
      method: "DELETE",
      headers: { ...auth(otherToken), "content-type": "application/json" },
    });
    expect([403, 404]).toContain(res.status);
  });
});
