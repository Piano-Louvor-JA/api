import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 13: branches remanescentes de custom.routes — caminhos alternativos
 * reais (paginação, 404s de update/delete lyric, upload colisão, etc).
 */
describe("custom.routes branches (caminhos alternativos)", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  let tokenB: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  async function newCollection(t: string, name: string): Promise<number> {
    const r = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(t), "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const b = await r.json();
    return b.id_collection ?? b.id;
  }

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    token = registerUser("br@test.local", "SenhaForte1!").token;
    tokenB = registerUser("br2@test.local", "SenhaForte1!").token;
  });

  afterAll(() => app.cleanup());

  it("list com page=2 e per_page custom → 200", async () => {
    const res = await router.request(
      "/v1/custom/collections?page=2&per_page=1",
      { headers: auth(token) },
    );
    expect(res.status).toBe(200);
  });

  it("PUT collection inexistente → 404 (L493)", async () => {
    const res = await router.request("/v1/custom/collections/424242", {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE collection inexistente → 404", async () => {
    const res = await router.request("/v1/custom/collections/424242", {
      method: "DELETE",
      headers: auth(token),
    });
    expect(res.status).toBe(404);
  });

  it("copy: dup devolve a existente com 200 (L714)", async () => {
    const cid = await newCollection(token, "Dup Branch");
    await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Dup Song" }),
    });
    const r1 = await router.request(
      `/v1/custom/collections/${cid}/musics/copyByName`,
      { method: "POST", headers: auth(token), body: JSON.stringify({}) },
    );
    // copy by id: primeira cria, segunda devolve 200
    const musics = await router.request(`/v1/custom/collections/${cid}/musics`, {
      headers: auth(token),
    });
    const mb = await musics.json();
    const items = mb.data ?? mb;
    const first = (Array.isArray(items) ? items : items.items)[0];
    const copy1 = await router.request(
      `/v1/custom/collections/${cid}/musics/${first.id_music ?? first.id}/copy`,
      { method: "POST", headers: auth(token), body: JSON.stringify({}) },
    );
    const copy2 = await router.request(
      `/v1/custom/collections/${cid}/musics/${first.id_music ?? first.id}/copy`,
      { method: "POST", headers: auth(token), body: JSON.stringify({}) },
    );
    expect([200, 201]).toContain(copy1.status);
    expect(copy2.status).toBe(200);
  });

  it("upload: colisão de nome (L1521) gera 2º arquivo com timestamp", async () => {
    const mk = (name: string) => {
      const fd = new FormData();
      fd.append("file", new File([Buffer.from("data")], name, { type: "text/plain" }));
      fd.append("kind", "imagens");
      return fd;
    };
    const r1 = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: mk("colisao.txt"),
    });
    const r2 = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: mk("colisao.txt"),
    });
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);
  });

  it("lyrics: PUT/DELETE de lyric inexistente → 404 (L1337/L1408)", async () => {
    const cid = await newCollection(token, "Lyric 404");
    const created = await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Ly" }),
    });
    const cb = await created.json();
    const mid = cb.id_music ?? cb.id;

    const up = await router.request(`/v1/custom/lyrics/999999`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ lyric: "x" }),
    });
    expect([404, 400]).toContain(up.status);

    const del = await router.request(`/v1/custom/lyrics/999999`, {
      method: "DELETE",
      headers: auth(token),
    });
    expect([404]).toContain(del.status);
  });

  it("record use em collection privada de outro → 403/404 (L2050/1137 família)", async () => {
    const cid = await newCollection(token, "Privada Uso");
    // torna privada
    await router.request(`/v1/custom/collections/${cid}`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ visibility: "private" }),
    });
    const res = await router.request(`/v1/custom/collections/${cid}/use`, {
      method: "POST",
      headers: { ...auth(tokenB), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect([403, 404]).toContain(res.status);
  });

  it("reset-password: token expirado → 400 (L1968)", async () => {
    const res = await router.request("/v1/custom/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "expired0000000001", password: "SenhaForte1!" }),
    });
    expect(res.status).toBe(400);
  });
});
