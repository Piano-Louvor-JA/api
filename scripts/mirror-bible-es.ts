/**
 * Espelhamento dos catálogos da Bíblia em espanhol (es_bible_book /
 * es_bible_version) a partir do mirror oficial (api.louvorja.com.br).
 *
 * O que faz (idempotente, pode rodar quantas vezes quiser):
 *   1. Baixa /json_db/es_bible_book e /json_db/es_bible_version do upstream;
 *   2. Valida: JSON array válido, campos obrigatórios presentes, ids únicos,
 *      livros dentro do range ES (67..132), versões com language_code 'es'
 *      inferido pelo prefixo do endpoint;
 *   3. Gera src/db/migrations/027_bible_es_catalog.sql (INSERT OR IGNORE,
 *      idempotente) — caminho canônico: migrations rodam no boot da API e
 *      no import-upstream, então o catálogo chega ao DB de produção
 *      automaticamente no próximo deploy;
 *   4. Salva snapshot versionado em data/json_db/es_bible_{book,version}.json
 *      + data/json_db/es_bible_catalog.sha256 (checksums) para auditoria.
 *
 * Uso:  npx tsx scripts/mirror-bible-es.ts
 * Env:  UPSTREAM_API (default https://api.louvorja.com.br)
 *
 * Falha alto (exit 1) se qualquer validação quebrar — nunca commita dados
 * inválidos. Diff do arquivo gerado vazio = mirror sem mudanças.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const UPSTREAM = process.env.UPSTREAM_API ?? "https://api.louvorja.com.br";
const ROOT = join(dirname(import.meta.url.replace(/^file:\/\//, "")), "..");
const MIGRATION_PATH = join(ROOT, "src/db/migrations/027_bible_es_catalog.sql");
const SNAPSHOT_DIR = join(ROOT, "data/json_db");

const ES_BOOK_ID_MIN = 67;
const ES_BOOK_ID_MAX = 132;

interface EsBook {
  id_bible_book: number;
  name: string;
  abbreviation: string;
  chapters: number;
  book_number: number;
  testament: number;
  keywords?: string | null;
  color?: string | null;
}

interface EsVersion {
  id_bible_version: number;
  name: string;
  abbreviation: string;
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function fetchJson(path: string): Promise<unknown> {
  const url = `${UPSTREAM}${path}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  FAIL HTTP ${res.status}: ${url}`);
        return null;
      }
      return await res.json();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }
  return null;
}

function sqlStr(value: unknown): string {
  if (value == null) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNum(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "NULL";
}

function validateBooks(books: unknown[]): asserts books is EsBook[] {
  if (!Array.isArray(books) || books.length === 0)
    fail("es_bible_book: não é um array não-vazio");
  const required = [
    "id_bible_book",
    "name",
    "abbreviation",
    "chapters",
    "book_number",
    "testament",
  ];
  const seen = new Set<number>();
  for (const [i, b] of books.entries()) {
    for (const k of required) {
      if (b?.[k] == null)
        fail(`es_bible_book[${i}]: campo obrigatório '${k}' ausente`);
    }
    const id = Number(b.id_bible_book);
    if (id < ES_BOOK_ID_MIN || id > ES_BOOK_ID_MAX)
      fail(
        `es_bible_book[${i}]: id ${id} fora do range ES (${ES_BOOK_ID_MIN}..${ES_BOOK_ID_MAX})`,
      );
    if (seen.has(id)) fail(`es_bible_book: id duplicado ${id}`);
    seen.add(id);
    if (typeof b.name !== "string" || b.name.trim() === "")
      fail(`es_bible_book[${i}]: name vazio`);
    const abbr = String(b.abbreviation ?? "");
    if (abbr.trim() === "") fail(`es_bible_book[${i}]: abbreviation vazia`);
  }
}

function validateVersions(
  versions: unknown[],
): asserts versions is EsVersion[] {
  if (!Array.isArray(versions) || versions.length === 0)
    fail("es_bible_version: não é um array não-vazio");
  const seen = new Set<number>();
  for (const [i, v] of versions.entries()) {
    for (const k of ["id_bible_version", "name", "abbreviation"]) {
      if (v?.[k] == null)
        fail(`es_bible_version[${i}]: campo obrigatório '${k}' ausente`);
    }
    const id = Number(v.id_bible_version);
    if (seen.has(id)) fail(`es_bible_version: id duplicado ${id}`);
    seen.add(id);
  }
}

function generateMigration(books: EsBook[], versions: EsVersion[]): string {
  const lines: string[] = [];
  lines.push("-- 027_bible_es_catalog.sql");
  lines.push("-- Catálogo da Bíblia em espanhol espelhado do mirror oficial");
  lines.push("-- (api.louvorja.com.br) — issue Piano-louvor-JA/api#76.");
  lines.push("-- Gerado por scripts/mirror-bible-es.ts — NÃO editar à mão;");
  lines.push("-- regenere com: npx tsx scripts/mirror-bible-es.ts");
  lines.push("-- Idempotente (INSERT OR IGNORE). Livros ES = ids 67..132;");
  lines.push("-- versões ES = 10 (RV), 11 (RVA), 12 (SEV), language='es'.");
  lines.push("");
  lines.push(
    "INSERT OR IGNORE INTO languages (id_language, name) VALUES ('es', 'Espanhol');",
  );
  lines.push("");
  lines.push("-- Versões (bible_versions.id_version é TEXT: '10' != 10 do PT)");
  lines.push(
    `INSERT OR IGNORE INTO bible_versions (id_version, name, language, abbreviation) VALUES\n${versions
      .map(
        (v) =>
          `  (${sqlNum(v.id_bible_version)}, ${sqlStr(v.name)}, 'es', ${sqlStr(v.abbreviation)})`,
      )
      .join(",\n")};`,
  );
  lines.push("");
  lines.push("-- Livros (ids 67..132 = bloco ES do ecossistema LouvorJA)");
  lines.push(
    "INSERT OR IGNORE INTO bible_books (id_book, name, abbreviation, chapters, book_number, id_language, testament, keywords, color) VALUES",
  );
  lines.push(
    `${books
      .map(
        (b) =>
          `  (${sqlNum(b.id_bible_book)}, ${sqlStr(b.name)}, ${sqlStr(b.abbreviation)}, ${sqlNum(b.chapters)}, ${sqlNum(b.book_number)}, 'es', ${sqlNum(b.testament)}, ${sqlStr(b.keywords)}, ${sqlStr(b.color)})`,
      )
      .join(",\n")};`,
  );
  lines.push("");
  return lines.join("\n");
}

async function main() {
  console.log(`Espelhando catálogo bíblico ES de ${UPSTREAM}`);
  console.log("");

  // 1. Download
  const [booksRaw, versionsRaw] = await Promise.all([
    fetchJson("/json_db/es_bible_book"),
    fetchJson("/json_db/es_bible_version"),
  ]);
  if (booksRaw == null) fail("download de es_bible_book falhou");
  if (versionsRaw == null) fail("download de es_bible_version falhou");

  // 2. Validação
  validateBooks(booksRaw);
  validateVersions(versionsRaw);
  const books = [...booksRaw].sort((a, b) => a.id_bible_book - b.id_bible_book);
  const versions = [...versionsRaw].sort(
    (a, b) => a.id_bible_version - b.id_bible_version,
  );
  console.log(
    `✓ es_bible_book: ${books.length} livros (ids ${books[0].id_bible_book}..${books[-1 + books.length].id_bible_book})`,
  );
  console.log(
    `✓ es_bible_version: ${versions.length} versões (${versions.map((v) => v.abbreviation).join(", ")})`,
  );

  // 3. Migration canônica
  const migration = generateMigration(books, versions);
  const changed =
    !existsSync(MIGRATION_PATH) ||
    readFileSync(MIGRATION_PATH, "utf-8") !== migration;
  writeFileSync(MIGRATION_PATH, migration, "utf-8");
  console.log(
    changed
      ? `✓ migration escrita: src/db/migrations/027_bible_es_catalog.sql (${books.length + versions.length} inserts)`
      : "= migration já estava em dia (nenhuma mudança)",
  );

  // 4. Snapshots versionados + checksums
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const bookJson = `${JSON.stringify(books)}\n`;
  const versionJson = `${JSON.stringify(versions)}\n`;
  writeFileSync(join(SNAPSHOT_DIR, "es_bible_book.json"), bookJson, "utf-8");
  writeFileSync(
    join(SNAPSHOT_DIR, "es_bible_version.json"),
    versionJson,
    "utf-8",
  );
  const sha = (s: string) =>
    createHash("sha256").update(s, "utf-8").digest("hex");
  const checksums = [
    `${sha(bookJson)}  es_bible_book.json`,
    `${sha(versionJson)}  es_bible_version.json`,
    "",
  ].join("\n");
  writeFileSync(
    join(SNAPSHOT_DIR, "es_bible_catalog.sha256"),
    checksums,
    "utf-8",
  );
  console.log(
    "✓ snapshots + checksums: data/json_db/es_bible_{book,version}.json + .sha256",
  );

  console.log("");
  console.log("Concluído. A migration aplica o catálogo no boot da API e no");
  console.log(
    "import-upstream; os snapshots em data/json_db ficam como auditoria.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
