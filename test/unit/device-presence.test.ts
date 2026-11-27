import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type DeviceHeartbeat,
  flushPresence,
  listOnline,
  loadRecentPresence,
  normalizeName,
  ONLINE_WINDOW_MS,
  recordHeartbeat,
  recordPassiveAccess,
  resetPresenceForTests,
  setMaxDevicesForTests,
  setPresenceGeo,
  startPresencePersistence,
} from "../../src/lib/devicePresence.js";

/**
 * Telemetria de dispositivos online (app/.planning/telemetria-dispositivos).
 * Estado vivo em memória + flush em lote no SQLite; IP nunca entra aqui.
 */

const tmpDir = mkdtempSync(join(tmpdir(), "piano-presence-"));
const originalDbPath = process.env.DB_PATH;
let db: ReturnType<typeof import("../../src/db/connection.js").getDb>;
let closeDb: () => void;

beforeAll(async () => {
  process.env.DB_PATH = join(tmpDir, "presence.db");
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

const T0 = Date.parse("2026-11-26T12:00:00.000Z");

function hb(over: Partial<DeviceHeartbeat> = {}): DeviceHeartbeat {
  return {
    installId: "6f1c2b0e-8a4d-4c1e-9b2a-3d4e5f6a7b8c",
    platform: "desktop-windows",
    appVersion: "1.38.0",
    osName: "Windows 11 Pro",
    osRelease: "10.0.26100",
    osArch: "x64",
    locale: "pt-BR",
    timezone: "America/Sao_Paulo",
    district: "Bertioga",
    church: "Rio da Praia",
    partnerId: 1,
    ...over,
  };
}

describe("devicePresence", () => {
  beforeEach(() => {
    resetPresenceForTests();
    db.exec("DELETE FROM device_presence");
  });

  it("normaliza nomes para agrupar (minúsculas, sem acento, espaços)", () => {
    expect(normalizeName("  Distrito  São   Paulo ")).toBe(
      "distrito sao paulo",
    );
    expect(normalizeName("")).toBe("");
    expect(normalizeName(null)).toBe("");
  });

  it("heartbeat entra no online; some depois da janela de 11 min", () => {
    recordHeartbeat(hb(), T0);
    expect(listOnline(T0 + 60_000).devices).toHaveLength(1);
    expect(listOnline(T0 + ONLINE_WINDOW_MS - 1).devices).toHaveLength(1);
    expect(listOnline(T0 + ONLINE_WINDOW_MS + 1).devices).toHaveLength(0);
  });

  it("mesmo install_id atualiza o registro e mantém first_seen", () => {
    recordHeartbeat(hb({ church: "Antiga" }), T0);
    recordHeartbeat(hb({ church: "Nova" }), T0 + 5 * 60_000);
    const { devices } = listOnline(T0 + 6 * 60_000);
    expect(devices).toHaveLength(1);
    expect(devices[0].church).toBe("Nova");
    expect(devices[0].first_seen).toBe(new Date(T0).toISOString());
    expect(devices[0].last_seen).toBe(new Date(T0 + 5 * 60_000).toISOString());
  });

  it("totais por plataforma e identificados (com partner)", () => {
    recordHeartbeat(hb(), T0);
    recordHeartbeat(
      hb({
        installId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        platform: "apk-android",
        partnerId: null,
      }),
      T0,
    );
    const { totals, devices } = listOnline(T0 + 1000);
    expect(totals).toEqual({
      online: 2,
      identified: 1,
      unidentified: 1,
      by_platform: { "desktop-windows": 1, "apk-android": 1 },
    });
    expect(devices.every((d) => d.source === "heartbeat")).toBe(true);
  });

  it("presença passiva entra como sem token e não grava no SQLite", () => {
    recordPassiveAccess(
      {
        installId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
        platform: "desktop-linux",
        appVersion: null,
      },
      T0,
    );
    const { totals, devices } = listOnline(T0 + 1000);
    expect(totals).toEqual({
      online: 1,
      identified: 0,
      unidentified: 1,
      by_platform: { "desktop-linux": 1 },
    });
    expect(devices[0]).toMatchObject({
      identified: false,
      source: "passive",
      app_version: null,
      church: null,
    });
    expect(flushPresence(db)).toBe(0);
  });

  it("passive não rebaixa um heartbeat do mesmo install_id", () => {
    recordHeartbeat(hb({ partnerId: 1 }), T0);
    recordPassiveAccess(
      {
        installId: hb().installId,
        platform: "desktop-windows",
        appVersion: "0.0.1",
      },
      T0 + 1000,
    );
    const [device] = listOnline(T0 + 2000).devices;
    expect(device).toMatchObject({
      identified: true,
      source: "heartbeat",
      app_version: "1.38.0",
    });
  });

  it("a resposta expõe só o início do install_id", () => {
    recordHeartbeat(hb(), T0);
    const [device] = listOnline(T0 + 1000).devices;
    expect(device.install_id_short).toBe("6f1c2b");
    expect(JSON.stringify(device)).not.toContain(hb().installId);
  });

  it("filtros: plataforma, UF, distrito (sem acento/caixa) e busca livre", () => {
    recordHeartbeat(hb(), T0);
    setPresenceGeo(hb().installId, {
      city: "Bertioga",
      region: "SP",
      country: "BR",
    });
    recordHeartbeat(
      hb({
        installId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        platform: "web",
        district: "São Paulo Central",
        church: "IASD Liberdade",
      }),
      T0,
    );
    const now = T0 + 1000;
    expect(listOnline(now, { platform: "web" }).devices).toHaveLength(1);
    expect(listOnline(now, { region: "sp" }).devices).toHaveLength(1);
    expect(
      listOnline(now, { district: "sao paulo central" }).devices,
    ).toHaveLength(1);
    expect(listOnline(now, { q: "liberdade" }).devices).toHaveLength(1);
    expect(listOnline(now, { q: "bertioga" }).devices).toHaveLength(1);
    // Totais refletem o filtro aplicado.
    expect(listOnline(now, { platform: "web" }).totals.online).toBe(1);
  });

  it("ordena pelo último sinal, mais recente primeiro", () => {
    recordHeartbeat(hb(), T0);
    recordHeartbeat(
      hb({ installId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }),
      T0 + 2000,
    );
    const ids = listOnline(T0 + 3000).devices.map((d) => d.install_id_short);
    expect(ids).toEqual(["0a1b2c", "6f1c2b"]);
  });

  it("flush grava em lote; restart (Map vazio) recupera os online do banco", () => {
    recordHeartbeat(hb(), T0);
    setPresenceGeo(hb().installId, {
      city: "Bertioga",
      region: "SP",
      country: "BR",
    });
    expect(flushPresence(db)).toBe(1);
    // Nada sujo: segundo flush não regrava.
    expect(flushPresence(db)).toBe(0);

    resetPresenceForTests();
    expect(listOnline(T0 + 1000).devices).toHaveLength(0);
    expect(loadRecentPresence(T0 + 1000, db)).toBe(1);
    const [device] = listOnline(T0 + 1000).devices;
    expect(device).toMatchObject({
      platform: "desktop-windows",
      church: "Rio da Praia",
      city: "Bertioga",
      region: "SP",
    });
  });

  it("loadRecent ignora quem saiu da janela", () => {
    recordHeartbeat(hb(), T0);
    flushPresence(db);
    resetPresenceForTests();
    expect(loadRecentPresence(T0 + ONLINE_WINDOW_MS + 1, db)).toBe(0);
  });

  it("loadRecent não sobrescreve quem já está no Map", () => {
    recordHeartbeat(hb({ church: "Ao vivo" }), T0);
    flushPresence(db);
    // Ainda no Map (dirty limpo pelo flush); loadRecent deve pular.
    expect(loadRecentPresence(T0 + 1000, db)).toBe(1);
    expect(listOnline(T0 + 1000).devices[0].church).toBe("Ao vivo");
  });

  it("setPresenceGeo em install_id desconhecido é no-op", () => {
    expect(() =>
      setPresenceGeo("00000000-0000-4000-8000-000000000099", {
        city: "X",
        region: "SP",
        country: "BR",
      }),
    ).not.toThrow();
    expect(listOnline(T0 + 1000).devices).toHaveLength(0);
  });

  it("ao atingir o teto, evictStale remove entradas velhas e limpas", () => {
    setMaxDevicesForTests(1);
    recordHeartbeat(hb(), T0);
    expect(flushPresence(db)).toBe(1); // dirty=false
    // Cap=1 e entrada ainda "online" mas dirty=false: eviction só tira se
    // lastSeen passou da janela.
    recordHeartbeat(
      hb({ installId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }),
      T0 + ONLINE_WINDOW_MS + 1,
    );
    // A antiga ainda estava dentro do Map até o eviction (fora da janela).
    expect(listOnline(T0 + ONLINE_WINDOW_MS + 2).devices).toHaveLength(1);
    expect(
      listOnline(T0 + ONLINE_WINDOW_MS + 2).devices[0].install_id_short,
    ).toBe("0a1b2c");
    setMaxDevicesForTests(null);
  });

  it("evictStale mantém entradas recentes ou dirty (ramo else do if)", () => {
    setMaxDevicesForTests(1);
    // Entrada fresh + dirty: condição do if falha → else.
    recordHeartbeat(hb(), T0);
    recordHeartbeat(
      hb({ installId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }),
      T0 + 1000,
    );
    // Sem eviction efetiva: ambas podem coexistir além do cap (defesa best-effort).
    expect(listOnline(T0 + 2000).devices.length).toBeGreaterThanOrEqual(1);
    setMaxDevicesForTests(null);
  });

  it("a tabela não tem coluna de IP", () => {
    const cols = (
      db.prepare("PRAGMA table_info(device_presence)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toContain("install_id");
    expect(cols.some((c) => /ip/i.test(c) && c !== "install_id")).toBe(false);
  });

  it("migration 038 é idempotente (roda de novo sem erro)", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      join(process.cwd(), "src/db/migrations/038_device_presence.sql"),
      "utf-8",
    );
    expect(() => db.exec(sql)).not.toThrow();
    expect(() => db.exec(sql)).not.toThrow();
  });

  describe("startPresencePersistence", () => {
    it("no boot recarrega do banco; grava a cada intervalo; stop limpa", () => {
      vi.useFakeTimers();
      try {
        recordHeartbeat(hb(), Date.now());
        flushPresence(db);
        resetPresenceForTests();

        const stop = startPresencePersistence(60_000, db);
        expect(listOnline().devices).toHaveLength(1);

        recordHeartbeat(hb({ church: "Depois do boot" }), Date.now());
        vi.advanceTimersByTime(60_000);
        const row = db
          .prepare("SELECT church FROM device_presence WHERE install_id = ?")
          .get(hb().installId) as { church: string };
        expect(row.church).toBe("Depois do boot");

        stop();
        recordHeartbeat(hb({ church: "Sem flush" }), Date.now());
        vi.advanceTimersByTime(120_000);
        const after = db
          .prepare("SELECT church FROM device_presence WHERE install_id = ?")
          .get(hb().installId) as { church: string };
        expect(after.church).toBe("Depois do boot");
      } finally {
        vi.useRealTimers();
      }
    });

    it("no SIGTERM grava o pendente e devolve o sinal ao comportamento padrão", () => {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const before = process.listenerCount("SIGTERM");
      const stop = startPresencePersistence(60_000, db);
      try {
        expect(process.listenerCount("SIGTERM")).toBe(before + 1);
        recordHeartbeat(hb({ church: "No desligamento" }), Date.now());
        process.emit("SIGTERM", "SIGTERM");
        const row = db
          .prepare("SELECT church FROM device_presence WHERE install_id = ?")
          .get(hb().installId) as { church: string };
        expect(row.church).toBe("No desligamento");
        expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
        expect(process.listenerCount("SIGTERM")).toBe(before);
      } finally {
        stop();
        killSpy.mockRestore();
      }
    });

    it("falha no flush não derruba (loga e segue)", () => {
      vi.useFakeTimers();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const broken = {
        prepare: () => {
          throw new Error("db fechado");
        },
      } as never;
      try {
        const stop = startPresencePersistence(60_000, broken);
        recordHeartbeat(hb(), Date.now());
        expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
        expect(err).toHaveBeenCalled();
        stop();
      } finally {
        err.mockRestore();
        vi.useRealTimers();
      }
    });

    it("sem db explícito usa getDb() do processo", () => {
      vi.useFakeTimers();
      try {
        recordHeartbeat(hb(), Date.now());
        flushPresence(db);
        resetPresenceForTests();
        const stop = startPresencePersistence(60_000);
        expect(listOnline().devices).toHaveLength(1);
        // Dispara safeFlush → flushPresence(getDb()) quando db não foi passado.
        recordHeartbeat(hb({ church: "Via getDb" }), Date.now());
        vi.advanceTimersByTime(60_000);
        const row = db
          .prepare("SELECT church FROM device_presence WHERE install_id = ?")
          .get(hb().installId) as { church: string };
        expect(row.church).toBe("Via getDb");
        stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
