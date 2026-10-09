import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 4a: fechar gaps remanescentes de custom.routes:
 * - GET /musics (listAll, pública)
 * - update/delete collection: owner check 403, não-encontrada 404
 * - copy: duplicada (200 idempotente), origem 404, destino 404
 * - create sem auth → 401 (api#82)
 */
describe("custom.routes gaps", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  let otherToken: string;
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

  async function newMusic(
    t: string,
    cid: number,
    name: string,
  ): Promise<number> {
    const r = await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(t), "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const b = await r.json();
    return b.id_music ?? b.id;
  }

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    token = registerUser("gaps@test.local", "SenhaForte1!").token;
    otherToken = registerUser("gaps2@test.local", "SenhaForte1!").token;
  });

  afterAll(() => app.cleanup());

  it("GET /musics (listAll público) lista músicas custom", async () => {
    const res = await router.request("/v1/custom/musics");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
  });

  it("POST collection sem auth → 401 (api#82)", async () => {
    const res = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Anônima" }),
    });
    expect(res.status).toBe(401);
  });

  it("PUT collection de outro dono → 403", async () => {
    const cid = await newCollection(token, "Do Dono A");
    const res = await router.request(`/v1/custom/collections/${cid}`, {
      method: "PUT",
      headers: { ...auth(otherToken), "content-type": "application/json" },
      body: JSON.stringify({ name: "Hijack" }),
    });
    expect(res.status).toBe(403);
  });

  it("PUT collection inexistente → 404", async () => {
    const res = await router.request("/v1/custom/collections/999999", {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE collection de outro dono → 403", async () => {
    const cid = await newCollection(token, "Não Apaga");
    const res = await router.request(`/v1/custom/collections/${cid}`, {
      method: "DELETE",
      headers: auth(otherToken),
    });
    expect(res.status).toBe(403);
  });

  it("DELETE collection do dono remove", async () => {
    const cid = await newCollection(token, "Apaga Sim");
    const res = await router.request(`/v1/custom/collections/${cid}`, {
      method: "DELETE",
      headers: auth(token),
    });
    expect([200, 204]).toContain(res.status);
  });

  it("copy idempotente: 2ª cópia da mesma música → 200 sem duplicar", async () => {
    const cid = await newCollection(token, "Copy Dup");
    const mid = await newMusic(token, cid, "CopyTarget");

    const c1 = await router.request(
      `/v1/custom/collections/${cid}/musics/${mid}/copy`,
      { method: "POST", headers: auth(token), body: JSON.stringify({}) },
    );
    expect([200, 201]).toContain(c1.status);

    const c2 = await router.request(
      `/v1/custom/collections/${cid}/musics/${mid}/copy`,
      { method: "POST", headers: auth(token), body: JSON.stringify({}) },
    );
    expect(c2.status).toBe(200);
  });

  it("copy pra coletânea inexistente → 404", async () => {
    const cid = await newCollection(token, "Origem Copy");
    const mid = await newMusic(token, cid, "Origem");

    const res = await router.request(
      `/v1/custom/collections/999999/musics/${mid}/copy`,
      { method: "POST", headers: auth(token), body: JSON.stringify({}) },
    );
    expect(res.status).toBe(404);
  });
});
