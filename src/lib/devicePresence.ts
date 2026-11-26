/**
 * Telemetria de dispositivos online (app/.planning/telemetria-dispositivos).
 *
 * - Estado vivo em memória (Map por install_id): fonte do "online agora".
 *   Evita um INSERT síncrono do better-sqlite3 por heartbeat.
 * - flushPresence() grava em lote, numa transação, só o que mudou.
 * - loadRecentPresence() repõe o Map no boot (restart não zera o painel).
 * - IP nunca entra aqui (LGPD): só cidade/UF/país já resolvidos.
 */

import { getDb } from "../db/connection.js";

/** 2 intervalos de 5 min + folga para atraso de rede e throttling. */
export const ONLINE_WINDOW_MS = 11 * 60_000;

/** Hard cap defensivo de memória (ordens de grandeza acima do uso real). */
const MAX_DEVICES = 50_000;
let maxDevicesCap = MAX_DEVICES;

/** Testes: reduz o teto para exercitar o eviction sem encher 50k entradas. */
export function setMaxDevicesForTests(n: number | null): void {
  maxDevicesCap = n == null ? MAX_DEVICES : Math.max(1, n);
}

export interface DeviceHeartbeat {
  installId: string;
  platform: string;
  appVersion: string | null;
  osName: string | null;
  osRelease: string | null;
  osArch: string | null;
  locale: string | null;
  timezone: string | null;
  district: string | null;
  church: string | null;
  partnerId: number | null;
}

export interface GeoInfo {
  city: string | null;
  region: string | null;
  country: string | null;
}

interface PresenceEntry extends DeviceHeartbeat, GeoInfo {
  firstSeen: number;
  lastSeen: number;
  dirty: boolean;
}

export interface OnlineDevice {
  install_id_short: string;
  platform: string;
  app_version: string | null;
  os: string | null;
  district: string | null;
  church: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  identified: boolean;
  first_seen: string;
  last_seen: string;
}

export interface OnlineFilters {
  platform?: string;
  region?: string;
  district?: string;
  q?: string;
}

export interface OnlineList {
  totals: {
    online: number;
    identified: number;
    by_platform: Record<string, number>;
  };
  devices: OnlineDevice[];
}

const presence = new Map<string, PresenceEntry>();

/** Testes: zera o estado em memória. */
export function resetPresenceForTests(): void {
  presence.clear();
  maxDevicesCap = MAX_DEVICES;
}

/** Minúsculas, sem acento e com espaços colapsados — para agrupar e filtrar. */
export function normalizeName(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function evictStale(now: number): void {
  for (const [id, entry] of presence) {
    if (now - entry.lastSeen > ONLINE_WINDOW_MS && !entry.dirty) {
      presence.delete(id);
    }
  }
}

export function recordHeartbeat(hb: DeviceHeartbeat, now = Date.now()): void {
  const current = presence.get(hb.installId);
  if (!current && presence.size >= maxDevicesCap) evictStale(now);
  presence.set(hb.installId, {
    ...hb,
    city: current?.city ?? null,
    region: current?.region ?? null,
    country: current?.country ?? null,
    firstSeen: current?.firstSeen ?? now,
    lastSeen: now,
    dirty: true,
  });
}

export function setPresenceGeo(installId: string, geo: GeoInfo): void {
  const entry = presence.get(installId);
  if (!entry) return;
  entry.city = geo.city;
  entry.region = geo.region;
  entry.country = geo.country;
  entry.dirty = true;
}

function osLabel(entry: PresenceEntry): string | null {
  const parts = [entry.osName, entry.osRelease, entry.osArch].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

function matches(entry: PresenceEntry, filters: OnlineFilters): boolean {
  if (filters.platform && entry.platform !== filters.platform) return false;
  if (
    filters.region &&
    normalizeName(entry.region) !== normalizeName(filters.region)
  ) {
    return false;
  }
  if (
    filters.district &&
    normalizeName(entry.district) !== normalizeName(filters.district)
  ) {
    return false;
  }
  if (filters.q) {
    const needle = normalizeName(filters.q);
    const haystack = normalizeName(
      [entry.church, entry.district, entry.city].filter(Boolean).join(" "),
    );
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function listOnline(
  now = Date.now(),
  filters: OnlineFilters = {},
): OnlineList {
  const online = [...presence.values()]
    .filter((e) => now - e.lastSeen <= ONLINE_WINDOW_MS && matches(e, filters))
    .sort((a, b) => b.lastSeen - a.lastSeen);

  const byPlatform: Record<string, number> = {};
  let identified = 0;
  for (const e of online) {
    byPlatform[e.platform] = (byPlatform[e.platform] ?? 0) + 1;
    if (e.partnerId !== null) identified++;
  }

  return {
    totals: { online: online.length, identified, by_platform: byPlatform },
    devices: online.map((e) => ({
      install_id_short: e.installId.slice(0, 6),
      platform: e.platform,
      app_version: e.appVersion,
      os: osLabel(e),
      district: e.district,
      church: e.church,
      city: e.city,
      region: e.region,
      country: e.country,
      identified: e.partnerId !== null,
      first_seen: new Date(e.firstSeen).toISOString(),
      last_seen: new Date(e.lastSeen).toISOString(),
    })),
  };
}

type Db = ReturnType<typeof getDb>;

/** Grava em lote (uma transação) só os registros alterados. Retorna quantos. */
export function flushPresence(db: Db = getDb()): number {
  const dirty = [...presence.values()].filter((e) => e.dirty);
  if (dirty.length === 0) return 0;

  const upsert = db.prepare(
    `INSERT INTO device_presence (
       install_id, platform, app_version, os_name, os_release, os_arch,
       locale, timezone, district, church, city, region, country,
       partner_id, first_seen, last_seen
     ) VALUES (
       @installId, @platform, @appVersion, @osName, @osRelease, @osArch,
       @locale, @timezone, @district, @church, @city, @region, @country,
       @partnerId, @firstSeen, @lastSeen
     )
     ON CONFLICT(install_id) DO UPDATE SET
       platform = excluded.platform, app_version = excluded.app_version,
       os_name = excluded.os_name, os_release = excluded.os_release,
       os_arch = excluded.os_arch, locale = excluded.locale,
       timezone = excluded.timezone, district = excluded.district,
       church = excluded.church, city = excluded.city,
       region = excluded.region, country = excluded.country,
       partner_id = excluded.partner_id, last_seen = excluded.last_seen`,
  );

  const write = db.transaction((rows: PresenceEntry[]) => {
    for (const e of rows) {
      upsert.run({
        installId: e.installId,
        platform: e.platform,
        appVersion: e.appVersion,
        osName: e.osName,
        osRelease: e.osRelease,
        osArch: e.osArch,
        locale: e.locale,
        timezone: e.timezone,
        district: e.district,
        church: e.church,
        city: e.city,
        region: e.region,
        country: e.country,
        partnerId: e.partnerId,
        firstSeen: new Date(e.firstSeen).toISOString(),
        lastSeen: new Date(e.lastSeen).toISOString(),
      });
    }
  });
  write(dirty);
  for (const e of dirty) e.dirty = false;
  return dirty.length;
}

interface PresenceRow {
  install_id: string;
  platform: string;
  app_version: string | null;
  os_name: string | null;
  os_release: string | null;
  os_arch: string | null;
  locale: string | null;
  timezone: string | null;
  district: string | null;
  church: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  partner_id: number | null;
  first_seen: string;
  last_seen: string;
}

/** Boot: repõe no Map quem ainda está dentro da janela de online. */
export function loadRecentPresence(now = Date.now(), db: Db = getDb()): number {
  const cutoff = new Date(now - ONLINE_WINDOW_MS).toISOString();
  const rows = db
    .prepare("SELECT * FROM device_presence WHERE last_seen >= ?")
    .all(cutoff) as PresenceRow[];
  for (const r of rows) {
    if (presence.has(r.install_id)) continue;
    presence.set(r.install_id, {
      installId: r.install_id,
      platform: r.platform,
      appVersion: r.app_version,
      osName: r.os_name,
      osRelease: r.os_release,
      osArch: r.os_arch,
      locale: r.locale,
      timezone: r.timezone,
      district: r.district,
      church: r.church,
      city: r.city,
      region: r.region,
      country: r.country,
      partnerId: r.partner_id,
      firstSeen: Date.parse(r.first_seen),
      lastSeen: Date.parse(r.last_seen),
      dirty: false,
    });
  }
  return rows.length;
}

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * Boot da API: repõe do banco quem está online, grava em lote a cada
 * `intervalMs` e, no desligamento (SIGTERM/SIGINT), grava o pendente e
 * devolve o sinal ao comportamento padrão (o processo encerra como antes).
 * Falha de banco só loga — telemetria nunca derruba a API.
 */
export function startPresencePersistence(
  intervalMs = 60_000,
  db?: Db,
): () => void {
  const safeFlush = () => {
    try {
      flushPresence(db ?? getDb());
    } catch (e) {
      console.error("[presence] flush falhou (não-fatal):", e);
    }
  };

  try {
    loadRecentPresence(Date.now(), db ?? getDb());
  } catch (e) {
    console.error("[presence] carga inicial falhou (não-fatal):", e);
  }

  const timer = setInterval(safeFlush, intervalMs);
  timer.unref?.();

  const handlers = new Map<NodeJS.Signals, () => void>();
  const stop = () => {
    clearInterval(timer);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    handlers.clear();
  };
  for (const signal of SIGNALS) {
    const handler = () => {
      safeFlush();
      stop();
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return stop;
}
