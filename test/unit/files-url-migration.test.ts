import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

const schema = readFileSync(
  new URL("../../src/db/migrations/002_files.sql", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../../src/db/migrations/029_files_url_unique.sql", import.meta.url),
  "utf8",
);

it("applies twice and preserves NULL URLs and existing references", () => {
  const db = new Database(":memory:");
  try {
    db.exec(schema);
    db.exec(
      "INSERT INTO files (id_file, url) VALUES (1, '/a'), (2, NULL), (3, NULL)",
    );
    db.exec(migration);
    db.exec(migration);
    expect(
      db.prepare("SELECT id_file FROM files ORDER BY id_file").all(),
    ).toEqual([{ id_file: 1 }, { id_file: 2 }, { id_file: 3 }]);
    expect(() =>
      db.prepare("INSERT INTO files (url) VALUES (?)").run("/a"),
    ).toThrow(/UNIQUE/);
  } finally {
    db.close();
  }
});

it("blocks duplicate URLs without deleting records or changing references", () => {
  const db = new Database(":memory:");
  try {
    db.exec(schema);
    db.exec("INSERT INTO files (id_file, url) VALUES (1, '/a'), (2, '/a')");
    db.exec(
      "CREATE TABLE refs (file_id INTEGER REFERENCES files(id_file)); INSERT INTO refs VALUES (2)",
    );
    expect(() => db.exec(migration)).toThrow(/UNIQUE/);
    expect(
      db.prepare("SELECT id_file FROM files ORDER BY id_file").all(),
    ).toEqual([{ id_file: 1 }, { id_file: 2 }]);
    expect(db.prepare("SELECT file_id FROM refs").get()).toEqual({
      file_id: 2,
    });
  } finally {
    db.close();
  }
});
