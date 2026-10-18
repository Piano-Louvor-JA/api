import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { _resetBibleBundleCacheForTest } from "../../src/v1/bible/bundle.service.js";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Bíblia offline (app .planning/bible-offline): versão inteira num request
 * + manifesto com sha256 para o cliente detectar atualização.
 * Fonte = data/bible_cache (mesma do /json_db/bible_{v}_{b}_{c}); o bundle
 * nunca chama o upstream.
 */
describe("GET /v1/bible/bundles", () => {
  let app: SeededDb;
  let router: any;
  let cacheDir: string;
  const originalCacheDir = process.env.BIBLE_CACHE_DIR;
  const originalRevalidate = process.env.BIBLE_BUNDLE_REVALIDATE_MS;
  const fetchSpy = vi.fn().mockRejectedValue(new Error("upstream proibido"));

  function writeChapter(
    version: number,
    book: number,
    chapter: number,
    verses: unknown,
  ) {
    writeFileSync(
      join(cacheDir, `bible_${version}_${book}_${chapter}.json`),
      JSON.stringify(verses),
      "utf-8",
    );
  }

  function sha256(buf: Buffer | string): string {
    return createHash("sha256").update(buf).digest("hex");
  }

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "piano-bible-cache-"));
    process.env.BIBLE_CACHE_DIR = cacheDir;
    process.env.BIBLE_BUNDLE_REVALIDATE_MS = "0";
    vi.stubGlobal("fetch", fetchSpy);

    app = await setupSeededDb();
    router = app.router;
    app.getDb().exec(`
      INSERT OR IGNORE INTO languages (id_language, name) VALUES ('tt','Teste');
      INSERT INTO bible_versions (id_version, name, language, abbreviation) VALUES
        ('901','Versao Completa','tt','VC'),
        ('902','Versao Incompleta','tt',NULL);
      INSERT INTO bible_books (id_book, name, abbreviation, chapters, book_number, id_language) VALUES
        (9001,'Livro Um','L1',2,1,'tt'),
        (9002,'Livro Dois','L2',1,2,'tt');
      INSERT OR IGNORE INTO languages (id_language, name) VALUES ('zz','Sem livros'), ('uu','Capitulos nulos');
      INSERT INTO bible_versions (id_version, name, language, abbreviation) VALUES
        ('903','Sem Livros','zz','SL'),
        ('904','Arquivos Ruins','tt','AR'),
        ('905','Livro Nulo','uu','LN'),
        ('906','Cache Em Memoria','tt','CM'),
        ('907.0','Id Com Ponto Zero','tt','PZ'),
        ('908.5','Id Fracionario','tt','FR');
      INSERT INTO bible_books (id_book, name, abbreviation, chapters, book_number, id_language) VALUES
        (9101,'Sem Capitulos','SC',NULL,1,'uu'),
        (9102,'Com Capitulo','CC',1,2,'uu');
    `);

    writeChapter(901, 9001, 1, { "1": "No princípio", "2": "<J>Eu sou</J>" });
    writeChapter(901, 9001, 2, { "1": "Segundo capítulo" });
    writeChapter(901, 9002, 1, { "1": "Outro livro" });
    // 902: falta o capítulo 9001:2
    writeChapter(902, 9001, 1, { "1": "a" });
    writeChapter(902, 9002, 1, { "1": "b" });
    // 904: cache com conteúdo que não é capítulo
    writeChapter(904, 9001, 1, ["não", "é", "objeto"]);
    writeChapter(904, 9001, 2, { "1": "   ", "2": "<J></J>" });
    writeChapter(904, 9002, 1, { "1": "ok" });
    writeChapter(905, 9102, 1, { "1": "único capítulo" });
    writeChapter(906, 9001, 1, { "1": "a" });
    writeChapter(906, 9001, 2, { "1": "b" });
    writeChapter(906, 9002, 1, { "1": "c" });
    // produção grava os ids PT como texto "2.0", "13.0" (import antigo)
    writeChapter(907, 9001, 1, { "1": "um" });
    writeChapter(907, 9001, 2, { "1": "dois" });
    writeChapter(907, 9002, 1, { "1": "três" });
  });

  afterAll(() => {
    app.cleanup();
    rmSync(cacheDir, { recursive: true, force: true });
    if (originalCacheDir === undefined) delete process.env.BIBLE_CACHE_DIR;
    else process.env.BIBLE_CACHE_DIR = originalCacheDir;
    if (originalRevalidate === undefined)
      delete process.env.BIBLE_BUNDLE_REVALIDATE_MS;
    else process.env.BIBLE_BUNDLE_REVALIDATE_MS = originalRevalidate;
    vi.unstubAllGlobals();
  });

  it("bundle completo: JSON da versão inteira, textos sanitizados", async () => {
    const res = await router.request("/v1/bible/bundles/901");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual({
      schema: 1,
      versionId: 901,
      language: "tt",
      name: "Versao Completa",
      abbreviation: "VC",
      chapters: {
        "9001": {
          "1": { "1": "No princípio", "2": "Eu sou" },
          "2": { "1": "Segundo capítulo" },
        },
        "9002": { "1": { "1": "Outro livro" } },
      },
    });
  });

  it("gzip quando o cliente aceita; sha256 = bytes descompactados = ETag", async () => {
    const plain = await router.request("/v1/bible/bundles/901");
    const plainBytes = Buffer.from(await plain.arrayBuffer());

    const res = await router.request("/v1/bible/bundles/901", {
      headers: { "Accept-Encoding": "gzip, deflate" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const unzipped = gunzipSync(Buffer.from(await res.arrayBuffer()));
    expect(unzipped.equals(plainBytes)).toBe(true);

    const hash = sha256(plainBytes);
    expect(res.headers.get("etag")).toBe(`"${hash}"`);
    expect(plain.headers.get("etag")).toBe(`"${hash}"`);
  });

  it("If-None-Match igual → 304 sem corpo", async () => {
    const first = await router.request("/v1/bible/bundles/901");
    const etag = first.headers.get("etag");
    const res = await router.request("/v1/bible/bundles/901", {
      headers: { "If-None-Match": `W/${etag}` },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("manifesto: versão completa com sha256/bytes, incompleta sem sha", async () => {
    const bundle = await router.request("/v1/bible/bundles/901");
    const bundleBytes = Buffer.from(await bundle.arrayBuffer());

    const res = await router.request("/v1/bible/bundles");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema).toBe(1);

    const complete = body.versions.find((v: any) => v.versionId === 901);
    expect(complete).toMatchObject({
      versionId: 901,
      language: "tt",
      name: "Versao Completa",
      abbreviation: "VC",
      books: 2,
      chapters: 3,
      complete: true,
      missing: 0,
      sha256: sha256(bundleBytes),
      bytes: bundleBytes.length,
    });
    expect(complete.gzipBytes).toBeGreaterThan(0);
    expect(typeof complete.updatedAt).toBe("string");

    const incomplete = body.versions.find((v: any) => v.versionId === 902);
    expect(incomplete).toMatchObject({
      complete: false,
      missing: 1,
      sha256: null,
      bytes: null,
      gzipBytes: null,
    });

    // id não numérico do seed ('acf') não tem chave bible_{v}_{b}_{c}
    expect(body.versions.some((v: any) => Number.isNaN(v.versionId))).toBe(
      false,
    );
  });

  it("versão incompleta → 409 e nunca chama o upstream", async () => {
    fetchSpy.mockClear();
    const res = await router.request("/v1/bible/bundles/902");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("bundle_incompleto");
    expect(body.missing).toBe(1);
    expect(body.sample).toEqual(["bible_902_9001_2"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("versão inexistente → 404; id inválido → 400", async () => {
    expect((await router.request("/v1/bible/bundles/777")).status).toBe(404);
    expect((await router.request("/v1/bible/bundles/abc")).status).toBe(400);
  });

  it("capítulo alterado no cache → sha256 muda", async () => {
    const before = (await router.request("/v1/bible/bundles/901")).headers.get(
      "etag",
    );
    writeChapter(901, 9002, 1, { "1": "Outro livro (revisado)" });
    const future = new Date(Date.now() + 5_000);
    utimesSync(join(cacheDir, "bible_901_9002_1.json"), future, future);

    const after = await router.request("/v1/bible/bundles/901");
    expect(after.headers.get("etag")).not.toBe(before);
    const body = await after.json();
    expect(body.chapters["9002"]["1"]["1"]).toBe("Outro livro (revisado)");
  });

  it("contrato antigo: /json_db/bible_{v}_{b}_{c} continua servindo o arquivo do cache", async () => {
    const res = await router.request("/json_db/bible_901_9001_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      "1": "No princípio",
      "2": "<J>Eu sou</J>",
    });
  });

  it("versão de idioma sem livros → 404 e manifesto sem capítulos", async () => {
    expect((await router.request("/v1/bible/bundles/903")).status).toBe(404);
    const body = await (await router.request("/v1/bible/bundles")).json();
    expect(body.versions.find((v: any) => v.versionId === 903)).toMatchObject({
      books: 0,
      chapters: 0,
      complete: false,
      missing: 0,
      sha256: null,
      updatedAt: null,
    });
  });

  it("arquivo que não é objeto ou capítulo vazio após sanitizar conta como faltando", async () => {
    const res = await router.request("/v1/bible/bundles/904");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.missing).toBe(2);
    expect(body.sample).toEqual(["bible_904_9001_1", "bible_904_9001_2"]);
  });

  it("livro com capítulos nulos não gera capítulo esperado", async () => {
    const res = await router.request("/v1/bible/bundles/905");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chapters).toEqual({
      "9102": { "1": { "1": "único capítulo" } },
    });
  });

  it("If-None-Match: * → 304; ETag diferente → 200", async () => {
    const star = await router.request("/v1/bible/bundles/901", {
      headers: { "If-None-Match": "*" },
    });
    expect(star.status).toBe(304);
    const other = await router.request("/v1/bible/bundles/901", {
      headers: { "If-None-Match": '"outro", W/"mais-um"' },
    });
    expect(other.status).toBe(200);
  });

  it("dentro do prazo de revalidação (padrão 60 s) serve o bundle em memória", async () => {
    process.env.BIBLE_BUNDLE_REVALIDATE_MS = "invalido";
    _resetBibleBundleCacheForTest();
    try {
      const first = await router.request("/v1/bible/bundles/906");
      writeChapter(906, 9002, 1, { "1": "mudou no disco" });
      const second = await router.request("/v1/bible/bundles/906");
      expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
      expect((await second.json()).chapters["9002"]["1"]["1"]).toBe("c");
    } finally {
      process.env.BIBLE_BUNDLE_REVALIDATE_MS = "0";
      _resetBibleBundleCacheForTest();
    }
    const fresh = await (await router.request("/v1/bible/bundles/906")).json();
    expect(fresh.chapters["9002"]["1"]["1"]).toBe("mudou no disco");
  });

  it('id gravado como "907.0" (formato de produção) entra no manifesto e no bundle como 907', async () => {
    const manifest = await (await router.request("/v1/bible/bundles")).json();
    expect(
      manifest.versions.find((v: any) => v.versionId === 907),
    ).toMatchObject({
      abbreviation: "PZ",
      complete: true,
      missing: 0,
    });
    // id fracionário não tem chave bible_{v}_{b}_{c}: fica de fora
    expect(manifest.versions.some((v: any) => v.abbreviation === "FR")).toBe(
      false,
    );

    const res = await router.request("/v1/bible/bundles/907");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versionId).toBe(907);
    expect(body.chapters["9001"]["2"]).toEqual({ "1": "dois" });
  });

  it("contrato antigo: /v1/bible/{bookId}/{chapter} não é capturado pelos bundles", async () => {
    const res = await router.request("/v1/bible/50/1?lang=pt");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id_bible_book).toBe(50);
    expect(body.verses[0].text).toBe("Paulo, apostolo");
  });
});
