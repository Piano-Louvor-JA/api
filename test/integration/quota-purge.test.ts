import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmpDir = mkdtempSync(join(tmpdir(), "plj-quota-"));
process.env.DB_PATH = join(tmpDir, "quota.db");

const { initDb, closeDb, getDb } = await import("../../src/db/connection.js");
const { purgeTombstones, quotaCheck, usedBytes, getQuotaBytes } = await import(
  "../../src/v1/custom/quota.service.js"
);

/** seed mínimo: user + coletânea + música com N arquivos somando bytes */
function seedUserMusic(
  email: string,
  fileBytes: number[],
  opts?: { tombstoned?: boolean },
) {
  const db = getDb();
  const u = db
    .prepare(
      "INSERT INTO custom_users (email, password_hash, display_name) VALUES (?, 'x', 't')",
    )
    .run(email);
  const uid = Number(u.lastInsertRowid);
  const c = db
    .prepare("INSERT INTO custom_collections (name, owner_id) VALUES ('qc', ?)")
    .run(uid);
  const cid = Number(c.lastInsertRowid);
  const fileIds: number[] = [];
  for (const bytes of fileBytes) {
    const f = db
      .prepare(
        "INSERT INTO files (name, path, type, url, size) VALUES ('f', '/x/' || ? || '/' || ?, 'image', '/x/' || ? || '/' || ?, ?)",
      )
      .run(String(uid), String(bytes), String(uid), String(bytes), bytes);
    fileIds.push(Number(f.lastInsertRowid));
  }
  const m = db
    .prepare(
      `INSERT INTO custom_musics (id_collection, name, owner_id, id_file_audio, id_file_image, deleted_at, updated_at_ms)
       VALUES (?, 'm', ?, ?, ?, ?, ?)`,
    )
    .run(
      cid,
      uid,
      fileIds[0] ?? null,
      fileIds[1] ?? null,
      opts?.tombstoned ? Date.now() - 31 * 24 * 3600 * 1000 : null,
      Date.now(),
    );
  return { uid, cid, mid: Number(m.lastInsertRowid), fileIds };
}

describe("quota + purge (B5, B7, B12)", () => {
  beforeAll(() => initDb());
  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("B12: quota soma só arquivos de músicas vivas; tombstone não conta", () => {
    const { uid } = seedUserMusic("q1@test.local", [1024, 2048]);
    expect(usedBytes(uid)).toBe(3072);
    // música tombstoned com 5MB → não soma
    seedUserMusic("q1b@test.local", [5 * 1024 * 1024], { tombstoned: true });
    expect(usedBytes(uid)).toBe(3072);
  });

  it("B7: estourou 100MB → ok=false com mensagem clara", () => {
    const { uid } = seedUserMusic("q2@test.local", [99 * 1024 * 1024]);
    const q = quotaCheck(uid, 2 * 1024 * 1024);
    expect(q.ok).toBe(false);
    expect(q.message).toContain("Cota");
    expect(q.quota).toBe(getQuotaBytes());
  });

  it("B7: dentro da cota → ok=true", () => {
    const { uid } = seedUserMusic("q3@test.local", [1024]);
    expect(quotaCheck(uid, 1024).ok).toBe(true);
  });

  it("B5: purge remove tombstone >30d e mantém <30d", () => {
    const old = seedUserMusic("p1@test.local", [100], { tombstoned: true });
    const fresh = seedUserMusic("p2@test.local", [100], { tombstoned: true });
    // fresh vira tombstone recente
    getDb()
      .prepare("UPDATE custom_musics SET deleted_at = ? WHERE id_music = ?")
      .run(Date.now() - 1000, fresh.mid);

    const r = purgeTombstones(30);
    expect(r.musics).toBeGreaterThanOrEqual(1);

    const db = getDb();
    expect(
      db
        .prepare("SELECT count(*) c FROM custom_musics WHERE id_music = ?")
        .get(old.mid),
    ).toMatchObject({ c: 0 });
    // tombstone recente permanece (B5: purge só após 30 dias)
    expect(
      db
        .prepare("SELECT count(*) c FROM custom_musics WHERE id_music = ?")
        .get(fresh.mid),
    ).toMatchObject({ c: 1 });
  });
});
