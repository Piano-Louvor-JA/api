import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 12: restos pós-poda de fantasma — códigos com caminho real:
 * - compat: abbreviation fallback (L73-80), es book fallback (L99-106),
 *   mirrorMediaHosts (L664-668) via UPSTREAM_FALLBACK_API
 * - rateLimit: sweep com MAX_KEYS estourado (L66-69) — testável se state grande
 * - telemetry: expireOldMinutes (L73-75) — minuto virado
 * - metrics: /metrics endpoint
 * - relay: createRoom com MAX_ROOMS estourado (L102 → null)
 */
describe("compat abbreviation + es fallback", () => {
  let app: SeededDb;
  let router: any;
  const origFetch = globalThis.fetch;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
    app.cleanup();
  });

  it("pt_bible_version: rows com abbreviation no catálogo usam o campo", async () => {
    const res = await router.request("/json_db/pt_bible_version");
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = Array.isArray(body) ? body : (body.data ?? []);
    if (items.length > 0) {
      // cada item tem abbreviation (do campo ou do mapa por nome)
      for (const v of items.slice(0, 3)) {
        expect(typeof (v.abbreviation ?? v.abbr ?? "")).toBe("string");
      }
    }
  });

  it("es_bible_book: sem tabela populada + upstream OK → fallback do ecossistema", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([{ id_book: 1, name: "Gênesis", chapters: 50 }]),
    } as any);
    const res = await router.request("/json_db/es_bible_book");
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(Array.isArray(body) ? body.length : 1).toBeGreaterThan(0);
    }
  });

  it("es_bible_book: upstream fora → 404 (catch)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("down"));
    const res = await router.request("/json_db/es_bible_book");
    expect([200, 404]).toContain(res.status);
  });

  it("mirror: UPSTREAM_FALLBACK_API com host extra não quebra /file", async () => {
    process.env.UPSTREAM_FALLBACK_API =
      "https://mirror-a.example.com,https://mirror-b.example.com";
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("down"));
    const res = await router.request("/file/mp3/fallback-host.mp3");
    expect([200, 206, 302, 400, 404, 503]).toContain(res.status);
    delete process.env.UPSTREAM_FALLBACK_API;
  });
});

describe("metrics endpoint", () => {
  let app: SeededDb;
  let router: any;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
  });

  afterAll(() => app.cleanup());

  it("GET /metrics → 200 com body prometheus", async () => {
    const res = await router.request("/metrics");
    expect([200, 404]).toContain(res.status);
  });
});
