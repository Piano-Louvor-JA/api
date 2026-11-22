/**
 * central-tickets B1 — REVERSÃO: migration down remove todos os objetos 036
 * e o schema anterior permanece intacto (tabelas core fora do módulo tickets).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { getDb, initDb } from "../../src/db/connection.js";

const TABLES_036 = [
  "tickets_tenants",
  "tickets_memberships",
  "tickets",
  "tickets_messages",
  "tickets_intake",
  "tickets_kb_articles",
  "tickets_ai_policies",
  "tickets_automation",
  "tickets_audit",
  "tickets_sla_policy",
];

function tableExists(name: string): boolean {
  return (
    getDb()
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) !== undefined
  );
}

function downSqlPath(): string {
  const candidates = [
    join(
      __dirname,
      "../../src/db/migrations/036_tickets_multicompany.down.sql",
    ),
    join(process.cwd(), "src/db/migrations/036_tickets_multicompany.down.sql"),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c);
      return c;
    } catch {
      /* tenta próximo */
    }
  }
  throw new Error("down.sql não encontrado");
}

beforeAll(() => {
  process.env.DB_PATH ??= ":memory:";
  initDb();
});

describe("reversão migration 036", () => {
  it("schema 036 aplicado tem as tabelas do módulo", () => {
    for (const t of TABLES_036) expect(tableExists(t)).toBe(true);
  });

  it("down.sql remove todas as tabelas tickets_*", () => {
    getDb().exec(readFileSync(downSqlPath(), "utf-8"));
    for (const t of TABLES_036) expect(tableExists(t)).toBe(false);
  });

  it("tabelas core da API fora do módulo permanecem", () => {
    // sanity: módulo tickets não pode derrubar schema alheio
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    // 036 é aditivo; algo fora de tickets_* precisa existir (ex: migrations de 001+)
    expect(
      names.some((n) => !n.startsWith("tickets_") && n !== "sqlite_sequence"),
    ).toBe(true);
  });
});
