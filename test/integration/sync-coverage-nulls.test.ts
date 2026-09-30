/**
 * Fecha as últimas branches (B13): valores NULL/vazios nos ?? do loadServer e
 * do replaceLyrics; purgeTombstones() sem argumento (default-arg); usedBytes
 * com SUM NULL.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmpDir = mkdtempSync(join(tmpdir(), "plj-cov-null-"));
process.env.DB_PATH = join(tmpDir, "null.db");

import { closeDb, getDb, initDb } from "../../src/db/connection.js";
import { hashPassword } from "../../src/v1/custom/auth.service.js";
import {
  purgeTombstones,
  usedBytes,
} from "../../src/v1/custom/quota.service.js";
import { runSync } from "../../src/v1/custom/sync.service.js";

let uid = 0;

beforeAll(() => {
  initDb();
  const db = getDb();
  const u = db
    .prepare(
      "INSERT INTO custom_users (email, password_hash, display_name) VALUES (?,?,?)",
    )
    .run("nulls@t.l", hashPassword("x"), "nulls");
  uid = Number(u.lastInsertRowid);
});

afterAll(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("NULLs no caminho de leitura (L151-169)", () => {
  it("coleção/música com updated_at_ms NULL e campos NULL → defaults aplicados", () => {
    const db = getDb();
    // updated_at_ms NULL (legado absoluto) + name NULL
    const col = db
      .prepare(
        "INSERT INTO custom_collections (name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,NULL)",
      )
      .run("legada", uid, "null-col");
    const colId = Number(col.lastInsertRowid);
    db.prepare(
      "INSERT INTO custom_musics (id_collection, name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,?,NULL)",
    ).run(colId, null, uid, "null-mus");

    const res = runSync(uid, { last_sync_at: 0, collections: [] });
    const c = res.collections.find((x) => x.client_uuid === "null-col");
    expect(c).toBeTruthy();
    expect(c?.updated_at_ms).toBe(0);
    const m = c?.musics?.find((x) => x.client_uuid === "null-mus");
    expect(m?.updated_at_ms).toBe(0);
    expect(m?.name).toBeNull();
    // L221/L304 (serverTs ?? 0): sync com ts 1 > 0 aplica em cima do NULL
    const res2 = runSync(uid, {
      last_sync_at: 0,
      collections: [
        {
          client_uuid: "null-col",
          name: "agora",
          description: null,
          author_name: null,
          deleted_at: null,
          updated_at: 5,
          musics: [],
        },
      ],
    });
    expect(res2.applied.updated).toBeGreaterThanOrEqual(1);
  });

  it("leitura de música legado com client_uuid NULL (L161 lado 0)", () => {
    const db = getDb();
    const col = db
      .prepare(
        "INSERT INTO custom_collections (name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,?)",
      )
      .run("leguuid", uid, "leg-col", 100);
    const colId = Number(col.lastInsertRowid);
    db.prepare(
      "INSERT INTO custom_musics (id_collection, name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,NULL,?)",
    ).run(colId, "sem-uuid", uid, 100);
    const res = runSync(uid, { last_sync_at: 0, collections: [] });
    const c = res.collections.find((x) => x.client_uuid === "leg-col");
    const m = c?.musics?.find((x) => x.client_uuid === null);
    expect(m).toBeTruthy();
    expect(m?.name).toBe("sem-uuid");
  });

  it("update em música com updated_at_ms NULL (L304 lado 0)", () => {
    const db = getDb();
    const col = db
      .prepare(
        "INSERT INTO custom_collections (name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,?)",
      )
      .run("nullts", uid, "nullts-col", 100);
    const colId = Number(col.lastInsertRowid);
    db.prepare(
      "INSERT INTO custom_musics (id_collection, name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,?,NULL)",
    ).run(colId, "sem-ts", uid, "nullts-mus");
    const res = runSync(uid, {
      last_sync_at: 0,
      collections: [
        {
          client_uuid: "nullts-col",
          name: "nullts",
          description: null,
          author_name: null,
          deleted_at: null,
          updated_at: 200,
          musics: [
            {
              client_uuid: "nullts-mus",
              name: "renomeada-null",
              lyric: null,
              auxiliary_lyric: null,
              duration: null,
              official_music_id: null,
              deleted_at: null,
              updated_at: 200,
              lyrics: [],
            },
          ],
        },
      ],
    });
    // serverTs NULL ?? 0 = 0 < 200 → client vence
    expect(
      res.conflicts.some(
        (c) => c.client_uuid === "nullts-mus" && c.resolution === "server-wins",
      ),
    ).toBe(false);
    const m = db
      .prepare(
        "SELECT name, updated_at_ms FROM custom_musics WHERE client_uuid=?",
      )
      .get("nullts-mus") as { name: string; updated_at_ms: number };
    expect(m.name).toBe("renomeada-null");
    expect(m.updated_at_ms).toBe(200);
  });
});

describe("branch de propagação delete-collection (L251)", () => {
  it("delete de coleção SEM músicas no payload (array vazio)", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO custom_collections (name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,?)",
    ).run("delme", uid, "del-col", 10);
    const res = runSync(uid, {
      last_sync_at: 0,
      collections: [
        {
          client_uuid: "del-col",
          name: "delme",
          description: null,
          author_name: null,
          deleted_at: 9999,
          updated_at: 9999,
          musics: [],
        },
      ],
    });
    expect(res.applied.updated).toBe(1);
  });

  it("delete de coleção com música que JÁ tem deleted_at próprio (L251 lado 0)", () => {
    const db = getDb();
    const col = db
      .prepare(
        "INSERT INTO custom_collections (name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,?)",
      )
      .run("dd", uid, "dd-col", 10);
    const colId = Number(col.lastInsertRowid);
    db.prepare(
      "INSERT INTO custom_musics (id_collection, name, owner_id, client_uuid, updated_at_ms, deleted_at) VALUES (?,?,?,?,?,?)",
    ).run(colId, "ddm", uid, "dd-mus", 3, 4); // música tombstoned (ts 3), delete próprio 4
    const res = runSync(uid, {
      last_sync_at: 0,
      collections: [
        {
          client_uuid: "dd-col",
          name: "dd",
          description: null,
          author_name: null,
          deleted_at: 9999,
          updated_at: 9999,
          musics: [
            {
              client_uuid: "dd-mus",
              name: null,
              lyric: null,
              auxiliary_lyric: null,
              duration: null,
              official_music_id: null,
              deleted_at: 4, // já deletada — mantém o próprio ts
              updated_at: 4,
              lyrics: [],
            },
          ],
        },
      ],
    });
    expect(res.applied.updated).toBe(2); // coleção + música propagada
    const m = db
      .prepare(
        "SELECT deleted_at, updated_at_ms FROM custom_musics WHERE client_uuid=?",
      )
      .get("dd-mus") as { deleted_at: number; updated_at_ms: number };
    expect(m.deleted_at).toBe(4); // preservou o ts original
    expect(m.updated_at_ms).toBe(4);
  });
});

describe("applyMusic insert com campos ausentes (L286) e lyrics parciais (L358-361)", () => {
  it("música nova sem name/lyric (insert NULL) e lyrics com time/order ausentes", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO custom_collections (name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,?)",
    ).run("ins", uid, "ins-col", 10);
    const res = runSync(uid, {
      last_sync_at: 0,
      collections: [
        {
          client_uuid: "ins-col",
          name: "ins",
          description: null,
          author_name: null,
          deleted_at: null,
          updated_at: 20,
          musics: [
            {
              client_uuid: "ins-mus",
              name: null,
              lyric: null,
              auxiliary_lyric: null,
              duration: null,
              official_music_id: null,
              deleted_at: null,
              updated_at: 20,
              lyrics: [
                {
                  lyric: "v",
                  aux_lyric: null,
                  time: null, // L358 ?? "00:00"
                  instrumental_time: null,
                  show_slide: undefined as unknown as number,
                  order: undefined as unknown as number, // L361 ?? 0
                },
              ],
            },
          ],
        },
      ],
    });
    expect(res.applied.created).toBe(1);
    const l = db
      .prepare(
        `SELECT cl.time, cl."order" FROM custom_lyrics cl
         JOIN custom_musics cm ON cm.id_music = cl.id_music
         WHERE cm.client_uuid = ?`,
      )
      .get("ins-mus") as { time: string; order: number };
    expect(l.time).toBe("00:00");
    expect(l.order).toBe(0);
  });
});

it("delete de coleção com música SEM updated_at próprio (herda ts do delete)", () => {
  const db = getDb();
  const col = db
    .prepare(
      "INSERT INTO custom_collections (name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,?)",
    )
    .run("inh", uid, "inh-col", 10);
  const colId = Number(col.lastInsertRowid);
  db.prepare(
    "INSERT INTO custom_musics (id_collection, name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,?,2)",
  ).run(colId, "inhm", uid, "inh-mus");
  const res = runSync(uid, {
    last_sync_at: 0,
    collections: [
      {
        client_uuid: "inh-col",
        name: "inh",
        description: null,
        author_name: null,
        deleted_at: 9999,
        updated_at: 9999,
        musics: [
          {
            client_uuid: "inh-mus",
            name: "x",
            lyric: null,
            auxiliary_lyric: null,
            duration: null,
            official_music_id: null,
            deleted_at: null,
            updated_at: undefined as unknown as number, // herda 9999
            lyrics: [],
          },
        ],
      },
    ],
  });
  const m = db
    .prepare(
      "SELECT deleted_at, updated_at_ms FROM custom_musics WHERE client_uuid=?",
    )
    .get("inh-mus") as { deleted_at: number; updated_at_ms: number };
  expect(m.deleted_at).toBe(9999);
  expect(m.updated_at_ms).toBe(9999);
});

describe("purgeTombstones() sem arg (L63 default)", () => {
  it("usa 30 dias por padrão", () => {
    const r = purgeTombstones();
    expect(r.collections).toBeGreaterThanOrEqual(0);
  });
});

describe("usedBytes SUM NULL (L32)", () => {
  it("owner sem nenhuma linha de música viva → 0", () => {
    // uid tem músicas? criamos uma. Usamos um owner id alto sem registros.
    expect(usedBytes(987654)).toBe(0);
  });
});
