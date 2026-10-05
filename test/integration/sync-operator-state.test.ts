import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// DB temporário dedicado ANTES de qualquer import (mesmo padrão sync-engine).
const tmpDir = mkdtempSync(join(tmpdir(), "plj-sync-op-"));
process.env.DB_PATH = join(tmpDir, "sync-op.db");

const { closeDb, initDb } = await import("../../src/db/connection.js");
const { OperatorStateSchema, runSync } = await import(
  "../../src/v1/custom/sync.service.js"
);
const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * sync v2 (app#336) — operator_state: LWW do estado do operador
 * (liturgia, agendados, palco, timer, prefs) numa tabela genérica com
 * namespace. Mesma semântica das coletâneas: client vence por
 * updated_at_ms; server vence devolve o estado na resposta.
 */
describe("operator_state (sync v2 LWW)", () => {
  let user: { id_user: number; token: string };
  const T0 = 1_700_000_000_000;

  beforeAll(() => {
    initDb();
    user = registerUser("sync-op@test.local", "S3nh@F0rte");
  });
  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cria estado do operador (created) e devolve na resposta", () => {
    const r = runSync(user.id_user, {
      collections: [],
      operator_state: [
        {
          client_uuid: "op-lit-0001",
          namespace: "liturgy",
          key: "week",
          value_json: '{"friday":[{"type":"music","name":"Hino 100"}]}',
          updated_at: T0,
        },
      ],
    });

    expect(r.applied.created).toBe(1);
    expect(r.operator_state).toHaveLength(1);
    expect(r.operator_state?.[0]).toMatchObject({
      client_uuid: "op-lit-0001",
      namespace: "liturgy",
      key: "week",
    });
  });

  it("client mais novo vence LWW (update)", () => {
    const r = runSync(user.id_user, {
      collections: [],
      operator_state: [
        {
          client_uuid: "op-lit-0001",
          namespace: "liturgy",
          key: "week",
          value_json: '{"friday":[{"type":"music","name":"Hino 101"}]}',
          updated_at: T0 + 5_000,
        },
      ],
    });
    expect(r.applied.updated).toBe(1);
    expect(r.operator_state?.[0].value_json).toContain("Hino 101");
  });

  it("server vence quando client está velho (conflict server_wins)", () => {
    const r = runSync(user.id_user, {
      collections: [],
      operator_state: [
        {
          client_uuid: "op-lit-0001",
          namespace: "liturgy",
          key: "week",
          value_json: '{"friday":"estado velho"}',
          updated_at: T0 + 1_000, // < T0+5000 do servidor
        },
      ],
    });
    expect(
      r.conflicts.find((c) => c.client_uuid === "op-lit-0001"),
    ).toMatchObject({ resolution: "server_wins" });
    // estado do servidor permanece o mais novo
    expect(r.operator_state?.[0].value_json).toContain("Hino 101");
  });

  it("tombstone aplica e remove do estado ativo", () => {
    const r = runSync(user.id_user, {
      collections: [],
      operator_state: [
        {
          client_uuid: "op-lit-0001",
          namespace: "liturgy",
          key: "week",
          value_json: "{}",
          updated_at: T0 + 10_000,
          deleted_at: T0 + 10_000,
        },
      ],
    });
    expect(r.operator_state ?? []).toHaveLength(0);
  });

  it("namespace inválido é rejeitado pelo schema", () => {
    const parsed = OperatorStateSchema.safeParse({
      client_uuid: "op-x-00000001",
      namespace: "hackado",
      key: "k",
      value_json: "{}",
      updated_at: T0,
    });
    expect(parsed.success).toBe(false);
  });
});
