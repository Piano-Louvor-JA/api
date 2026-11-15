import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * SPEC piano-admin-panel v1.1.0 (AC-1..AC-6): rotas admin via UI.
 * ADMIN_EMAILS governa tudo (fail-closed). AC-1: evento criado aparece em
 * /seasonal-event público. AC-2: não-admin 403 uniforme. AC-3: sem sessão
 * 401. AC-4: datas invertidas/multiplicador <1 → 400. AC-5: pool de tasks
 * via tabela reflete na rotação.
 */
describe("Painel Admin API (seasonal-events + weekly-tasks)", () => {
  let app: SeededDb;
  let router: any;
  let adminToken: string;
  let userToken: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "admin@test.local";
    app = await setupSeededDb();
    router = app.router;
    adminToken = registerUser("admin@test.local", "SenhaForte1!").token;
    userToken = registerUser("plebeu@test.local", "SenhaForte1!").token;
  });

  afterAll(() => {
    delete process.env.ADMIN_EMAILS;
    app.cleanup();
  });

  it("AC-2/AC-3: sem sessão 401; não-admin 403 uniforme em todas as rotas admin", async () => {
    const paths = [
      "/v1/custom/admin/seasonal-events",
      "/v1/custom/admin/weekly-tasks",
    ];
    for (const p of paths) {
      const anon = await router.request(p, {
        headers: { "X-Tenant": "piano" },
      });
      expect(anon.status, `anon ${p}`).toBe(401);
      const nonAdmin = await router.request(p, {
        headers: { ...auth(userToken), "X-Tenant": "piano" },
      });
      expect(nonAdmin.status, `non-admin ${p}`).toBe(403);
    }
  });

  it("AC-1: admin cria evento e ele aparece no /seasonal-event público", async () => {
    const create = await router.request("/v1/custom/admin/seasonal-events", {
      method: "POST",
      headers: {
        ...auth(adminToken),
        "X-Tenant": "piano",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Páscoa",
        description: "Multiplicador de Páscoa",
        multiplier: 2,
        starts_at: "2020-01-01T00:00:00",
        ends_at: "2099-12-31T23:59:59",
      }),
    });
    expect(create.status).toBe(201);
    const created = await create.json();
    expect(created.id).toBeDefined();

    const pub = await router.request("/v1/custom/seasonal-event", {
      headers: { "X-Tenant": "piano" },
    });
    const pubBody = await pub.json();
    expect(pubBody.active).toBe(true);
    expect(pubBody.name).toBe("Páscoa");
    expect(pubBody.multiplier).toBe(2);
  });

  it("AC-4: datas invertidas → 400; multiplicador < 1 → 400", async () => {
    const badDates = await router.request("/v1/custom/admin/seasonal-events", {
      method: "POST",
      headers: {
        ...auth(adminToken),
        "X-Tenant": "piano",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "X",
        multiplier: 2,
        starts_at: "2026-12-31T00:00:00",
        ends_at: "2026-12-01T00:00:00",
      }),
    });
    expect(badDates.status).toBe(400);

    const badMult = await router.request("/v1/custom/admin/seasonal-events", {
      method: "POST",
      headers: {
        ...auth(adminToken),
        "X-Tenant": "piano",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "X",
        multiplier: 0.5,
        starts_at: "2026-12-01T00:00:00",
        ends_at: "2026-12-31T00:00:00",
      }),
    });
    expect(badMult.status).toBe(400);
  });

  it("PUT atualiza evento; DELETE desativa (soft)", async () => {
    const create = await router.request("/v1/custom/admin/seasonal-events", {
      method: "POST",
      headers: {
        ...auth(adminToken),
        "X-Tenant": "piano",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Natal",
        multiplier: 3,
        starts_at: "2026-12-20T00:00:00",
        ends_at: "2026-12-30T00:00:00",
      }),
    });
    const { id } = await create.json();

    const put = await router.request(`/v1/custom/admin/seasonal-events/${id}`, {
      method: "PUT",
      headers: {
        ...auth(adminToken),
        "X-Tenant": "piano",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Natal",
        multiplier: 4,
        starts_at: "2026-12-20T00:00:00",
        ends_at: "2027-01-05T00:00:00",
        active: false,
      }),
    });
    expect(put.status).toBe(200);
    const updated = await put.json();
    expect(updated.multiplier).toBe(4);
    expect(updated.active).toBe(false);

    const del = await router.request(`/v1/custom/admin/seasonal-events/${id}`, {
      method: "DELETE",
      headers: { ...auth(adminToken), "X-Tenant": "piano" },
    });
    expect(del.status).toBe(200);
  });

  it("AC-5: pool de tasks via PUT reflete na rotação semanal", async () => {
    const pool = [
      { id: "qa_pool_a", description: "Tarefa A do QA" },
      { id: "qa_pool_b", description: "Tarefa B do QA" },
      { id: "qa_pool_c", description: "Tarefa C do QA" },
    ];
    const put = await router.request("/v1/custom/admin/weekly-tasks", {
      method: "PUT",
      headers: {
        ...auth(adminToken),
        "X-Tenant": "piano",
        "content-type": "application/json",
      },
      body: JSON.stringify({ tasks: pool }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.data.map((t: { id: string }) => t.id)).toEqual([
      "qa_pool_a",
      "qa_pool_b",
      "qa_pool_c",
    ]);

    // a rotação semanal do usuário agora usa o pool da tabela
    const userTasks = await router.request("/v1/custom/weekly-tasks", {
      headers: { ...auth(userToken), "X-Tenant": "piano" },
    });
    expect(userTasks.status).toBe(200);
    const tasksBody = await userTasks.json();
    const ids = (tasksBody.tasks ?? tasksBody.data ?? []).map(
      (t: { id: string }) => t.id,
    );
    expect(ids).toContain("qa_pool_a");
  });
});
