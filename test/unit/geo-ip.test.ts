import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isPublicIp,
  lookupGeo,
  parseGeoResponse,
  resetGeoIpForTests,
  setGeoCacheMaxForTests,
  setGeoFetchForTests,
} from "../../src/lib/geoIp.js";

/**
 * Cidade/UF por IP para a telemetria de dispositivos. Provedor via
 * GEOIP_URL (template com {ip}); cache por IP de 24 h; falha nunca lança.
 */
describe("geoIp", () => {
  const original = process.env.GEOIP_URL;

  beforeEach(() => {
    resetGeoIpForTests();
    process.env.GEOIP_URL = "https://geo.example/json/{ip}";
  });

  afterEach(() => {
    setGeoFetchForTests(null);
    process.env.GEOIP_URL = original;
  });

  it("só consulta IP público", () => {
    expect(isPublicIp("177.38.10.20")).toBe(true);
    expect(isPublicIp("2804:14c::1")).toBe(true);
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.9",
      "172.16.3.4",
      "169.254.1.1",
      "100.64.0.1",
      "100.127.255.1",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12::abcd",
      "unknown",
      "",
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it("entende os formatos comuns e prefere a sigla da UF", () => {
    // ip-api.com
    expect(
      parseGeoResponse({
        status: "success",
        city: "Bertioga",
        region: "SP",
        regionName: "São Paulo",
        countryCode: "BR",
      }),
    ).toEqual({ city: "Bertioga", region: "SP", country: "BR" });
    // ipapi.co / ipwho.is
    expect(
      parseGeoResponse({
        city: "Recife",
        region: "Pernambuco",
        region_code: "PE",
        country_code: "BR",
      }),
    ).toEqual({ city: "Recife", region: "PE", country: "BR" });
    // ipinfo.io (sem sigla: usa o nome)
    expect(
      parseGeoResponse({ city: "Lisboa", region: "Lisbon", country: "PT" }),
    ).toEqual({
      city: "Lisboa",
      region: "Lisbon",
      country: "PT",
    });
    // ipinfo.io no Brasil (provedor do api-piano-log): estado por extenso vira sigla
    expect(
      parseGeoResponse({
        ip: "177.38.10.20",
        city: "Bertioga",
        region: "São Paulo",
        country: "BR",
      }),
    ).toEqual({ city: "Bertioga", region: "SP", country: "BR" });
    expect(
      parseGeoResponse({
        city: "Brasília",
        region: "Federal District",
        country: "BR",
      }),
    ).toEqual({ city: "Brasília", region: "DF", country: "BR" });
    expect(
      parseGeoResponse({ city: "Macapá", region: "Amapa", country: "BR" }),
    ).toEqual({ city: "Macapá", region: "AP", country: "BR" });
    // Estado desconhecido no Brasil: mantém o texto do provedor
    expect(
      parseGeoResponse({ city: "X", region: "Algum Lugar", country: "BR" }),
    ).toEqual({ city: "X", region: "Algum Lugar", country: "BR" });
    // ip-api em falha
    expect(
      parseGeoResponse({ status: "fail", message: "private range" }),
    ).toBeNull();
    expect(parseGeoResponse(null)).toBeNull();
    // Objeto sem cidade/UF/país útil
    expect(parseGeoResponse({ status: "success" })).toBeNull();
    expect(
      parseGeoResponse({ city: "   ", region: "", country: null }),
    ).toBeNull();
    // Região longa fora do BR: cai no nome (não na sigla curta)
    expect(
      parseGeoResponse({
        city: "Berlin",
        region: "Berlin",
        regionName: "Berlin",
        countryCode: "DE",
      }),
    ).toEqual({ city: "Berlin", region: "Berlin", country: "DE" });
  });

  it("monta a URL do template e usa o cache para o mesmo IP", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ city: "Bertioga", region: "SP", countryCode: "BR" }),
        ),
    );
    setGeoFetchForTests(fetchMock as never);

    expect(await lookupGeo("177.38.10.20")).toEqual({
      city: "Bertioga",
      region: "SP",
      country: "BR",
    });
    expect(await lookupGeo("177.38.10.20")).toEqual({
      city: "Bertioga",
      region: "SP",
      country: "BR",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://geo.example/json/177.38.10.20",
    );
  });

  it("cache expira em 24 h", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ city: "A", region: "SP", countryCode: "BR" }),
        ),
    );
    setGeoFetchForTests(fetchMock as never);
    const t0 = Date.parse("2026-11-26T12:00:00Z");
    await lookupGeo("177.38.10.20", t0);
    await lookupGeo("177.38.10.20", t0 + 23 * 3600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await lookupGeo("177.38.10.20", t0 + 25 * 3600_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sem GEOIP_URL, IP privado, erro HTTP ou rede: devolve null sem lançar", async () => {
    const fetchMock = vi.fn(async () => new Response("x", { status: 500 }));
    setGeoFetchForTests(fetchMock as never);
    expect(await lookupGeo("192.168.0.2")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    expect(await lookupGeo("177.38.10.21")).toBeNull();

    setGeoFetchForTests((async () => {
      throw new Error("ECONNRESET");
    }) as never);
    expect(await lookupGeo("177.38.10.22")).toBeNull();

    delete process.env.GEOIP_URL;
    expect(await lookupGeo("177.38.10.23")).toBeNull();
  });

  it("provedor lento: desiste no timeout", async () => {
    setGeoFetchForTests(
      ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        })) as never,
    );
    const started = Date.now();
    expect(await lookupGeo("177.38.10.24", undefined, 50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("LRU: ao atingir o teto, remove a entrada mais antiga", async () => {
    setGeoCacheMaxForTests(1);
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify({
            city: url.includes("10.20") ? "A" : "B",
            region: "SP",
            countryCode: "BR",
          }),
        ),
    );
    setGeoFetchForTests(fetchMock as never);
    await lookupGeo("177.38.10.20");
    await lookupGeo("177.38.10.21");
    // Cap=1: a 2ª entrada expulsou a 1ª do cache.
    await lookupGeo("177.38.10.20");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    setGeoCacheMaxForTests(null);
  });

  it("LRU com teto 0: cache vazio não encontra oldest (ramo else)", async () => {
    setGeoCacheMaxForTests(0);
    setGeoFetchForTests(
      (async () =>
        new Response(
          JSON.stringify({ city: "A", region: "SP", countryCode: "BR" }),
        )) as never,
    );
    expect(await lookupGeo("177.38.10.25")).toEqual({
      city: "A",
      region: "SP",
      country: "BR",
    });
    setGeoCacheMaxForTests(null);
  });

  it("sem fetch injetado, usa globalThis.fetch", async () => {
    setGeoFetchForTests(null);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ city: "C", region: "RJ", countryCode: "BR" }),
        ),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as never;
    try {
      expect(await lookupGeo("177.38.10.26")).toEqual({
        city: "C",
        region: "RJ",
        country: "BR",
      });
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});
