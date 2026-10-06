import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 1 de coverage: /v1/custom collections CRUD (list/create/get/update/delete)
 * + copy music + list musics — comportamento observável por HTTP, DB seeded.
 */
describe("Custom collections CRUD (HTTP)", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    token = registerUser("onda1@test.local", "SenhaForte1!").token;
  });

  afterAll(() => app.cleanup());

  it("POST cria coletânea e GET lista contém", async () => {
    const created = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Minha Coletânea", description: "onda1" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    const createdId = body.id_collection ?? body.id;
    expect(createdId).toBeDefined();

    const list = await router.request("/v1/custom/collections", {
      headers: auth(token),
    });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    const items = listBody.data ?? listBody;
    const found = (Array.isArray(items) ? items : items.items)?.some(
      (c: any) => (c.id_collection ?? c.id) === createdId,
    );
    expect(found).toBe(true);
  });

  it("GET lista sem auth → 200 só com públicas (não explode)", async () => {
    const res = await router.request("/v1/custom/collections");
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = body.data ?? body;
    for (const c of Array.isArray(items) ? items : (items.items ?? [])) {
      expect(c.visibility).toBe("public");
    }
  });

  it("GET detail: minha coletânea 200; privada de outro usuário → 404 (não revela)", async () => {
    const created = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Privada", visibility: "private" }),
    });
    const createdBody = await created.json();
    const id = createdBody.id_collection ?? createdBody.id;

    const ok = await router.request(`/v1/custom/collections/${id}`, {
      headers: auth(token),
    });
    expect(ok.status).toBe(200);

    const other = registerUser("outro@test.local", "SenhaForte1!").token;
    const leak = await router.request(`/v1/custom/collections/${id}`, {
      headers: auth(other),
    });
    // api#82: 404, não 403 — não revela existência
    expect(leak.status).toBe(404);
  });

  it("PUT renomeia; GET reflete", async () => {
    const created = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Antigo" }),
    });
    const antigoBody = await created.json();
    const id = antigoBody.id_collection ?? antigoBody.id;

    const patched = await router.request(`/v1/custom/collections/${id}`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Novo" }),
    });
    expect([200, 204]).toContain(patched.status);

    const got = await router.request(`/v1/custom/collections/${id}`, {
      headers: auth(token),
    });
    const gotBody = await got.json();
    expect(gotBody.name).toBe("Novo");
  });

  it("DELETE remove; GET depois → 404", async () => {
    const created = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Temporal" }),
    });
    const temporalBody = await created.json();
    const id = temporalBody.id_collection ?? temporalBody.id;

    const del = await router.request(`/v1/custom/collections/${id}`, {
      method: "DELETE",
      headers: auth(token),
    });
    expect([200, 204]).toContain(del.status);

    const got = await router.request(`/v1/custom/collections/${id}`, {
      headers: auth(token),
    });
    expect(got.status).toBe(404);
  });

  it("POST com payload inválido → 400", async () => {
    const res = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("coletânea inexistente → 404", async () => {
    const res = await router.request("/v1/custom/collections/999999", {
      headers: auth(token),
    });
    expect(res.status).toBe(404);
  });
});
