import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  DELETED_ACCOUNT_EMAIL,
  getDeletedAccountUserId,
  hasLocalPassword,
} from "../../src/v1/custom/account-deletion.service.js";

/** Banco sem a migration 034: o serviço recria o usuário "Conta excluída". */
function bareDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE custom_users (
    id_user INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT
  )`);
  return db;
}

describe("account-deletion.service", () => {
  it("cria a conta-sistema quando falta e reutiliza depois", () => {
    const db = bareDb();
    const first = getDeletedAccountUserId(db);
    expect(first).toBeGreaterThan(0);
    const row = db
      .prepare(
        `SELECT email, password_hash, display_name FROM custom_users WHERE id_user = ?`,
      )
      .get(first) as {
      email: string;
      password_hash: string;
      display_name: string;
    };
    expect(row).toEqual({
      email: DELETED_ACCOUNT_EMAIL,
      password_hash: "disabled$deleted-account",
      display_name: "Conta excluída",
    });
    expect(hasLocalPassword(row.password_hash)).toBe(false);
    expect(getDeletedAccountUserId(db)).toBe(first);
    db.close();
  });

  it("hasLocalPassword só aceita hash pbkdf2", () => {
    expect(hasLocalPassword("pbkdf2$100$salt$hash")).toBe(true);
    expect(hasLocalPassword("firebase$no-local-password")).toBe(false);
  });
});
