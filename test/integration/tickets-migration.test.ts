// B1 Slice 1 — migration central de tickets: tabelas, seed ndaad, audit append-only, replay idempotente
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../../src/db/connection.js";

describe("migration 028 — central de tickets", () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ":memory:";
    initDb();
  });

  it("cria todas as tabelas de domínio", () => {
    const db = getDb();
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of [
      "tenants",
      "tenant_memberships",
      "tickets",
      "ticket_messages",
      "triage_requests",
      "knowledge_sources",
      "automation_policies",
      "automation_runs",
      "audit_events",
    ]) {
      expect(tables, `tabela ${t} deve existir`).toContain(t);
    }
  });

  it("seed ndaad existe com automação desligada", () => {
    const db = getDb();
    const tenant = db
      .prepare("SELECT * FROM tenants WHERE id = 'ndaad'")
      .get() as
      | {
          id: string;
          automation_opt_in: number;
          automation_kill_switch: number;
        }
      | undefined;
    expect(tenant).toBeDefined();
    expect(tenant!.automation_opt_in).toBe(0);
    expect(tenant!.automation_kill_switch).toBe(0);
    // Sem UID/admin inventado
    const admins = db
      .prepare(
        "SELECT COUNT(*) as c FROM tenant_memberships WHERE tenant_id = 'ndaad'",
      )
      .get() as { c: number };
    expect(admins.c).toBe(0);
  });

  it("ticket de tenant A não é visível por consulta escopada ao tenant B (isolamento por predicado)", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO tenants (id, name) VALUES ('a', 'Tenant A'), ('b', 'Tenant B')",
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, tenant_id, source, status, priority, subject, description, requester_ref, created_by)
       VALUES ('t1', 'a', 'portal', 'new', 'P3', 's', 'd', 'req-1', 'user-1')`,
    ).run();
    const fromB = db
      .prepare("SELECT * FROM tickets WHERE id = 't1' AND tenant_id = 'b'")
      .get();
    expect(fromB).toBeUndefined();
  });

  it("audit_events é append-only (trigger bloqueia UPDATE e DELETE)", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO audit_events (tenant_id, actor, action, target)
       VALUES ('ndaad', 'svc', 'test.action', 'x')`,
    ).run();
    expect(() =>
      db
        .prepare(
          "UPDATE audit_events SET action = 'tampered' WHERE action = 'test.action'",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db.prepare("DELETE FROM audit_events WHERE action = 'test.action'").run(),
    ).toThrow();
  });

  it("initDb replay é idempotente em banco persistente (roda 2x sem erro e mantém dados)", () => {
    // :memory: recria o banco a cada init — replay com retenção exige arquivo
    const tmpDb = join(tmpdir(), `tickets-replay-${randomUUID()}.db`);
    closeDb();
    process.env.DB_PATH = tmpDb;
    initDb();
    getDb().prepare("INSERT INTO tenants (id, name) VALUES ('z', 'Z')").run();
    expect(() => initDb()).not.toThrow();
    const db2 = getDb();
    const count = db2.prepare("SELECT COUNT(*) as c FROM tenants").get() as {
      c: number;
    };
    expect(count.c).toBe(6); // seeds 027 (piano/classic/flute/violin) + ndaad + z
    expect(
      db2.prepare("SELECT COUNT(*) as c FROM tenants WHERE id = 'z'").get(),
    ).toEqual({ c: 1 });
    closeDb();
    rmSync(tmpDb, { force: true });
    process.env.DB_PATH = ":memory:";
  });
});
