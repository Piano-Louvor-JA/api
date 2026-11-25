import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  checkRateLimit,
  clientIpFrom,
  countryFromHeaders,
  getGeoStats,
  recordVisit,
  resetGeoVisitStateForTests,
  setGeoVisitFirestoreForTests,
  visitorIdFor,
} from "../../src/v1/geo/geo-visit.routes.js";

/**
 * SPEC piano-site-telemetria-v2 v1.0.0 (RF-A1..A4).
 * Pipeline puro com Firestore fake em memória. Zero rede.
 */

// ── Firestore fake em memória ───────────────────────────────────
type Doc = { day: string; countries: Record<string, number> };
const store = new Map<string, Doc>();

function makeFakeFirestore() {
  const makeDoc = (id: string) => ({
    set: async (data: Doc) => {
      const cur = store.get(id) ?? { day: data.day, countries: {} };
      for (const [c, v] of Object.entries(data.countries)) {
        cur.countries[c] =
          (cur.countries[c] ?? 0) + (typeof v === "number" ? v : 1);
      }
      cur.day = data.day;
      store.set(id, cur);
    },
  });
  return {
    collection: (_name: string) => ({
      doc: (id: string) => makeDoc(id),
      where: (_f: string, _op: string, cutoff: string) => ({
        orderBy: (_f2: string, _dir: string) => ({
          get: async () => ({
            docs: [...store.entries()]
              .filter(([id]) => id >= cutoff)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([id, data]) => ({ id, data: () => data })),
          }),
        }),
      }),
    }),
  } as never;
}

describe("geo-visit (telemetria v2)", () => {
  beforeEach(() => {
    store.clear();
    resetGeoVisitStateForTests();
    delete process.env.GEO_SALT;
    setGeoVisitFirestoreForTests(makeFakeFirestore());
  });

  afterAll(() => {
    setGeoVisitFirestoreForTests(null);
  });

  it("RF-A1: headers CDN na ordem de prioridade (hcdn > visitor > cf > vercel)", () => {
    expect(
      countryFromHeaders({ "x-hcdn-country": "br", "cf-ipcountry": "us" }),
    ).toBe("BR");
    expect(
      countryFromHeaders({ "x-visitor-country": "pt", "cf-ipcountry": "us" }),
    ).toBe("PT");
    expect(countryFromHeaders({ "cf-ipcountry": "us" })).toBe("US");
    expect(countryFromHeaders({ "x-vercel-ip-country": "ar" })).toBe("AR");
    expect(countryFromHeaders({ "x-hcdn-country": "BRA" })).toBe(null);
    expect(countryFromHeaders({})).toBe(null);
  });

  it("RF-A1: clientIp pega primeiro IP do XFF e cai em x-real-ip", () => {
    expect(clientIpFrom({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })).toBe(
      "1.2.3.4",
    );
    expect(clientIpFrom({ "x-real-ip": "9.9.9.9" })).toBe("9.9.9.9");
    expect(clientIpFrom({})).toBe(null);
  });

  it("RF-A1: recordVisit sem país/IP → no-country/no-ip (não grava)", async () => {
    expect(
      await recordVisit({ country: "", ip: "1.1.1.1", ua: "u", salt: "" }),
    ).toBe("no-country");
    expect(
      await recordVisit({ country: "BR", ip: "", ua: "u", salt: "" }),
    ).toBe("no-ip");
    expect(store.size).toBe(0);
  });

  it("RF-A1: dedup diária — mesma origem 2× no dia conta 1×; UA/dia diferente conta", async () => {
    const base = { country: "BR", ip: "10.0.0.1", salt: "s" };
    expect(await recordVisit({ ...base, ua: "ua-x", day: "2026-11-19" })).toBe(
      "counted",
    );
    expect(await recordVisit({ ...base, ua: "ua-x", day: "2026-11-19" })).toBe(
      "dedup",
    );
    expect(await recordVisit({ ...base, ua: "ua-y", day: "2026-11-19" })).toBe(
      "counted",
    );
    expect(await recordVisit({ ...base, ua: "ua-x", day: "2026-11-20" })).toBe(
      "counted",
    );
    expect(store.get("2026-11-19")?.countries.BR).toBe(2);
    expect(store.get("2026-11-20")?.countries.BR).toBe(1);
  });

  it("RF-A2: salt muda o visitorId (LGPD); formato dia:hash16", () => {
    const a = visitorIdFor("1.1.1.1", "ua", "2026-11-19", "salt-a");
    const b = visitorIdFor("1.1.1.1", "ua", "2026-11-19", "salt-b");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^2026-11-19:[0-9a-f]{16}$/);
  });

  it("RF-A1: rate-limit — 21ª request do mesmo IP em <60s bloqueada; janela desliza", () => {
    const ip = "7.7.7.7";
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit(ip, 1000 + i * 100)).toBe(true);
    }
    expect(checkRateLimit(ip, 1000 + 20 * 100)).toBe(false);
    expect(checkRateLimit("8.8.8.8", 3000)).toBe(true);
    expect(checkRateLimit(ip, 1000 + 61_000)).toBe(true);
  });

  it("RF-A2: getGeoStats agrega por país e reflete GEO_SALT (salted/unsalted)", async () => {
    const base = { ip: "10.0.0.1", salt: "" };
    await recordVisit({ ...base, country: "BR", ua: "u1", day: "2026-11-18" });
    await recordVisit({ ...base, country: "US", ua: "u2", day: "2026-11-19" });
    await recordVisit({ ...base, country: "BR", ua: "u3", day: "2026-11-19" });

    resetGeoVisitStateForTests();
    const stats = await getGeoStats(30);
    expect(stats.totalVisits).toBe(3);
    expect(stats.days).toBe(30);
    expect(stats.countries[0]).toEqual({ country: "BR", visits: 2 });
    expect(stats.countries[1]).toEqual({ country: "US", visits: 1 });
    expect(stats.telemetryMode).toBe("unsalted");

    process.env.GEO_SALT = "abc";
    resetGeoVisitStateForTests();
    expect((await getGeoStats(30)).telemetryMode).toBe("salted");
    delete process.env.GEO_SALT;
  });
});
