/**
 * Cobertura de 100% para B13 — sync.service.ts (auth middleware, backfill
 * uuid legado, caminhos LWW: forbidden / server-wins / delete / lyrics).
 * DB temporário por arquivo (isola do data/catalog.db).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmpDir = mkdtempSync(join(tmpdir(), "plj-sync-cov-"));
process.env.DB_PATH = join(tmpDir, "sync.db");

import type { Context, Next } from "hono";
import { closeDb, getDb, initDb } from "../../src/db/connection.js";
import { hashPassword, hashToken } from "../../src/v1/custom/auth.service.js";
import { requireSyncAuth, runSync } from "../../src/v1/custom/sync.service.js";

let userIdA = 0;
let userIdB = 0;
let tokenA = "";
let tokenB = "";

function seedUser(email: string): { id: number; token: string } {
  const db = getDb();
  const r = db
    .prepare(
      `INSERT INTO custom_users (email, password_hash, display_name) VALUES (?, ?, ?)`,
    )
    .run(email, hashPassword("senha123"), email);
  const id = Number(r.lastInsertRowid);
  const token = `tok-${email}`;
  db.prepare(
    `INSERT INTO custom_sessions (id_user, token_hash, created_at) VALUES (?, ?, ?)`,
  ).run(id, hashToken(token), Date.now());
  return { id, token };
}

function seedCollection(owner: number, uuid: string, updated = 1000) {
  const db = getDb();
  const r = db
    .prepare(
      `INSERT INTO custom_collections (name, owner_id, client_uuid, updated_at_ms)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`col-${uuid}`, owner, uuid, updated);
  return Number(r.lastInsertRowid);
}

function seedMusic(colId: number, owner: number, uuid: string, updated = 1000) {
  const db = getDb();
  const r = db
    .prepare(
      `INSERT INTO custom_musics (id_collection, name, owner_id, client_uuid, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(colId, `mus-${uuid}`, owner, uuid, updated);
  return Number(r.lastInsertRowid);
}

// helper: roda o middleware requireSyncAuth contra um Context fake
async function runMiddleware(authHeader?: string): Promise<number | undefined> {
  let userId: number | undefined;
  const c = {
    req: {
      header: (k: string) => (k === "authorization" ? authHeader : undefined),
    },
    set: (k: string, v: unknown) => {
      if (k === "user") userId = (v as { id_user: number }).id_user;
    },
    json: (body: unknown, status: number) => ({ body, status }),
  } as unknown as Context;
  const next: Next = async () => {};
  await requireSyncAuth(c, next);
  return userId;
}

beforeAll(() => {
  initDb();
  const a = seedUser("cov-a@test.local");
  const b = seedUser("cov-b@test.local");
  userIdA = a.id;
  userIdB = b.id;
  tokenA = a.token;
  tokenB = b.token;
});

afterAll(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("requireSyncAuth (L102-121)", () => {
  it("401 sem header Authorization", async () => {
    const r = await runMiddleware(undefined);
    expect(r).toBeUndefined();
  });

  it("401 sem Bearer", async () => {
    const r = await runMiddleware("Basic abc");
    expect(r).toBeUndefined();
  });

  it("401 token desconhecido", async () => {
    const r = await runMiddleware("Bearer inexistente");
    expect(r).toBeUndefined();
  });

  it("autentica e injeta user", async () => {
    const r = await runMiddleware(`Bearer ${tokenA}`);
    expect(r).toBe(userIdA);
  });
});

describe("legado sem client_uuid aparece no sync (sem backfill)", () => {
  it("coletânea legado NULL uuid aparece no server_state com uuid null", () => {
    const db = getDb();
    const r = db
      .prepare(
        `INSERT INTO custom_collections (name, owner_id, client_uuid, updated_at_ms)
         VALUES (?, ?, NULL, ?)`,
      )
      .run("legacy", userIdA, 500);
    const idCol = Number(r.lastInsertRowid);

    const res = runSync(userIdA, {
      last_sync_at: 0,
      collections: [],
    });
    const row = db
      .prepare(
        `SELECT client_uuid FROM custom_collections WHERE id_collection = ?`,
      )
      .get(idCol) as { client_uuid: string | null };
    expect(row.client_uuid).toBeNull(); // sem backfill automático
    const found = res.collections.find((c) => c.id_collection === idCol);
    expect(found?.client_uuid).toBeNull();
  });
});

describe("caminhos LWW aplicação (L320-352 e conflitos)", () => {
  it("update em música de outro dono → server-wins-forbidden", () => {
    // colA pertence a A, música criada por B dentro dela
    const col = seedCollection(userIdA, "cov-forb-col");
    seedMusic(col, userIdB, "cov-forb-mus", 1000);
    const res = runSync(userIdB, {
      last_sync_at: 0,
      collections: [
        {
          client_uuid: "cov-forb-col",
          name: "x",
          description: null,
          author_name: null,
          deleted_at: null,
          updated_at: 2000,
          musics: [
            {
              client_uuid: "cov-forb-mus",
              name: "hackeada",
              lyric: null,
              auxiliary_lyric: null,
              duration: null,
              official_music_id: null,
              deleted_at: null,
              updated_at: 2000,
              lyrics: [],
            },
          ],
        },
      ],
    });
    expect(
      res.conflicts.some((c) => c.resolution === "server-wins-forbidden"),
    ).toBe(true);
  });

  it("delete remoto aplica tombstone; sync de B não ressuscita (B4)", () => {
    const col = seedCollection(userIdA, "cov-tomb-col");
    seedMusic(col, userIdA, "cov-tomb-mus");
    runSync(userIdA, {
      last_sync_at: 0,
      collections: [
        {
          client_uuid: "cov-tomb-col",
          name: "x",
          description: null,
          author_name: null,
          deleted_at: 3000,
          updated_at: 3000,
          musics: [
            {
              client_uuid: "cov-tomb-mus",
              name: null,
              lyric: null,
              auxiliary_lyric: null,
              duration: null,
              official_music_id: null,
              deleted_at: 3000,
              updated_at: 3000,
              lyrics: [],
            },
          ],
        },
      ],
    });
    const db = getDb();
    const m = db
      .prepare(`SELECT deleted_at FROM custom_musics WHERE client_uuid = ?`)
      .get("cov-tomb-mus") as { deleted_at: number | null };
    expect(m.deleted_at).not.toBeNull();

    // B sincroniza: recebe tombstone, não recria
    const resB = runSync(userIdB, {
      last_sync_at: 0,
      collections: [],
    });
    const colB = resB.collections.find((c) => c.client_uuid === "cov-tomb-col");
    expect(colB?.deleted_at).not.toBeNull();
  });

  it("música nova com lyrics → insert + replaceLyrics", () => {
    seedCollection(userIdA, "cov-lyr-col");
    const res = runSync(userIdA, {
      last_sync_at: 0,
      collections: [
        {
          client_uuid: "cov-lyr-col",
          name: "x",
          description: null,
          author_name: null,
          deleted_at: null,
          updated_at: 4000,
          musics: [
            {
              client_uuid: "cov-lyr-mus",
              name: "com letra",
              lyric: null,
              auxiliary_lyric: null,
              duration: null,
              official_music_id: null,
              deleted_at: null,
              updated_at: 4000,
              lyrics: [
                {
                  lyric: "verso",
                  aux_lyric: "tradução",
                  time: "00:00",
                  instrumental_time: null,
                  show_slide: 1,
                  order: 1,
                },
              ],
            },
          ],
        },
      ],
    });
    expect(res.applied.created).toBeGreaterThanOrEqual(1);
    const db = getDb();
    const n = db
      .prepare(
        `SELECT COUNT(*) c FROM custom_lyrics cl
         JOIN custom_musics cm ON cm.id_music = cl.id_music
         WHERE cm.client_uuid = ?`,
      )
      .get("cov-lyr-mus") as { c: number };
    expect(n.c).toBe(1);
  });

  it("update de música existente por update por client vence + lyrics substituídas", () => {
    const col = seedCollection(userIdA, "cov-upd-col");
    seedMusic(col, userIdA, "cov-upd-mus", 1000);
    runSync(userIdA, {
      last_sync_at: 0,
      collections: [
        {
          client_uuid: "cov-upd-col",
          name: "x",
          description: null,
          author_name: null,
          deleted_at: null,
          updated_at: 5000,
          musics: [
            {
              client_uuid: "cov-upd-mus",
              name: "renomeada",
              lyric: null,
              auxiliary_lyric: null,
              duration: 120,
              official_music_id: null,
              deleted_at: null,
              updated_at: 5000,
              lyrics: [
                {
                  lyric: "novo",
                  aux_lyric: null,
                  time: "00:01",
                  instrumental_time: "00:05",
                  show_slide: 0,
                  order: 0,
                },
              ],
            },
          ],
        },
      ],
    });
    const db = getDb();
    const m = db
      .prepare(`SELECT name, duration FROM custom_musics WHERE client_uuid = ?`)
      .get("cov-upd-mus") as { name: string; duration: number };
    expect(m.name).toBe("renomeada");
    expect(m.duration).toBe(120);
  });

  it("música antiga do server vence → conflito server-wins (L336)", () => {
    const col = seedCollection(userIdA, "cov-sw-col");
    seedMusic(col, userIdA, "cov-sw-mus", 9000); // server mais novo
    const res = runSync(userIdA, {
      last_sync_at: 0,
      collections: [
        {
          client_uuid: "cov-sw-col",
          name: "x",
          description: null,
          author_name: null,
          deleted_at: null,
          updated_at: 9000,
          musics: [
            {
              client_uuid: "cov-sw-mus",
              name: "stale",
              lyric: null,
              auxiliary_lyric: null,
              duration: null,
              official_music_id: null,
              deleted_at: null,
              updated_at: 1000, // cliente mais velho
              lyrics: [],
            },
          ],
        },
      ],
    });
    expect(res.conflicts.some((c) => c.resolution === "server-wins")).toBe(
      true,
    );
    const db = getDb();
    const m = db
      .prepare(`SELECT name FROM custom_musics WHERE client_uuid = ?`)
      .get("cov-sw-mus") as { name: string };
    expect(m.name).toBe("mus-cov-sw-mus"); // server preservado
  });
});
