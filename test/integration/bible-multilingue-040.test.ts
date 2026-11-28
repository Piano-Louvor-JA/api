import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Bíblia multilíngue (migration 040): /json_db/{lang}_bible_book e
 * {lang}_bible_version para os 13 idiomas novos + capítulos do cache local.
 * - Catálogo de livros: 66 livros com nomes do idioma (não fallback pt)
 * - Versão: id 100..112 conforme migration
 * - Capítulo bible_{v}_{book}_{c}: servido do cache local (BIBLE_CACHE_DIR),
 *   sem rede — antes do proxy upstream
 */
const LANGS = [
  ["en", 100],
  ["fr", 101],
  ["ru", 102],
  ["uk", 103],
  ["it", 104],
  ["nl", 105],
  ["pl", 106],
  ["tr", 107],
  ["ja", 108],
  ["ko", 109],
  ["zh", 110],
  ["ar", 111],
  ["hi", 112],
] as const;

describe("Bíblia multilíngue 15 idiomas (json_db)", () => {
  let app: SeededDb;
  let router: any;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    // migration 040 (966 INSERTs) torna o initDb mais lento que o default
  }, 60000);

  afterAll(() => app.cleanup());

  it.each(LANGS)(
    "GET /json_db/$lang_bible_book → catálogo multi-versão (SPEC-v2: v1 em [0])",
    async (lang) => {
      const res = await router.request(`/json_db/${lang}_bible_book`);
      expect(res.status).toBe(200);
      const books = await res.json();
      // SPEC-v2 §4.2: livros de TODAS as versões concatenadas (v1 primeiro,
      // 66 por versão). pt/es legados continuam 66 (fluxo DB/fallback).
      const V2: Record<string, number> = {
        en: 4,
        fr: 3,
        ru: 1,
        uk: 1,
        it: 1,
        nl: 1,
      };
      expect(books).toHaveLength(66 * (1 + (V2[lang] ?? 0)));
      expect(books[0].book_number).toBe(1);
      expect(books[0].chapters).toBe(50);
      expect(books[65].book_number).toBe(66);
    },
  );

  it.each(LANGS)(
    "GET /json_db/%s_bible_version → versão própria",
    async (lang, id) => {
      const res = await router.request(`/json_db/${lang}_bible_version`);
      expect(res.status).toBe(200);
      const versions = await res.json();
      // SPEC-v2 §4.2: N itens, v1 em [0] (compat retroativa).
      const V2: Record<string, number> = {
        en: 4,
        fr: 3,
        ru: 1,
        uk: 1,
        it: 1,
        nl: 1,
      };
      expect(versions).toHaveLength(1 + (V2[lang] ?? 0));
      expect(String(versions[0].id_bible_version)).toBe(String(id));
      expect(versions[0].name).toBeTruthy();
    },
  );

  it.each(LANGS)(
    "GET /json_db/%s_bible_book nomes reais (não fallback pt)",
    async (lang) => {
      const res = await router.request(`/json_db/${lang}_bible_book`);
      const books = await res.json();
      // nomes vêm do \toc1 do USFM (migration 040 real_names) — só
      // en/nl/pl coincidem com "Genesis"
      if (lang !== "en" && lang !== "nl" && lang !== "pl") {
        expect(books[0].name).not.toBe("Gênesis");
      }
      // apóstrofo escapado no SQL não pode vazar cru
      expect(books[0].name).not.toMatch(/''/);
    },
  );

  it("idioma fora da lista → 404", async () => {
    const res = await router.request("/json_db/de_bible_book");
    expect(res.status).toBe(404);
  });

  it("manifest /json_db lista os 15 idiomas", async () => {
    const res = await router.request("/json_db");
    expect(res.status).toBe(200);
    const manifest = await res.json();
    const files = manifest.map((m: { file: string }) => m.file);
    for (const [lang] of LANGS) {
      expect(files).toContain(`${lang}_bible_book.json`);
      expect(files).toContain(`${lang}_bible_version.json`);
    }
  });

  it("capítulo serve do cache local sem rede (bible_100_200_1)", async () => {
    // escreve no cache isolado (BIBLE_CACHE_DIR) — rota deve servir direto.
    // HOTFIX t_b3824cb7: cache multilíngue só vale carimbado com o
    // mtime+size do tarball (troca de tarball invalida). Sem o stamp a rota
    // re-extrai do tarball — comportamento esperado.
    const { resolveBibleCacheDir } = await import(
      "../../src/lib/bibleCacheDir.js"
    );
    const { tarballStamp } = await import("../../src/lib/bibleTarball.js");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const dir = resolveBibleCacheDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/bible_100_200_1.json`,
      JSON.stringify({
        1: "In the beginning God created the heavens and the earth.",
      }),
      "utf-8",
    );
    const stamp = tarballStamp("en");
    if (stamp) writeFileSync(`${dir}/bible_100_200_1.tarstamp`, stamp, "utf-8");
    const res = await router.request("/json_db/bible_100_200_1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body["1"]).toContain("In the beginning");
  });

  it("SPEC-v2: catálogo servido do arquivo multi-versão mesmo com DB vazio", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb();
    db.prepare("DELETE FROM bible_books WHERE id_language = 'hi'").run();
    db.prepare("DELETE FROM bible_versions WHERE language = 'hi'").run();

    // v2 (§4.2): o catálogo empacotado é a fonte — DB vazio não zera mais
    const books = await router.request("/json_db/hi_bible_book");
    expect(books.status).toBe(200);
    expect(((await books.json()) as unknown[]).length).toBe(66);

    const versions = await router.request("/json_db/hi_bible_version");
    expect(versions.status).toBe(200);
    expect(((await versions.json()) as unknown[]).length).toBe(1);
  });
});
