import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");
const { setTimeseriesFirestoreForTests } = await import(
  "../../src/v1/geo/geo-timeseries.routes.js"
);

/** GET /v1/geo/timeseries resolve a sessão antes do gate de admin. */
describe("GET /v1/geo/timeseries — autenticação e resposta", () => {
  let app: SeededDb;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "adm-ts@test.local";
    app = await setupSeededDb();
    adminToken = registerUser("adm-ts@test.local", "SenhaForte1!").token;
    userToken = registerUser("comum-ts@test.local", "SenhaForte1!").token;
  });

  afterEach(() => {
    setTimeseriesFirestoreForTests(null);
    vi.unstubAllGlobals();
    delete process.env.BUTTONDOWN_API_KEY;
  });

  afterAll(() => {
    process.env.ADMIN_EMAILS = "";
  });

  const get = (token?: string, query = "?period=7d") =>
    app.router.request(`/v1/geo/timeseries${query}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it("sem token → 401", async () => {
    expect((await get()).status).toBe(401);
  });

  it("usuário comum → 403", async () => {
    expect((await get(userToken)).status).toBe(403);
  });

  it("admin → 200 com séries zeradas quando o Firestore falha", async () => {
    // Sem FIREBASE_SERVICE_ACCOUNT o Firestore real não inicializa.
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const res = await get(adminToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      period: string;
      buckets: string[];
      visits: { value: number }[];
      downloads: { value: number }[];
      subscribers: { value: number }[];
    };
    expect(body.period).toBe("7d");
    expect(body.buckets).toHaveLength(7);
    for (const serie of [body.visits, body.downloads, body.subscribers]) {
      expect(serie).toHaveLength(7);
      expect(serie.every((p) => p.value === 0)).toBe(true);
    }
    if (sa !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT = sa;
  });

  it("admin sem period usa 30d", async () => {
    setTimeseriesFirestoreForTests({
      collection: () => ({
        where: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }),
      }),
    } as never);
    const res = await get(adminToken, "");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { buckets: string[] }).buckets).toHaveLength(
      30,
    );
  });
});
