import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");
const { resetGeoVisitStateForTests, setGeoVisitFirestoreForTests } =
  await import("../../src/v1/geo/geo-visit.routes.js");

/** GET /v1/geo/stats resolve a sessão antes do gate de admin. */
describe("GET /v1/geo/stats — autenticação", () => {
  let app: SeededDb;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "adm-geo@test.local";
    app = await setupSeededDb();
    adminToken = registerUser("adm-geo@test.local", "SenhaForte1!").token;
    userToken = registerUser("comum-geo@test.local", "SenhaForte1!").token;
    resetGeoVisitStateForTests();
    setGeoVisitFirestoreForTests({
      collection: () => ({
        where: () => ({
          orderBy: () => ({
            get: async () => ({
              docs: [
                { data: () => ({ day: "2026-11-19", countries: { BR: 3 } }) },
              ],
            }),
          }),
        }),
      }),
    } as never);
  });

  afterAll(() => {
    setGeoVisitFirestoreForTests(null);
    resetGeoVisitStateForTests();
    process.env.ADMIN_EMAILS = "";
  });

  const get = (token?: string) =>
    app.router.request("/v1/geo/stats?days=7", {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it("sem token → 401", async () => {
    expect((await get()).status).toBe(401);
  });

  it("usuário comum → 403", async () => {
    expect((await get(userToken)).status).toBe(403);
  });

  it("admin com token de sessão → 200 com o agregado", async () => {
    const res = await get(adminToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      totalVisits: 3,
      days: 7,
      countries: [{ country: "BR", visits: 3 }],
    });
  });
});
