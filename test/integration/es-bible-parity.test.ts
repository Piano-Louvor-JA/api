import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Paridade do catálogo bíblico ES com o mirror oficial (issue api#76).
 *
 * A migration 027_bible_es_catalog.sql é o espelho versionado de
 * api.louvorja.com.br/json_db/es_bible_{book,version}. Este teste valida o
 * contrato servido por /json_db/es_* em DB limpo (só migrations):
 *   - arrays não-vazios, 66 livros (ids 67..132) e 3 versões;
 *   - campos obrigatórios do espelho em todos os registros;
 *   - mesma ordem do mirror (book_number crescente);
 *   - idempotência da migration (roda 2x sem duplicar).
 */

const tmpDir = mkdtempSync(join(tmpdir(), "piano-es-parity-"));
const originalDbPath = process.env.DB_PATH;
process.env.DB_PATH = join(tmpDir, "test.db");
process.env.PORT = "0";

const { initDb, getDb, closeDb } = await import("../../src/db/connection.js");

let router: any;

beforeAll(async () => {
  await initDb();
  const { createApp } = await import("../../src/app.js");
  router = createApp();
});

afterAll(() => {
  closeDb();
  if (originalDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalDbPath;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("es_bible_* — paridade com o mirror oficial (api#76)", () => {
  it("es_bible_book serve catálogo ES completo (66 livros, ids 67..132)", async () => {
    const res = await router.request("/json_db/es_bible_book");
    expect(res.status).toBe(200);
    const books = await res.json();

    expect(Array.isArray(books)).toBe(true);
    expect(books).toHaveLength(66);

    const required = [
      "id_bible_book",
      "name",
      "abbreviation",
      "chapters",
      "book_number",
      "testament",
    ];
    for (const b of books) {
      for (const k of required)
        expect(b[k], `book ${b.id_bible_book} sem ${k}`).not.toBeNull();
    }

    // espelha o mirror: primeiro Génesis (id 67, livro 1), último Apocalipsis (id 132, livro 66)
    expect(books[0]).toMatchObject({
      id_bible_book: 67,
      book_number: 1,
      name: "Génesis",
      chapters: 50,
      testament: 1,
    });
    expect(books[65]).toMatchObject({
      id_bible_book: 132,
      book_number: 66,
      name: "Apocalipsis",
      chapters: 22,
      testament: 2,
    });

    // ordem crescente por book_number (contrato do mirror)
    const numbers = books.map((b: any) => b.book_number);
    expect([...numbers].sort((a: number, b: number) => a - b)).toEqual(numbers);

    // bloco ES não vaza ids PT
    expect(
      books.every((b: any) => b.id_bible_book >= 67 && b.id_bible_book <= 132),
    ).toBe(true);
  });

  it("es_bible_version serve as 3 versões ES (RV 10, RVA 11, SEV 12)", async () => {
    const res = await router.request("/json_db/es_bible_version");
    expect(res.status).toBe(200);
    const versions = await res.json();

    expect(Array.isArray(versions)).toBe(true);
    expect(versions).toHaveLength(3);

    const ids = versions.map((v: any) => String(v.id_bible_version)).sort();
    expect(ids).toEqual(["10", "11", "12"]);

    const rv = versions.find((v: any) => String(v.id_bible_version) === "10");
    expect(rv).toMatchObject({ name: "Reina-Valera", abbreviation: "RV" });
    const rva = versions.find((v: any) => String(v.id_bible_version) === "11");
    expect(rva).toMatchObject({
      name: "Reino-Valera 1989",
      abbreviation: "RVA",
    });
    const sev = versions.find((v: any) => String(v.id_bible_version) === "12");
    expect(sev).toMatchObject({
      name: "Las Sagradas Escrituras",
      abbreviation: "SEV",
    });

    // não vaza versão PT
    expect(versions.some((v: any) => v.name.includes("Almeida"))).toBe(false);
  });

  it("migration 027 é idempotente (reaplica sem duplicar)", async () => {
    const db = getDb();
    const sql = readFileSync(
      join(process.cwd(), "src/db/migrations/027_bible_es_catalog.sql"),
      "utf-8",
    );
    db.exec(sql); // segunda aplicação direta
    const books = db
      .prepare("SELECT COUNT(*) c FROM bible_books WHERE id_language='es'")
      .get() as any;
    const versions = db
      .prepare("SELECT COUNT(*) c FROM bible_versions WHERE language='es'")
      .get() as any;
    expect(books.c).toBe(66);
    expect(versions.c).toBe(3);
  });

  it("manifest /json_db lista os catálogos ES", async () => {
    const res = await router.request("/json_db");
    const manifest = await res.json();
    const files = manifest.map((m: any) => m.file);
    expect(files).toContain("es_bible_book.json");
    expect(files).toContain("es_bible_version.json");
  });
});
