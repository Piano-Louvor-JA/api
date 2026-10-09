import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, initDb } from "../../src/db/connection.js";

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
});

describe("Database initialization remains repeatable", () => {
  it("creates missing parent directories and reopens the connection without losing data", () => {
    const dir = mkdtempSync(join(tmpdir(), "api-db-init-"));
    const path = join(dir, "nested", "catalog.db");
    vi.stubEnv("DB_PATH", path);
    try {
      initDb();
      expect(existsSync(path)).toBe(true);
      getDb()
        .prepare(
          "INSERT INTO languages (id_language, name) VALUES ('test-init', 'Test')",
        )
        .run();
      initDb();
      expect(
        getDb()
          .prepare("SELECT name FROM languages WHERE id_language = 'test-init'")
          .get(),
      ).toEqual({ name: "Test" });
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
