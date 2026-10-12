import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readdirSync: () => ["test.sql"],
  readFileSync: () => ";\nCREATE TABLE boundary (id INTEGER);",
}));

import { closeDb, getDb, initDb } from "../../src/db/connection.js";

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it("migrations ignoram instrução vazia sem deixar de criar a tabela", () => {
  vi.stubEnv("DB_PATH", ":memory:");
  initDb();
  expect(
    getDb()
      .prepare("SELECT name FROM sqlite_master WHERE name='boundary'")
      .get(),
  ).toEqual({ name: "boundary" });
});
it("falha não Error na execução não é engolida", () => {
  vi.stubEnv("DB_PATH", ":memory:");
  vi.spyOn(Database.prototype, "exec").mockImplementation(() => {
    throw "migration-failure";
  });
  expect(() => initDb()).toThrow("migration-failure");
});
