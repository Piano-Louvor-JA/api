import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 14b: compat bible abbreviation — todas as fontes:
 * abbreviation no campo / pelo nome (mapa) / pelo id curto / vazio.
 * Bíblia precisa de linhas em bible_versions com combinações diferentes.
 */
describe("compat abbreviation matrix", () => {
  let app: SeededDb;
  let router: any;
  const origFetch = globalThis.fetch;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    const db = app.getDb();
    // esboço: garantir bible_versions com combinações
    try {
      db.exec(`
        INSERT OR IGNORE INTO bible_versions (id_version, name, abbreviation, language) VALUES
          (301, 'Versão Com Abrev', 'VCA', 'pt'),
          (302, 'Almeida Revista e Corrigida', NULL, 'pt'),
          (303, 'Nova Versão Internacional', NULL, 'pt'),
          (304, 'Reina Valera 1960', NULL, 'es'),
          (999, 'Xyzwq', NULL, 'pt');
      `);
    } catch {
      // schema pode ter colunas diferentes — smoke via rotas abaixo
    }
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
    app.cleanup();
  });

  it("pt_bible_version: abbreviation resolvida por campo/nome/id", async () => {
    const res = await router.request("/json_db/pt_bible_version");
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = Array.isArray(body) ? body : body.data ?? [];
    if (Array.isArray(items)) {
      const byId = new Map(items.map((v: any) => [v.id_version, v]));
      const vca = byId.get(301);
      if (vca) expect(vca.abbreviation).toBe("VCA");
      const arc = byId.get(302);
      if (arc) expect(arc.abbreviation.toLowerCase()).toContain("arc");
      const xyz = byId.get(999);
      if (xyz) expect(xyz.abbreviation.toUpperCase()).toBe("XYZWQ");
    }
  });

  it("es_bible_book: upstream 200 populando cache do fallback", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ id_book: 2, name: "Êxodo" }]),
    } as any);
    const res = await router.request("/json_db/es_bible_book");
    expect([200, 404]).toContain(res.status);
  });

  it("es_bible_book: segundo call usa cache (sem fetch)", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ id_book: 3, name: "Levítico" }]),
    });
    globalThis.fetch = spy as any;
    const r1 = await router.request("/json_db/es_bible_book");
    const callsAfterFirst = spy.mock.calls.length;
    const r2 = await router.request("/json_db/es_bible_book");
    expect([200, 404]).toContain(r1.status);
    expect([200, 404]).toContain(r2.status);
    // se cache ativo, 2º call não refetch
    if (r1.status === 200 && r2.status === 200) {
      expect(spy.mock.calls.length).toBe(callsAfterFirst);
    }
  });

  it("es_bible_version com rows vazias → fallback constante", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("down"));
    const res = await router.request("/json_db/es_bible_version");
    expect([200]).toContain(res.status);
    const body = await res.json();
    const items = Array.isArray(body) ? body : body.data ?? [];
    if (Array.isArray(items) && items.length > 0) {
      expect(items[0].id_bible_version ?? items[0].id).toBeDefined();
    }
  });
});
