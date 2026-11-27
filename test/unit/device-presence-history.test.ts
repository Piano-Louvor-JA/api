import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  flushPresence,
  recordHeartbeat,
  resetPresenceForTests,
  setPresenceGeo,
} from "../../src/lib/devicePresence.js";
import {
  HISTORY_PURGE_DAYS,
  listMapPoints,
  listRankings,
  purgeOldPresence,
  snapshotDaily,
  summarizeHistory,
} from "../../src/lib/devicePresenceHistory.js";

const tmpDir = mkdtempSync(join(tmpdir(), "piano-presence-hist-"));
const originalDbPath = process.env.DB_PATH;
let db: ReturnType<typeof import("../../src/db/connection.js").getDb>;
let closeDb: () => void;

beforeAll(async () => {
  process.env.DB_PATH = join(tmpDir, "presence-hist.db");
  const conn = await import("../../src/db/connection.js");
  conn.initDb();
  db = conn.getDb();
  closeDb = conn.closeDb;
});

afterAll(() => {
  closeDb();
  process.env.DB_PATH = originalDbPath;
  rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-27T15:00:00.000Z");

describe("devicePresenceHistory", () => {
  beforeEach(() => {
    resetPresenceForTests();
    db.exec("DELETE FROM device_presence");
    db.exec("DELETE FROM device_presence_daily");
  });

  it("resume: conta vistos no período e cruza com online", () => {
    recordHeartbeat(
      {
        installId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        platform: "desktop-windows",
        appVersion: "1.0.0",
        osName: "Windows",
        osRelease: "10",
        osArch: "x64",
        locale: "pt-BR",
        timezone: "America/Sao_Paulo",
        district: "Centro",
        church: "IASD Centro",
        partnerId: 1,
      },
      T0,
    );
    setPresenceGeo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      city: "São Paulo",
      region: "SP",
      country: "BR",
    });
    flushPresence(db);

    // Offline antigo (ainda na janela 90d)
    db.prepare(
      `INSERT INTO device_presence (
         install_id, platform, os_name, district, church, city, region, country,
         partner_id, first_seen, last_seen
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "desktop-linux",
      "Linux",
      "Litoral",
      "IASD Praia",
      "Santos",
      "SP",
      "BR",
      new Date(T0 - 40 * 86_400_000).toISOString(),
      new Date(T0 - 10 * 86_400_000).toISOString(),
    );

    const summary = summarizeHistory(90, T0, db);
    expect(summary.totals.seen).toBe(2);
    expect(summary.totals.online).toBe(1);
    expect(summary.totals.offline_seen).toBe(1);
    expect(summary.totals.with_church).toBe(2);
    expect(summary.totals.with_geo).toBe(2);
  });

  it("ranking por igreja agrupa variantes normalizadas", () => {
    for (const [id, church] of [
      ["11111111-1111-4111-8111-111111111111", "IASD Jardim"],
      ["22222222-2222-4222-8222-222222222222", "iasd  jardim"],
      ["33333333-3333-4333-8333-333333333333", "Outra"],
    ] as const) {
      db.prepare(
        `INSERT INTO device_presence (
           install_id, platform, church, city, region, country,
           partner_id, first_seen, last_seen
         ) VALUES (?, 'desktop-windows', ?, 'X', 'SP', 'BR', NULL, ?, ?)`,
      ).run(id, church, new Date(T0).toISOString(), new Date(T0).toISOString());
    }

    const rank = listRankings("church", 90, 10, T0, db);
    expect(rank.items[0].devices).toBe(2);
    expect(rank.items[0].key).toBe("iasd jardim");
    expect(rank.items).toHaveLength(2);
  });

  it("mapa BR: verde se online, cinza se só histórico", () => {
    recordHeartbeat(
      {
        installId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        platform: "desktop-mac",
        appVersion: "1.0.0",
        osName: "macOS",
        osRelease: "15",
        osArch: "arm64",
        locale: "pt-BR",
        timezone: "America/Sao_Paulo",
        district: null,
        church: null,
        partnerId: null,
      },
      T0,
    );
    setPresenceGeo("cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
      city: "Campinas",
      region: "SP",
      country: "BR",
    });
    flushPresence(db);

    db.prepare(
      `INSERT INTO device_presence (
         install_id, platform, city, region, country,
         partner_id, first_seen, last_seen
       ) VALUES (?, 'web', ?, ?, 'BR', NULL, ?, ?)`,
    ).run(
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "Campinas",
      "SP",
      new Date(T0 - 5 * 86_400_000).toISOString(),
      new Date(T0 - 2 * 86_400_000).toISOString(),
    );

    const map = listMapPoints(90, "BR", T0, db);
    expect(map.points).toHaveLength(1);
    expect(map.points[0].city).toBe("Campinas");
    expect(map.points[0].devices).toBe(2);
    expect(map.points[0].online).toBe(1);
    expect(map.points[0].is_online).toBe(true);
  });

  it("snapshot diário e purge respeitam retenção", () => {
    db.prepare(
      `INSERT INTO device_presence (
         install_id, platform, os_name, church, city, region, country,
         partner_id, first_seen, last_seen
       ) VALUES (?, 'desktop-windows', 'Windows', 'A', 'Y', 'RJ', 'BR', NULL, ?, ?)`,
    ).run(
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      new Date(T0).toISOString(),
      new Date(T0).toISOString(),
    );
    // Velho demais
    db.prepare(
      `INSERT INTO device_presence (
         install_id, platform, partner_id, first_seen, last_seen
       ) VALUES (?, 'web', NULL, ?, ?)`,
    ).run(
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      new Date(T0 - (HISTORY_PURGE_DAYS + 5) * 86_400_000).toISOString(),
      new Date(T0 - (HISTORY_PURGE_DAYS + 2) * 86_400_000).toISOString(),
    );

    expect(snapshotDaily(T0, db)).toBeGreaterThan(0);
    const dailyRows = db
      .prepare("SELECT COUNT(*) AS n FROM device_presence_daily WHERE day = ?")
      .get("2026-11-27") as { n: number };
    expect(dailyRows.n).toBeGreaterThan(0);

    const purged = purgeOldPresence(T0, db);
    expect(purged.presence).toBe(1);
    const left = db
      .prepare("SELECT COUNT(*) AS n FROM device_presence")
      .get() as { n: number };
    expect(left.n).toBe(1);
  });
});
