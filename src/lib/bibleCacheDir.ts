import { join } from "node:path";

/**
 * Diretório do cache de capítulos (`bible_{v}_{b}_{c}.json`). Fonte única do
 * proxy `/json_db/bible_*` e dos bundles `/v1/bible/bundles`. Resolvido a
 * cada chamada para que `BIBLE_CACHE_DIR` valha também em testes.
 */
export function resolveBibleCacheDir(): string {
  return (
    process.env.BIBLE_CACHE_DIR || join(process.cwd(), "data", "bible_cache")
  );
}
