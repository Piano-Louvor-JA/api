import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Cada arquivo de teste usa um cache da Bíblia temporário próprio: o proxy
// /json_db/bible_* e os bundles gravam ali, nunca em data/bible_cache.
const dir = mkdtempSync(join(tmpdir(), "piano-bible-cache-test-"));
process.env.BIBLE_CACHE_DIR = dir;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
