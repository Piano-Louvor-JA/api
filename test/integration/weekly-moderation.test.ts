import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * F4/F5 — HTTP: tarefas semanais + moderação (report esconde do catálogo).
 */
describe("Weekly tasks e moderação (F4/F5)", () => {
  let app: SeededDb;
  let tokenOwner: string;
  let tokenUser: string;
  let collectionId: number;

  async function register(
    router: any,
    email: string,
    displayName: string,
  ): Promise<string> {
    const res = await router.request("/v1/custom/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "SenhaForte1!",
        displayName,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    return body.token as string;
  }

  beforeAll(async () => {
    app = await setupSeededDb();
    const { router } = app;
    tokenOwner = await register(router, "owner@rank.local", "Owner");
    tokenUser = await register(router, "user@rank.local", "User");

    const res = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenOwner}`,
      },
      body: JSON.stringify({ name: "Para moderar", visibility: "public" }),
    });
    expect(res.status).toBe(201);
    collectionId = (await res.json()).id_collection;
  });
  afterAll(() => app.cleanup());

  it("F4: GET /weekly-tasks retorna 3 tarefas, nenhuma done", async () => {
    const res = await app.router.request("/v1/custom/weekly-tasks", {
      headers: { authorization: `Bearer ${tokenUser}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.week_key).toMatch(/^\d{4}-W\d{2}$/);
    expect(body.data).toHaveLength(3);
    expect(body.data.every((t: any) => t.done === false)).toBe(true);
  });

  it("F4: completar tarefa idempotente; task inexistente → 404; sem auth → 401", async () => {
    const weekRes = await app.router.request("/v1/custom/weekly-tasks", {
      headers: { authorization: `Bearer ${tokenUser}` },
    });
    const { data } = await weekRes.json();
    const taskId = data[0].id;

    const c1 = await app.router.request(
      `/v1/custom/weekly-tasks/${taskId}/complete`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${tokenUser}` },
      },
    );
    expect(c1.status).toBe(200);
    expect((await c1.json()).credited).toBe(true);

    const c2 = await app.router.request(
      `/v1/custom/weekly-tasks/${taskId}/complete`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${tokenUser}` },
      },
    );
    expect((await c2.json()).credited).toBe(false);

    const missing = await app.router.request(
      "/v1/custom/weekly-tasks/task_inexistente/complete",
      {
        method: "POST",
        headers: { authorization: `Bearer ${tokenUser}` },
      },
    );
    expect(missing.status).toBe(404);

    const noAuth = await app.router.request(
      `/v1/custom/weekly-tasks/${taskId}/complete`,
      { method: "POST" },
    );
    expect(noAuth.status).toBe(401);
  });

  it("F5: coletânea reportada desaparece do catálogo público", async () => {
    const before = await app.router.request("/v1/custom/collections");
    const beforeList = (await before.json()).data as Array<any>;
    expect(beforeList.some((c) => c.id_collection === collectionId)).toBe(true);

    const report = await app.router.request(
      `/v1/custom/collections/${collectionId}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenUser}`,
        },
        body: JSON.stringify({ reason: "Conteúdo impróprio para revisão" }),
      },
    );
    expect(report.status).toBe(200);

    const after = await app.router.request("/v1/custom/collections");
    const afterList = (await after.json()).data as Array<any>;
    expect(afterList.some((c) => c.id_collection === collectionId)).toBe(false);
  });

  it("F5: report inexistente 404; sem auth 401; motivo curto 400", async () => {
    const noAuth = await app.router.request(
      `/v1/custom/collections/${collectionId}/report`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "abc" }),
      },
    );
    expect(noAuth.status).toBe(401);

    const missing = await app.router.request(
      "/v1/custom/collections/999999/report",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenUser}`,
        },
        body: JSON.stringify({ reason: "abc" }),
      },
    );
    expect(missing.status).toBe(404);
  });
});
