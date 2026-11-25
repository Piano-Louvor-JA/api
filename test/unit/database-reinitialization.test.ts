import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeDb, getDb, initDb } from "../../src/db/connection.js";

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
});
it("reinicializar fecha a conexão anterior e mantém migrations válidas", () => {
  vi.stubEnv("DB_PATH", ":memory:");
  initDb();
  const first = getDb();
  expect(first.open).toBe(true);
  initDb();
  expect(first.open).toBe(false);
  const second = getDb();
  expect(second.open).toBe(true);
  expect(second).not.toBe(first);
  expect(
    second
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name='custom_users'",
      )
      .get(),
  ).toEqual({ total: 1 });
});

it("inicialização cria diretório pai ausente e abre banco persistente", () => {
  const root = mkdtempSync(join(tmpdir(), "api-db-parent-"));
  const path = join(root, "nested", "catalog.db");
  try {
    vi.stubEnv("DB_PATH", path);
    expect(existsSync(join(root, "nested"))).toBe(false);
    initDb();
    expect(existsSync(path)).toBe(true);
    expect(getDb().pragma("journal_mode", { simple: true })).toBe("wal");
  } finally {
    closeDb();
    rmSync(root, { recursive: true, force: true });
  }
});
