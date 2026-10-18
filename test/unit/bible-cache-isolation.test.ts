import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBibleCacheDir } from "../../src/lib/bibleCacheDir.js";

/**
 * Testes nunca podem escrever no cache real (data/bible_cache): um
 * `{"cached":true}` de teste chegou à produção como ACRF Gálatas 1 e foi
 * servido a usuários por /json_db/bible_1_50_1 e quebrou o bundle da ACRF.
 */
describe("isolamento do cache da Bíblia nos testes", () => {
  it("BIBLE_CACHE_DIR aponta para uma pasta temporária, fora do repositório", () => {
    const dir = resolveBibleCacheDir();
    expect(dir).not.toBe(join(process.cwd(), "data", "bible_cache"));
    expect(relative(tmpdir(), dir).startsWith("..")).toBe(false);
  });

  it("sem BIBLE_CACHE_DIR (produção) o padrão continua data/bible_cache", () => {
    const original = process.env.BIBLE_CACHE_DIR;
    delete process.env.BIBLE_CACHE_DIR;
    try {
      expect(resolveBibleCacheDir()).toBe(
        join(process.cwd(), "data", "bible_cache"),
      );
    } finally {
      process.env.BIBLE_CACHE_DIR = original;
    }
  });
});
