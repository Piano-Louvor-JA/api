import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildBuckets,
  fetchDownloadsSeries,
  fetchSubscribers,
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

  it("docs sem campo day usam o id; valores não numéricos contam zero", async () => {
    store.set("2026-11-19", { countries: { BR: 2, XX: "?" as never } } as Doc);
    store.set("2026-11-18", {} as Doc);
    setTimeseriesFirestoreForTests(makeFakeFirestore(store));
    // buckets fora de ordem: o intervalo da consulta não depende da ordem
    expect(await fetchVisitsSeries(["2026-11-19", "2026-11-18"])).toEqual([
      { key: "2026-11-19", value: 2 },
      { key: "2026-11-18", value: 0 },
    ]);

    store.clear();
    store.set("2026-11-19", { total: "x" as never } as Doc);
    expect(await fetchDownloadsSeries(["2026-11-19"])).toEqual([
      { key: "2026-11-19", value: 0 },
    ]);
  });

  it("downloads mensal: snapshot mais antigo lido depois não substitui o mais recente", async () => {
    store.set("2026-09-28", { day: "2026-09-28", total: 40 });
    store.set("2026-09-03", { day: "2026-09-03", total: 10 });
    // o fake devolve na ordem de inserção: 28 é lido antes de 03
    setTimeseriesFirestoreForTests(makeFakeFirestore(store));
    expect(await fetchDownloadsSeries(["2026-09"])).toEqual([
      { key: "2026-09", value: 40 },
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
  describe("Buttondown", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("pagina, aceita os dois formatos de campo e conta por bucket", async () => {
      process.env.BUTTONDOWN_API_KEY = "chave-teste";
      const pages: Record<string, unknown> = {
        "https://api.buttondown.com/v1/subscribers": {
          results: [
            { email: "a@exemplo.test", creation_date: "2026-11-18T10:00:00Z" },
            {
              email_address: "b@exemplo.test",
              created_at: "2026-11-19T09:00:00Z",
            },
          ],
          next: "https://api.buttondown.com/v1/subscribers?page=2",
        },
        "https://api.buttondown.com/v1/subscribers?page=2": {
          results: [{ creation_date: "2026-10-01T00:00:00Z" }, {}],
        },
      };
      const fetchMock = vi.fn(async (url: string) => ({
        ok: true,
        json: async () => pages[url],
      }));
      vi.stubGlobal("fetch", fetchMock);

      const subs = await fetchSubscribers();
      expect(subs).toEqual([
        { email: "a@exemplo.test", createdAt: "2026-11-18T10:00:00Z" },
        { email: "b@exemplo.test", createdAt: "2026-11-19T09:00:00Z" },
        { email: "", createdAt: "2026-10-01T00:00:00Z" },
        { email: "", createdAt: "" },
      ]);
      expect(fetchMock.mock.calls[0]?.[1]).toEqual({
        headers: { Authorization: "Token chave-teste" },
      });

      const series = await fetchSubscribersSeries(["2026-11-18", "2026-11-19"]);
      expect(series).toEqual([
        { key: "2026-11-18", value: 1 },
        { key: "2026-11-19", value: 1 },
      ]);
    });

    it("resposta não-ok devolve o que já foi lido", async () => {
      process.env.BUTTONDOWN_API_KEY = "chave-teste";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, json: async () => ({}) })),
      );
      expect(await fetchSubscribers()).toEqual([]);
    });

    it("pagina sem results e falha de rede zeram a série (fail-soft)", async () => {
      process.env.BUTTONDOWN_API_KEY = "chave-teste";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => ({ next: null }) })),
      );
      expect(await fetchSubscribers()).toEqual([]);

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("rede fora");
        }),
      );
      expect(await fetchSubscribersSeries(["2026-11-19"])).toEqual([
        { key: "2026-11-19", value: 0 },
      ]);
    });
  });
});
