import { beforeEach, describe, expect, it } from "vitest";

import {
  buildBuckets,
  fetchDownloadsSeries,
  fetchSubscribersSeries,
  fetchVisitsSeries,
  resolvePeriod,
  setTimeseriesFirestoreForTests,
} from "../../src/v1/geo/geo-timeseries.routes.js";

/**
 * SPEC piano-site-telemetria-v2 v1.0.0 (RF-A3).
 * Séries temporais com Firestore fake em memória. Zero rede.
 */

type Doc = { day: string; countries?: Record<string, number>; total?: number };

function makeFakeFirestore(store: Map<string, Doc>) {
  return {
    collection: (name: string) => ({
      where: (_f: string, _op: string, cutoff: string) => ({
        where: (_f2: string, _op2: string, hi: string) => ({
          get: async () => ({
            docs: [...store.entries()]
              .filter(
                ([id]) =>
                  (name === "geoStats" || name === "downloadSnapshots") &&
                  id >= cutoff &&
                  id <= hi.replace("\uf8ff", "\uffff"),
              )
              .map(([id, data]) => ({ id, data: () => data })),
          }),
        }),
      }),
    }),
  } as never;
}

describe("geo-timeseries (RF-A3)", () => {
  const store = new Map<string, Doc>();

  beforeEach(() => {
    store.clear();
    delete process.env.BUTTONDOWN_API_KEY;
  });

  it("resolvePeriod: default 30d e períodos válidos", () => {
    expect(resolvePeriod(undefined)).toBe("30d");
    expect(resolvePeriod("bogus")).toBe("30d");
    expect(resolvePeriod("7d")).toBe("7d");
    expect(resolvePeriod("12m")).toBe("12m");
  });

  it("buildBuckets: 7d gera 7 dias, 30d gera 30, 12m gera 12 meses", () => {
    expect(buildBuckets("7d")).toHaveLength(7);
    expect(buildBuckets("30d")).toHaveLength(30);
    const m = buildBuckets("12m");
    expect(m).toHaveLength(12);
    for (const b of m) expect(b).toMatch(/^\d{4}-\d{2}$/);
  });

  it("visits: soma países por dia e agrega por mês", async () => {
    store.set("2026-10-05", {
      day: "2026-10-05",
      countries: { BR: 3, PT: 2 },
    });
    store.set("2026-10-20", { day: "2026-10-20", countries: { BR: 4 } });
    store.set("2026-11-01", { day: "2026-11-01", countries: { US: 1 } });
    setTimeseriesFirestoreForTests(makeFakeFirestore(store));

    const monthly = await fetchVisitsSeries(["2026-10", "2026-11"]);
    expect(monthly).toEqual([
      { key: "2026-10", value: 9 },
      { key: "2026-11", value: 1 },
    ]);
  });

  it("downloads diário: total do dia (snapshot, não delta)", async () => {
    store.set("2026-11-17", { day: "2026-11-17", total: 100 });
    store.set("2026-11-18", { day: "2026-11-18", total: 120 });
    setTimeseriesFirestoreForTests(makeFakeFirestore(store));

    const series = await fetchDownloadsSeries(["2026-11-17", "2026-11-18"]);
    expect(series).toEqual([
      { key: "2026-11-17", value: 100 },
      { key: "2026-11-18", value: 120 },
    ]);
  });

  it("downloads mensal: usa o ÚLTIMO snapshot do mês (total vigente)", async () => {
    store.set("2026-09-03", { day: "2026-09-03", total: 10 });
    store.set("2026-09-28", { day: "2026-09-28", total: 40 });
    store.set("2026-10-15", { day: "2026-10-15", total: 55 });
    setTimeseriesFirestoreForTests(makeFakeFirestore(store));

    const series = await fetchDownloadsSeries(["2026-09", "2026-10"]);
    expect(series).toEqual([
      { key: "2026-09", value: 40 },
      { key: "2026-10", value: 55 },
    ]);
  });

  it("subscribers: sem BUTTONDOWN_API_KEY vem zerada (fail-soft)", async () => {
    const buckets = ["2026-11-18", "2026-11-19"];
    const series = await fetchSubscribersSeries(buckets);
    expect(series).toEqual([
      { key: "2026-11-18", value: 0 },
      { key: "2026-11-19", value: 0 },
    ]);
  });

  it("buckets vazios retornam séries vazias", async () => {
    setTimeseriesFirestoreForTests(makeFakeFirestore(store));
    expect(await fetchVisitsSeries([])).toEqual([]);
    expect(await fetchDownloadsSeries([])).toEqual([]);
    expect(await fetchSubscribersSeries([])).toEqual([]);
  });
});
