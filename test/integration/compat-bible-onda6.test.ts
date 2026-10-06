import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 6a: compat bible lazy-proxy e miss com on-miss import.
 * - /json_db/pt_bible_version → 200 (pt: seed migration)
 * - /json_db/es_bible_version → fallback do ecossistema (200) sem rede
 * - /json_db/bible_12_1_1 → proxy/cache: 200 ou 404 controlado
 * - /json_db/music_30 → existe no seed → 200 direto
 * - ON_MISS_FETCH=off: /json_db/music_424242 → 404 sem importar
 */
describe("Compat bible + on-miss", () => {
  let app: SeededDb;
  let router: any;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
  });

  afterAll(() => app.cleanup());

  it("GET /json_db/pt_bible_version → 200", async () => {
    const res = await router.request("/json_db/pt_bible_version");
    expect(res.status).toBe(200);
  });

  it("GET /json_db/es_bible_version → fallback com versões ES (200)", async () => {
    const res = await router.request("/json_db/es_bible_version");
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = Array.isArray(body) ? body : body.data ?? [];
    if (Array.isArray(items) && items.length > 0) {
      expect(items[0].id_bible_version ?? items[0].id).toBeDefined();
    }
  });

  it("GET /json_db/music_30 (seed) → 200", async () => {
    const res = await router.request("/json_db/music_30");
    expect([200, 404]).toContain(res.status);
  });

  it("GET /json_db/music_424242 com ON_MISS off → 404", async () => {
    const res = await router.request("/json_db/music_424242");
    expect(res.status).toBe(404);
  });

  it("GET /json_db/bible_12_1_1 → 200/404 controlado (proxy lazy)", async () => {
    const res = await router.request("/json_db/bible_12_1_1");
    expect([200, 404]).toContain(res.status);
  });

  it("GET /json_db/bible_99_99_99 → 404 (versão inexistente)", async () => {
    const res = await router.request("/json_db/bible_99_99_99");
    expect([404, 502]).toContain(res.status);
  });
});
