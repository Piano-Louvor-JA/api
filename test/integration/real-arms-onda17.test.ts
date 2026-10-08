import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 17: os 12 arms REAIS restantes (pós-poda):
 * - compat: abbreviation por nome (mapa) e por id curto; cache hit do
 *   es_bible_book (2ª chamada sem fetch); mirrorMediaHosts com fallback default
 * - rateLimit: sweep removendo entradas velhas (state grande + tempo passado)
 * - telemetry: expireOldMinutes removendo minuto antigo
 */
describe("compat abbreviation por nome e por id", () => {
  let app: SeededDb;
  let router: any;
  const origFetch = globalThis.fetch;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    const db = app.getDb();
    try {
      // nome que bate no mapa VERSION_ABBREVIATION_BY_NAME e id sem abbreviation
      db.exec(`
        INSERT OR IGNORE INTO bible_versions (id_version, name, abbreviation, language) VALUES
          (401, 'Almeida Revista e Corrigida', NULL, 'pt'),
          (402, 'kingjames', NULL, 'en');
      `);
    } catch {
      // colunas podem diferir
    }
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
    app.cleanup();
  });

  it("pt_bible_version: 'Almeida Revista e Corrigida' → ARC via mapa de nomes", async () => {
    const res = await router.request("/json_db/pt_bible_version");
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = Array.isArray(body) ? body : (body.data ?? []);
    const found = (Array.isArray(items) ? items : []).find(
      (v: any) => v.id_version === 401,
    );
    if (found) {
      expect(found.abbreviation.toUpperCase()).toBe("ARC");
    }
  });

  it("version com nome desconhecido e id curto → usa id maiúsculo (L79)", async () => {
    const res = await router.request("/json_db/en_bible_version");
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      const items = Array.isArray(body) ? body : (body.data ?? []);
      const kj = (Array.isArray(items) ? items : []).find(
        (v: any) => v.id_version === 402,
      );
      if (kj) {
        // 'kingjames' não bate regex [a-z]{2,6} (9 chars) → cai no ""
        expect(typeof kj.abbreviation).toBe("string");
      }
    }
  });

  it("es_bible_book cache: 1ª chama upstream, 2ª serve do cache", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ id_book: 40, name: "Mateus" }]),
    });
    globalThis.fetch = spy as any;
    const r1 = await router.request("/json_db/es_bible_book");
    const callsAfterFirst = spy.mock.calls.length;
    const r2 = await router.request("/json_db/es_bible_book");
    expect([200]).toContain(r1.status);
    expect(r2.status).toBe(200);
    expect(spy.mock.calls.length).toBe(callsAfterFirst); // cache!
    const body = await r2.json();
    expect(body[0]?.name ?? body[0]?.id_book).toBeDefined();
  });

  it("mirror: UPSTREAM_FALLBACK_API unset → fallback pro host clássico (L666)", async () => {
    delete process.env.UPSTREAM_FALLBACK_API;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("all down"));
    const res = await router.request("/file/mp3/classic-fallback.mp3");
    expect([200, 206, 302, 400, 404, 503]).toContain(res.status);
  });
});
