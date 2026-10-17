import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import { resolveBibleCacheDir } from "../../lib/bibleCacheDir.js";
import {
  resolveVersionAbbreviation,
  sanitizeBibleChapter,
} from "../../routes/compat.js";

/**
 * Bundles da Bíblia (versão inteira num único JSON) para o cliente guardar
 * offline. Montados a partir do mesmo cache de capítulos do proxy
 * `/json_db/bible_{v}_{b}_{c}` — nunca chamam o upstream.
 *
 * Contrato do sha256: hash dos bytes do JSON descompactado servido. O
 * cliente confere o que baixou sem precisar reserializar.
 */

export const BIBLE_BUNDLE_SCHEMA = 1;
const DEFAULT_REVALIDATE_MS = 60_000;
const MISSING_SAMPLE_SIZE = 10;

type Db = Database.Database;

type VersionRow = {
  id_version: string;
  name: string;
  language: string;
  abbreviation: string | null;
};

type BookRow = { id_book: number; chapters: number };

type ChapterVerses = Record<string, string>;

type BuiltBundle = {
  signature: string;
  checkedAt: number;
  gzip: Buffer | null;
  sha256: string | null;
  bytes: number | null;
  missing: string[];
  books: number;
  chapters: number;
  updatedAt: string | null;
};

export type BibleBundleManifestEntry = {
  versionId: number;
  language: string;
  name: string;
  abbreviation: string;
  books: number;
  chapters: number;
  complete: boolean;
  missing: number;
  sha256: string | null;
  bytes: number | null;
  gzipBytes: number | null;
  updatedAt: string | null;
};

export type BibleBundleResult =
  | { status: "not_found" }
  | { status: "incomplete"; missing: number; sample: string[] }
  | { status: "ok"; gzip: Buffer; sha256: string; bytes: number };

const cache = new Map<number, BuiltBundle>();

function revalidateMs(): number {
  const raw = Number(process.env.BIBLE_BUNDLE_REVALIDATE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_REVALIDATE_MS;
}

function listVersionRows(db: Db): VersionRow[] {
  return (
    db
      .prepare(
        "SELECT id_version, name, language, abbreviation FROM bible_versions",
      )
      .all() as VersionRow[]
  )
    .filter((row) => /^\d+$/.test(String(row.id_version)))
    .sort(
      (a, b) =>
        a.language.localeCompare(b.language) ||
        Number(a.id_version) - Number(b.id_version),
    );
}

function findVersionRow(db: Db, versionId: number): VersionRow | null {
  return (
    listVersionRows(db).find((row) => Number(row.id_version) === versionId) ??
    null
  );
}

function listBooks(db: Db, language: string): BookRow[] {
  return db
    .prepare(
      "SELECT id_book, chapters FROM bible_books WHERE id_language = ? ORDER BY book_number, id_book",
    )
    .all(language) as BookRow[];
}

function chapterKeys(versionId: number, books: BookRow[]) {
  const keys: Array<{ key: string; book: number; chapter: number }> = [];
  for (const book of books) {
    const total = Number(book.chapters) || 0;
    for (let chapter = 1; chapter <= total; chapter += 1) {
      keys.push({
        key: `bible_${versionId}_${book.id_book}_${chapter}`,
        book: Number(book.id_book),
        chapter,
      });
    }
  }
  return keys;
}

/** Assinatura barata (stat) do conjunto de arquivos: muda quando o cache muda. */
function cacheSignature(dir: string, keys: Array<{ key: string }>) {
  const hash = createHash("sha1");
  let latest = 0;
  for (const { key } of keys) {
    try {
      const info = statSync(join(dir, `${key}.json`));
      hash.update(`${key}:${info.size}:${info.mtimeMs};`);
      latest = Math.max(latest, info.mtimeMs);
    } catch {
      hash.update(`${key}:-;`);
    }
  }
  return { signature: hash.digest("hex"), latest };
}

function readChapter(dir: string, key: string): ChapterVerses | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, `${key}.json`), "utf-8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const verses = sanitizeBibleChapter(parsed as ChapterVerses);
    return Object.keys(verses).length > 0 ? verses : null;
  } catch {
    return null;
  }
}

function build(db: Db, row: VersionRow): BuiltBundle {
  const versionId = Number(row.id_version);
  const now = Date.now();
  const cached = cache.get(versionId);
  if (cached && now - cached.checkedAt < revalidateMs()) return cached;

  const dir = resolveBibleCacheDir();
  const books = listBooks(db, row.language);
  const keys = chapterKeys(versionId, books);
  const { signature, latest } = cacheSignature(dir, keys);
  if (cached && cached.signature === signature) {
    cached.checkedAt = now;
    return cached;
  }

  const chapters: Record<string, Record<string, ChapterVerses>> = {};
  const missing: string[] = [];
  for (const { key, book, chapter } of keys) {
    const verses = readChapter(dir, key);
    if (!verses) {
      missing.push(key);
      continue;
    }
    chapters[book] ??= {};
    chapters[book][chapter] = verses;
  }

  const base = {
    signature,
    checkedAt: now,
    missing,
    books: books.length,
    chapters: keys.length,
    updatedAt: latest > 0 ? new Date(latest).toISOString() : null,
  };

  if (keys.length === 0 || missing.length > 0) {
    const result = { ...base, gzip: null, sha256: null, bytes: null };
    cache.set(versionId, result);
    return result;
  }

  const json = Buffer.from(
    JSON.stringify({
      schema: BIBLE_BUNDLE_SCHEMA,
      versionId,
      language: row.language,
      name: row.name,
      abbreviation: resolveVersionAbbreviation(
        row.abbreviation,
        row.name,
        row.id_version,
      ),
      chapters,
    }),
    "utf-8",
  );
  const result = {
    ...base,
    gzip: gzipSync(json, { level: 9 }),
    sha256: createHash("sha256").update(json).digest("hex"),
    bytes: json.length,
  };
  cache.set(versionId, result);
  return result;
}

export function getBibleBundleManifest(db: Db): BibleBundleManifestEntry[] {
  return listVersionRows(db).map((row) => {
    const built = build(db, row);
    return {
      versionId: Number(row.id_version),
      language: row.language,
      name: row.name,
      abbreviation: resolveVersionAbbreviation(
        row.abbreviation,
        row.name,
        row.id_version,
      ),
      books: built.books,
      chapters: built.chapters,
      complete: built.sha256 != null,
      missing: built.missing.length,
      sha256: built.sha256,
      bytes: built.bytes,
      gzipBytes: built.gzip?.length ?? null,
      updatedAt: built.updatedAt,
    };
  });
}

export function getBibleBundle(db: Db, versionId: number): BibleBundleResult {
  const row = findVersionRow(db, versionId);
  if (!row) return { status: "not_found" };

  const built = build(db, row);
  if (!built.gzip || !built.sha256 || built.bytes == null) {
    if (built.chapters === 0) return { status: "not_found" };
    return {
      status: "incomplete",
      missing: built.missing.length,
      sample: built.missing.slice(0, MISSING_SAMPLE_SIZE),
    };
  }
  return {
    status: "ok",
    gzip: built.gzip,
    sha256: built.sha256,
    bytes: built.bytes,
  };
}

/** Só para testes: esquece bundles montados. */
export function _resetBibleBundleCacheForTest(): void {
  cache.clear();
}
