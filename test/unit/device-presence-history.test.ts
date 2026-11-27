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
  maintainHistory,
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

  it("memória antiga fora da janela é ignorada; memória recente sobrescreve SQLite", () => {
    const oldId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const freshId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    db.prepare(
      `INSERT INTO device_presence (
         install_id, platform, church, city, region, country,
         partner_id, first_seen, last_seen
       ) VALUES (?, 'web', 'Velha', 'X', 'SP', 'BR', NULL, ?, ?)`,
    ).run(
      freshId,
      new Date(T0 - 2 * 86_400_000).toISOString(),
      new Date(T0 - 2 * 86_400_000).toISOString(),
    );

    // Online antigo: lastSeen fora dos 90d — deve ser ignorado no merge.
    recordHeartbeat(
      {
        installId: oldId,
        platform: "desktop-windows",
        appVersion: "1.0.0",
        osName: "Windows",
        osRelease: "10",
        osArch: "x64",
        locale: "pt-BR",
        timezone: "America/Sao_Paulo",
        district: null,
        church: "Fora",
        partnerId: null,
      },
      T0 - 120 * 86_400_000,
    );
    // Memória recente sobrescreve o rótulo do SQLite.
    recordHeartbeat(
      {
        installId: freshId,
        platform: "web",
        appVersion: "1.0.0",
        osName: "Chrome",
        osRelease: "120",
        osArch: "x64",
        locale: "pt-BR",
        timezone: "America/Sao_Paulo",
        district: "Centro",
        church: "Nova",
        partnerId: null,
      },
      T0,
    );
    setPresenceGeo(freshId, { city: "Santos", region: "SP", country: "BR" });

    const rank = listRankings("church", 90, 10, T0, db);
    expect(rank.items.some((i) => i.label === "Nova")).toBe(true);
    expect(rank.items.some((i) => i.label === "Fora")).toBe(false);
  });

  it("ranking escolhe rótulo mais comum e desempata por online/nome", () => {
    // Minoria primeiro para forçar troca de rótulo (n > bestN).
    const rows = [
      ["11111111-aaaa-4aaa-8aaa-111111111111", "iasd alpha"],
      ["22222222-bbbb-4bbb-8bbb-222222222222", "IASD Alpha"],
      ["33333333-cccc-4ccc-8ccc-333333333333", "IASD Alpha"],
      ["44444444-dddd-4ddd-8ddd-444444444444", "Beta"],
      ["55555555-eeee-4eee-8eee-555555555555", "Gama"],
      ["66666666-ffff-4fff-8fff-666666666666", null],
    ] as const;
    for (const [id, church] of rows) {
      db.prepare(
        `INSERT INTO device_presence (
           install_id, platform, church, city, region, country,
           partner_id, first_seen, last_seen
         ) VALUES (?, 'desktop-windows', ?, 'C', 'SP', 'BR', NULL, ?, ?)`,
      ).run(id, church, new Date(T0).toISOString(), new Date(T0).toISOString());
    }
    const rank = listRankings("church", 90, 10, T0, db);
    expect(rank.items[0].label).toBe("IASD Alpha");
    expect(rank.items[0].devices).toBe(3);
    const singles = rank.items
      .filter((i) => i.devices === 1)
      .map((i) => i.label);
    expect(singles).toEqual(["Beta", "Gama"]);
  });

  it("mapa ignora país diferente e UF vazia; ordena online primeiro", () => {
    const inserts: Array<
      [string, string | null, string | null, string, number]
    > = [
      ["aaaaaaaa-0001-4001-8001-aaaaaaaa0001", "Lisboa", "PT", "PT", 0],
      ["aaaaaaaa-0002-4002-8002-aaaaaaaa0002", "SemUF", "", "BR", 0],
      ["aaaaaaaa-0003-4003-8003-aaaaaaaa0003", null, null, "BR", 3],
      ["aaaaaaaa-0005-4005-8005-aaaaaaaa0005", "Recife", "PE", "BR", 3],
      ["aaaaaaaa-0006-4006-8006-aaaaaaaa0006", "  ", "PE", "BR", 4],
    ];
    for (const [id, city, region, country, daysAgo] of inserts) {
      db.prepare(
        `INSERT INTO device_presence (
           install_id, platform, city, region, country,
           partner_id, first_seen, last_seen
         ) VALUES (?, 'web', ?, ?, ?, NULL, ?, ?)`,
      ).run(
        id,
        city,
        region,
        country,
        new Date(T0 - daysAgo * 86_400_000).toISOString(),
        new Date(T0 - daysAgo * 86_400_000).toISOString(),
      );
    }
    recordHeartbeat(
      {
        installId: "aaaaaaaa-0004-4004-8004-aaaaaaaa0004",
        platform: "desktop-linux",
        appVersion: "1.0.0",
        osName: "Linux",
        osRelease: "6",
        osArch: "x64",
        locale: "pt-BR",
        timezone: "America/Sao_Paulo",
        district: null,
        church: null,
        partnerId: null,
      },
      T0,
    );
    setPresenceGeo("aaaaaaaa-0004-4004-8004-aaaaaaaa0004", {
      city: "Olinda",
      region: "PE",
      country: "BR",
    });

    const map = listMapPoints(90, "BR", T0, db);
    expect(map.points.some((p) => p.city === "Lisboa")).toBe(false);
    expect(map.points.some((p) => p.city === "SemUF")).toBe(false);
    expect(map.points[0].is_online).toBe(true);
    // country vazio normaliza para "br"
    const mapDefault = listMapPoints(90, "   ", T0, db);
    expect(mapDefault.country).toBe("   ".toUpperCase());
    expect(mapDefault.points.length).toBeGreaterThan(0);
  });

  it("snapshot diário troca o rótulo quando outra grafia vira maioria", () => {
    // Ordem: grafia minoritária primeiro → depois a majoritária (hit n > bestN).
    for (const [id, church] of [
      ["bbbbbbbb-0001-4001-8001-bbbbbbbb0001", "igreja a"],
      ["bbbbbbbb-0002-4002-8002-bbbbbbbb0002", "Igreja A"],
      ["bbbbbbbb-0003-4003-8003-bbbbbbbb0003", "Igreja A"],
    ] as const) {
      db.prepare(
        `INSERT INTO device_presence (
           install_id, platform, os_name, church, city, region, country,
           partner_id, first_seen, last_seen
         ) VALUES (?, 'desktop-windows', 'Windows', ?, 'C', 'SP', 'BR', NULL, ?, ?)`,
      ).run(id, church, new Date(T0).toISOString(), new Date(T0).toISOString());
    }
    expect(snapshotDaily(T0, db)).toBeGreaterThan(0);
    const row = db
      .prepare(
        `SELECT label, devices FROM device_presence_daily
         WHERE day = ? AND dim = 'church' AND key_norm = 'igreja a'`,
      )
      .get("2026-11-27") as { label: string; devices: number };
    expect(row.devices).toBe(3);
    expect(row.label).toBe("Igreja A");

    maintainHistory(T0, db);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM device_presence_daily WHERE day = ?",
          )
          .get("2026-11-27") as { n: number }
      ).n,
    ).toBeGreaterThan(0);
  });

  it("rankings por os/region/country e limit mínimo 1", () => {
    db.prepare(
      `INSERT INTO device_presence (
         install_id, platform, os_name, region, country,
         partner_id, first_seen, last_seen
       ) VALUES (?, 'desktop-mac', 'macOS', 'RJ', 'BR', NULL, ?, ?)`,
    ).run(
      "cccccccc-0001-4001-8001-cccccccc0001",
      new Date(T0).toISOString(),
      new Date(T0).toISOString(),
    );
    // raw não-nulo que normaliza vazio → dimValue retorna null
    db.prepare(
      `INSERT INTO device_presence (
         install_id, platform, os_name, church, region, country,
         partner_id, first_seen, last_seen
       ) VALUES (?, 'web', '   ', '   ', 'SP', 'BR', NULL, ?, ?)`,
    ).run(
      "cccccccc-0002-4002-8002-cccccccc0002",
      new Date(T0).toISOString(),
      new Date(T0).toISOString(),
    );
    expect(listRankings("os", 90, 0, T0, db).items).toHaveLength(1);
    expect(listRankings("church", 90, 10, T0, db).items).toHaveLength(0);
    expect(listRankings("region", 90, 10, T0, db).items[0].label).toBe("RJ");
    expect(listRankings("country", 90, 10, T0, db).items[0].label).toBe("BR");
  });

  it("resumo cobre sem igreja/geo e mapa com cidade nula", () => {
    const inserts: Array<
      [string, string | null, string | null, string | null, string]
    > = [
      // sem igreja, sem geo
      ["dddddddd-0001-4001-8001-dddddddd0001", null, null, null, "BR"],
      // sem cidade, com UF (with_geo via region; city ?? "")
      ["dddddddd-0002-4002-8002-dddddddd0002", null, null, "MG", "BR"],
      // outra UF só região — empate no sort do mapa (city null)
      ["dddddddd-0003-4003-8003-dddddddd0003", null, null, "BA", "BR"],
      // cidade preenchida, mesma quantidade — força localeCompare com null
      ["dddddddd-0004-4004-8004-dddddddd0004", null, "Uberlândia", "MG", "BR"],
    ];
    for (const [id, church, city, region, country] of inserts) {
      db.prepare(
        `INSERT INTO device_presence (
           install_id, platform, church, city, region, country,
           partner_id, first_seen, last_seen
         ) VALUES (?, 'web', ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        id,
        church,
        city,
        region,
        country,
        new Date(T0 - 86_400_000).toISOString(),
        new Date(T0 - 86_400_000).toISOString(),
      );
    }

    const summary = summarizeHistory(90, T0, db);
    expect(summary.totals.seen).toBe(4);
    expect(summary.totals.with_church).toBe(0);
    expect(summary.totals.with_geo).toBe(3);

    const map = listMapPoints(90, "BR", T0, db);
    const nullCities = map.points.filter((p) => p.city === null);
    expect(nullCities.length).toBeGreaterThanOrEqual(2);
    expect(map.points.some((p) => p.city === "Uberlândia")).toBe(true);
  });
});
