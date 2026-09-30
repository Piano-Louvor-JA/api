/**
 * Fechamento fino de cobertura (B13):
 * - sync.service L309-313: applyMusic update em música de OUTRO dono →
 *   server-wins-forbidden.
 * - quota branches: getQuotaBytes com CUSTOM_QUOTA_MB válido/inválido (L18),
 *   usedBytes com owner sem arquivos (L32), purgeTombstones com days custom (L63).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmpDir = mkdtempSync(join(tmpdir(), "plj-cov-fine-"));
process.env.DB_PATH = join(tmpDir, "fine.db");

import { closeDb, getDb, initDb } from "../../src/db/connection.js";
import { hashPassword } from "../../src/v1/custom/auth.service.js";
import {
  getQuotaBytes,
  purgeTombstones,
  quotaCheck,
  usedBytes,
} from "../../src/v1/custom/quota.service.js";
import { runSync } from "../../src/v1/custom/sync.service.js";

let uid = 0;
let uidOther = 0;

beforeAll(() => {
  initDb();
  const db = getDb();
  const u = db
    .prepare(
      "INSERT INTO custom_users (email, password_hash, display_name) VALUES (?,?,?)",
    )
    .run("fine@t.l", hashPassword("x"), "fine");
  uid = Number(u.lastInsertRowid);
  const v = db
    .prepare(
      "INSERT INTO custom_users (email, password_hash, display_name) VALUES (?,?,?)",
    )
    .run("other@t.l", hashPassword("x"), "other");
  uidOther = Number(v.lastInsertRowid);
});

afterAll(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("applyMusic forbidden (L309-313)", () => {
  it("update de música de outro dono → server-wins-forbidden", () => {
    const db = getDb();
    const col = db
      .prepare(
        "INSERT INTO custom_collections (name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,?)",
      )
      .run("fc", uid, "fine-col", 1000);
    const colId = Number(col.lastInsertRowid);
    db.prepare(
      "INSERT INTO custom_musics (id_collection, name, owner_id, client_uuid, updated_at_ms) VALUES (?,?,?,?,?)",
    ).run(colId, "fm", uidOther, "fine-mus", 1000);

    const res = runSync(uid, {
      last_sync_at: 0,
      collections: [
        {
          client_uuid: "fine-col",
          name: "fc",
          description: null,
          author_name: null,
          deleted_at: null,
          updated_at: 2000,
          musics: [
            {
              client_uuid: "fine-mus",
              name: "hack",
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
      res.conflicts.some(
        (c) =>
          c.client_uuid === "fine-mus" &&
          c.resolution === "server-wins-forbidden",
      ),
    ).toBe(true);
    const m = db
      .prepare("SELECT name FROM custom_musics WHERE client_uuid = ?")
      .get("fine-mus") as { name: string };
    expect(m.name).toBe("fm");
  });
});

describe("quota branches finas", () => {
  it("CUSTOM_QUOTA_MB válido altera a quota", () => {
    process.env.CUSTOM_QUOTA_MB = "10";
    expect(getQuotaBytes()).toBe(10 * 1024 * 1024);
    delete process.env.CUSTOM_QUOTA_MB;
    expect(getQuotaBytes()).toBe(100 * 1024 * 1024); // volta ao default
  });

  it("CUSTOM_QUOTA_MB inválido/negativo usa default", () => {
    process.env.CUSTOM_QUOTA_MB = "-5";
    expect(getQuotaBytes()).toBe(100 * 1024 * 1024);
    process.env.CUSTOM_QUOTA_MB = "abc";
    expect(getQuotaBytes()).toBe(100 * 1024 * 1024);
    delete process.env.CUSTOM_QUOTA_MB;
  });

  it("usedBytes de usuário sem arquivos = 0; quotaCheck ok", () => {
    expect(usedBytes(uid)).toBe(0);
    const r = quotaCheck(uid, 1024);
    expect(r.ok).toBe(true);
  });

  it("purgeTombstones com days custom (default-arg coberto pelo teste do quota-purge)", () => {
    const r = purgeTombstones(365); // nada expira
    expect(r.collections).toBe(0);
    expect(r.musics).toBe(0);
  });
});
