import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");
const {
  clientIpFrom,
  getGeoStats,
  recordVisit,
  resetGeoVisitStateForTests,
  setGeoVisitFirestoreForTests,
} = await import("../../src/v1/geo/geo-visit.routes.js");

/** Rotas /v1/geo e caminhos de borda do pipeline (Firestore fake). */
type Write = { day: string; country: string };

function fakeFirestore(
  writes: Write[],
  docs: Array<Record<string, unknown>> = [],
  counter = { gets: 0 },
) {
  return {
    collection: () => ({
      doc: (day: string) => ({
        set: async (data: { countries: Record<string, unknown> }) => {
          for (const country of Object.keys(data.countries))
            writes.push({ day, country });
        },
      }),
      where: () => ({
        orderBy: () => ({
          get: async () => {
            counter.gets++;
            return { docs: docs.map((d) => ({ data: () => d })) };
          },
        }),
      }),
    }),
  } as never;
}

describe("/v1/geo", () => {
  let app: SeededDb;
  let adminToken: string;
  let writes: Write[];

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "adm-geo2@test.local";
    app = await setupSeededDb();
    adminToken = registerUser("adm-geo2@test.local", "SenhaForte1!").token;
  });

  beforeEach(() => {
    writes = [];
    resetGeoVisitStateForTests();
    delete process.env.GEO_SALT;
    setGeoVisitFirestoreForTests(fakeFirestore(writes));
  });

  afterEach(() => setGeoVisitFirestoreForTests(null));

  const visit = (headers: Record<string, string>) =>
    app.router.request("/v1/geo/visit", { method: "POST", headers });

  it("POST /visit com país e IP grava a visita do dia → 204", async () => {
    process.env.GEO_SALT = "sal";
    const res = await visit({
      "cf-ipcountry": "br",
      "x-real-ip": "10.0.0.1",
      "user-agent": "ua-teste",
    });
    expect(res.status).toBe(204);
    expect(writes).toEqual([
      { day: new Date().toISOString().slice(0, 10), country: "BR" },
    ]);
  });

  it("POST /visit sem headers → 204 sem gravar", async () => {
    const res = await visit({});
    expect(res.status).toBe(204);
    expect(writes).toEqual([]);
  });

  it("POST /visit com Firestore indisponível continua 204", async () => {
    setGeoVisitFirestoreForTests(null);
    const saved = process.env.FIREBASE_SERVICE_ACCOUNT;
    process.env.FIREBASE_SERVICE_ACCOUNT = "{inválido";
    try {
      const res = await visit({
        "cf-ipcountry": "PT",
        "x-forwarded-for": "10.0.0.2",
      });
      expect(res.status).toBe(204);
    } finally {
      if (saved === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
      else process.env.FIREBASE_SERVICE_ACCOUNT = saved;
    }
  });

  it("XFF com primeiro item vazio cai no x-real-ip", () => {
    expect(
      clientIpFrom({ "x-forwarded-for": " ,1.2.3.4", "x-real-ip": "9.9.9.9" }),
    ).toBe("9.9.9.9");
  });

  it("rate-limit por IP devolve rate-limited", async () => {
    const base = { country: "BR", ip: "10.1.1.1", salt: "" };
    for (let i = 0; i < 20; i++) await recordVisit({ ...base, ua: `u${i}` });
    expect(await recordVisit({ ...base, ua: "u-extra" })).toBe("rate-limited");
  });

  it("dedup descarta o visitante mais antigo ao passar do limite", async () => {
    const day = "2026-11-19";
    for (let i = 0; i <= 10_000; i++) {
      await recordVisit({
        country: "BR",
        ip: `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`,
        ua: "u",
        salt: "",
        day,
      });
    }
    // O primeiro saiu do conjunto e volta a contar; o último ainda é dedup.
    expect(
      await recordVisit({
        country: "BR",
        ip: "10.0.0.0",
        ua: "u",
        salt: "",
        day,
      }),
    ).toBe("counted");
    expect(
      await recordVisit({
        country: "BR",
        ip: `10.0.39.16`,
        ua: "u",
        salt: "",
        day,
      }),
    ).toBe("dedup");
  });

  it("getGeoStats usa cache por 60s e tolera documentos incompletos", async () => {
    const counter = { gets: 0 };
    setGeoVisitFirestoreForTests(
      fakeFirestore(
        writes,
        [{ day: "2026-11-19" }, { countries: { BR: "x", US: 2 } }],
        counter,
      ),
    );
    const first = await getGeoStats(10);
    expect(first).toMatchObject({ totalVisits: 2, telemetryMode: "unsalted" });
    expect(await getGeoStats(10)).toBe(first);
    await getGeoStats(11);
    expect(counter.gets).toBe(2);
  });

  it("GET /stats normaliza days (inválido → 30, teto 365)", async () => {
    const get = async (q: string) => {
      resetGeoVisitStateForTests();
      const res = await app.router.request(`/v1/geo/stats${q}`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      return ((await res.json()) as { days: number }).days;
    };
    expect(await get("")).toBe(30);
    expect(await get("?days=abc")).toBe(30);
    expect(await get("?days=-3")).toBe(30);
    expect(await get("?days=9999")).toBe(365);
  });
});
