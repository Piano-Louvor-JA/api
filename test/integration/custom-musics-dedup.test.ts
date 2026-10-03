import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupSeededDb, type SeededDb } from "../helpers/seeded-db";

/**
 * app#336 fase 3 — dedup de imports na API (migration 028):
 * unique index parcial (owner_id, client_uuid) em custom_musics:
 * - mesmo dono + mesmo client_uuid → UNIQUE violation (a rota dedupeia
 *   ANTES do INSERT, retornando o registro existente)
 * - donos diferentes com o mesmo uuid → coexistem (cada um tem sua cópia)
 * - client_uuid NULL (legacy) → não participa do índice
 */

describe("dedup de custom_musics por (owner_id, client_uuid)", () => {
  let db: SeededDb;

  beforeAll(async () => {
    db = await setupSeededDb();
  });

  afterAll(() => {
    db.cleanup();
  });

  function insertMusic(ownerId: number, clientUuid: string | null): number {
    const now = Date.now();
    const coll = Number(
      db
        .getDb()
        .prepare(
          `INSERT INTO custom_collections (name, owner_id, created_at, updated_at)
           VALUES ('Importações .slja', ?, ?, ?)`,
        )
        .run(ownerId, now, now).lastInsertRowid,
    );
    return Number(
      db
        .getDb()
        .prepare(
          `INSERT INTO custom_musics (id_collection, owner_id, name, client_uuid, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(coll, ownerId, "Hino Teste", clientUuid, now, now).lastInsertRowid,
    );
  }

  it("mesmo dono + mesmo client_uuid → UNIQUE violation (dedup ativo)", () => {
    const uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    insertMusic(42, uuid);
    expect(() => insertMusic(42, uuid)).toThrow(/UNIQUE/);
  });

  it("donos diferentes com o mesmo client_uuid coexistem", () => {
    const uuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const id1 = insertMusic(42, uuid);
    const id2 = insertMusic(43, uuid);
    expect(id1).not.toBe(id2);
  });

  it("client_uuid NULL (legacy) não participa do índice", () => {
    const id1 = insertMusic(42, null);
    const id2 = insertMusic(42, null);
    expect(id1).not.toBe(id2);
  });
});
