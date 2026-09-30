import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * F1/F2 — fluxo HTTP de usos e ranking (integração).
 * usa custom auth: registrar usuário → token → Authorization header.
 */
describe("Ranking HTTP (POST /collections/:id/use, GET /ranking)", () => {
  let app: SeededDb;
  let tokenA: string; // dono
  let tokenB: string; // quem usa
  let collectionA: number;

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
    const { router, getDb } = app;
    tokenA = await register(router, "alice@rank.local", "Alice");
    tokenB = await register(router, "bob@rank.local", "Bob");

    // Alice cria coletânea pública (deve creditar publish +10)
    const res = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ name: "Culto Jovem", visibility: "public" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    collectionA = body.id_collection;

    void getDb;
  });
  afterAll(() => app.cleanup());

  it("publicar coletânea pública credita +10 ao dono (ranking/me)", async () => {
    const res = await app.router.request("/v1/custom/ranking/me", {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.position).toBe(1);
    expect(body.total).toBe(10);
  });

  it("usuário sem pontos → position/total null", async () => {
    const res = await app.router.request("/v1/custom/ranking/me", {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const body = await res.json();
    expect(body).toEqual({ position: null, total: null });
  });

  it("uso registra 1x: first_use true na 1ª, false na 2ª", async () => {
    const use = (token: string) =>
      app.router.request(`/v1/custom/collections/${collectionA}/use`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    const r1 = await use(tokenB);
    expect(r1.status).toBe(200);
    expect((await r1.json()).first_use).toBe(true);

    const r2 = await use(tokenB);
    expect(r2.status).toBe(200);
    expect((await r2.json()).first_use).toBe(false);
  });

  it("dono recebeu +5 do uso; ranking global ordena (Alice 15 > Bob 0)", async () => {
    const meA = await (
      await app.router.request("/v1/custom/ranking/me", {
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(meA.total).toBe(15); // 10 publish + 5 use_received

    const ranking = await (
      await app.router.request("/v1/custom/ranking?window=all")
    ).json();
    expect(ranking.data[0].display_name).toBe("Alice");
    expect(ranking.data[0].total).toBe(15);
    // B8: display name, nunca email
    for (const row of ranking.data) {
      expect(row.display_name).not.toContain("@");
    }
  });

  it("uso sem auth → 401; coletânea inexistente → 404", async () => {
    const noAuth = await app.router.request(
      `/v1/custom/collections/${collectionA}/use`,
      { method: "POST" },
    );
    expect(noAuth.status).toBe(401);

    const notFound = await app.router.request(
      "/v1/custom/collections/999999/use",
      {
        method: "POST",
        headers: { authorization: `Bearer ${tokenB}` },
      },
    );
    expect(notFound.status).toBe(404);
  });

  it("janela week só inclui pontos recentes (usuários criados agora aparecem)", async () => {
    const week = await (
      await app.router.request("/v1/custom/ranking?window=week")
    ).json();
    expect(week.data.length).toBeGreaterThanOrEqual(1);
    expect(week.data[0].total).toBe(15);
  });
});
