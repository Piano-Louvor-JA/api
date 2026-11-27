/**
 * Histórico 90d, rankings e mapa de telemetria
 * (api/.planning/telemetria-historico).
 *
 * Fonte principal: último estado em `device_presence` com last_seen na janela.
 * `device_presence_daily` guarda snapshot diário por dimensão (séries futuras).
 * Passiva / Sem token não entra (sem church/geo estável no SQLite).
 */

import { getDb } from "../db/connection.js";
import {
  listOnlineIds,
  listPresenceSnapshot,
  normalizeName,
  ONLINE_WINDOW_MS,
} from "./devicePresence.js";

/** Janela pública do painel (3 meses). */
export const HISTORY_WINDOW_DAYS = 90;

/** Folga além de 90d antes do purge (evita apagar na virada do dia). */
export const HISTORY_PURGE_DAYS = 100;

export type RankingDim =
  | "church"
  | "district"
  | "city"
  | "region"
  | "country"
  | "os";

export const RANKING_DIMS: readonly RankingDim[] = [
  "church",
  "district",
  "city",
  "region",
  "country",
  "os",
] as const;

type Db = ReturnType<typeof getDb>;

interface PresenceRow {
  install_id: string;
  platform: string;
  os_name: string | null;
  district: string | null;
  church: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  last_seen: string;
}

function dayUtc(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function cutoffIso(days: number, now: number): string {
  return new Date(now - days * 86_400_000).toISOString();
}

function loadSeenRows(days: number, now: number, db: Db): PresenceRow[] {
  const cutoffMs = now - days * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString();
  const fromDb = db
    .prepare(
      `SELECT install_id, platform, os_name, district, church, city, region, country, last_seen
       FROM device_presence
       WHERE last_seen >= ?`,
    )
    .all(cutoff) as PresenceRow[];

  // Memória (ainda não flushed) prevalece sobre o SQLite no mesmo install_id.
  const byId = new Map<string, PresenceRow>();
  for (const r of fromDb) byId.set(r.install_id, r);
  for (const e of listPresenceSnapshot()) {
    if (e.lastSeen < cutoffMs) continue;
    byId.set(e.installId, {
      install_id: e.installId,
      platform: e.platform,
      os_name: e.osName,
      district: e.district,
      church: e.church,
      city: e.city,
      region: e.region,
      country: e.country,
      last_seen: new Date(e.lastSeen).toISOString(),
    });
  }
  return [...byId.values()];
}

function dimValue(
  row: PresenceRow,
  dim: RankingDim,
): { key: string; label: string } | null {
  let raw: string | null = null;
  switch (dim) {
    case "church":
      raw = row.church;
      break;
    case "district":
      raw = row.district;
      break;
    case "city":
      raw = row.city;
      break;
    case "region":
      raw = row.region;
      break;
    case "country":
      raw = row.country;
      break;
    case "os":
      raw = row.os_name;
      break;
  }
  const key = normalizeName(raw);
  if (!key) return null;
  return { key, label: (raw ?? "").trim() };
}

export interface HistorySummary {
  period_days: number;
  generated_at: string;
  online_window_min: number;
  totals: {
    seen: number;
    online: number;
    offline_seen: number;
    with_church: number;
    with_geo: number;
    by_platform: Record<string, number>;
  };
}

export function summarizeHistory(
  days = HISTORY_WINDOW_DAYS,
  now = Date.now(),
  db: Db = getDb(),
): HistorySummary {
  const rows = loadSeenRows(days, now, db);
  const onlineIds = listOnlineIds(now);
  const byPlatform: Record<string, number> = {};
  let withChurch = 0;
  let withGeo = 0;
  let online = 0;
  for (const r of rows) {
    byPlatform[r.platform] = (byPlatform[r.platform] ?? 0) + 1;
    if (normalizeName(r.church)) withChurch++;
    if (normalizeName(r.city) || normalizeName(r.region)) withGeo++;
    if (onlineIds.has(r.install_id)) online++;
  }
  return {
    period_days: days,
    generated_at: new Date(now).toISOString(),
    online_window_min: ONLINE_WINDOW_MS / 60_000,
    totals: {
      seen: rows.length,
      online,
      offline_seen: rows.length - online,
      with_church: withChurch,
      with_geo: withGeo,
      by_platform: byPlatform,
    },
  };
}

export interface RankingItem {
  key: string;
  label: string;
  devices: number;
  online: number;
}

export interface RankingsResult {
  period_days: number;
  by: RankingDim;
  generated_at: string;
  items: RankingItem[];
}

export function listRankings(
  by: RankingDim,
  days = HISTORY_WINDOW_DAYS,
  limit = 50,
  now = Date.now(),
  db: Db = getDb(),
): RankingsResult {
  const rows = loadSeenRows(days, now, db);
  const onlineIds = listOnlineIds(now);
  const buckets = new Map<
    string,
    {
      label: string;
      labelCounts: Map<string, number>;
      devices: number;
      online: number;
    }
  >();

  for (const r of rows) {
    const v = dimValue(r, by);
    if (!v) continue;
    let b = buckets.get(v.key);
    if (!b) {
      b = { label: v.label, labelCounts: new Map(), devices: 0, online: 0 };
      buckets.set(v.key, b);
    }
    b.devices++;
    if (onlineIds.has(r.install_id)) b.online++;
    b.labelCounts.set(v.label, (b.labelCounts.get(v.label) ?? 0) + 1);
    // Mantém o rótulo mais comum.
    let best = b.label;
    let bestN = b.labelCounts.get(best) ?? 0;
    for (const [lab, n] of b.labelCounts) {
      if (n > bestN) {
        best = lab;
        bestN = n;
      }
    }
    b.label = best;
  }

  const items = [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      label: b.label,
      devices: b.devices,
      online: b.online,
    }))
    .sort(
      (a, b) =>
        b.devices - a.devices ||
        b.online - a.online ||
        a.label.localeCompare(b.label, "pt-BR"),
    )
    .slice(0, Math.max(1, Math.min(limit, 200)));

  return {
    period_days: days,
    by,
    generated_at: new Date(now).toISOString(),
    items,
  };
}

export interface MapPoint {
  city: string | null;
  region: string;
  country: string;
  devices: number;
  online: number;
  /** true se pelo menos um dispositivo do ponto está online agora. */
  is_online: boolean;
}

export interface MapResult {
  period_days: number;
  country: string;
  generated_at: string;
  online_window_min: number;
  points: MapPoint[];
}

export function listMapPoints(
  days = HISTORY_WINDOW_DAYS,
  country = "BR",
  now = Date.now(),
  db: Db = getDb(),
): MapResult {
  const rows = loadSeenRows(days, now, db);
  const onlineIds = listOnlineIds(now);
  const countryNorm = normalizeName(country) || "br";
  const buckets = new Map<
    string,
    {
      city: string | null;
      region: string;
      country: string;
      devices: number;
      online: number;
    }
  >();

  for (const r of rows) {
    if (normalizeName(r.country) !== countryNorm) continue;
    const region = (r.region ?? "").trim();
    if (!region) continue;
    const city = (r.city ?? "").trim() || null;
    const key = `${normalizeName(region)}|${normalizeName(city)}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        city,
        region,
        country: (r.country ?? country).trim() || country,
        devices: 0,
        online: 0,
      };
      buckets.set(key, b);
    }
    b.devices++;
    if (onlineIds.has(r.install_id)) b.online++;
  }

  const points = [...buckets.values()]
    .map((b) => ({
      city: b.city,
      region: b.region,
      country: b.country,
      devices: b.devices,
      online: b.online,
      is_online: b.online > 0,
    }))
    .sort(
      (a, b) =>
        Number(b.is_online) - Number(a.is_online) ||
        b.devices - a.devices ||
        (a.city ?? "").localeCompare(b.city ?? "", "pt-BR"),
    );

  return {
    period_days: days,
    country: country.toUpperCase(),
    generated_at: new Date(now).toISOString(),
    online_window_min: ONLINE_WINDOW_MS / 60_000,
    points,
  };
}

/** Snapshot do dia UTC corrente a partir de quem teve last_seen hoje. */
export function snapshotDaily(now = Date.now(), db: Db = getDb()): number {
  const day = dayUtc(now);
  const start = `${day}T00:00:00.000Z`;
  const rows = db
    .prepare(
      `SELECT install_id, platform, os_name, district, church, city, region, country, last_seen
       FROM device_presence
       WHERE last_seen >= ?`,
    )
    .all(start) as PresenceRow[];

  const upsert = db.prepare(
    `INSERT INTO device_presence_daily (day, dim, key_norm, label, devices)
     VALUES (@day, @dim, @keyNorm, @label, @devices)
     ON CONFLICT(day, dim, key_norm) DO UPDATE SET
       label = excluded.label,
       devices = excluded.devices`,
  );

  let written = 0;
  const write = db.transaction(() => {
    for (const dim of RANKING_DIMS) {
      const buckets = new Map<
        string,
        { label: string; labelCounts: Map<string, number>; devices: number }
      >();
      for (const r of rows) {
        const v = dimValue(r, dim);
        if (!v) continue;
        let b = buckets.get(v.key);
        if (!b) {
          b = { label: v.label, labelCounts: new Map(), devices: 0 };
          buckets.set(v.key, b);
        }
        b.devices++;
        b.labelCounts.set(v.label, (b.labelCounts.get(v.label) ?? 0) + 1);
        let best = b.label;
        let bestN = b.labelCounts.get(best) ?? 0;
        for (const [lab, n] of b.labelCounts) {
          if (n > bestN) {
            best = lab;
            bestN = n;
          }
        }
        b.label = best;
      }
      for (const [keyNorm, b] of buckets) {
        upsert.run({
          day,
          dim,
          keyNorm,
          label: b.label,
          devices: b.devices,
        });
        written++;
      }
    }
  });
  write();
  return written;
}

/** Remove presença e daily fora da folga de retenção. */
export function purgeOldPresence(
  now = Date.now(),
  db: Db = getDb(),
): { presence: number; daily: number } {
  const presenceCutoff = cutoffIso(HISTORY_PURGE_DAYS, now);
  const dailyCutoff = dayUtc(now - HISTORY_PURGE_DAYS * 86_400_000);
  const presence = db
    .prepare("DELETE FROM device_presence WHERE last_seen < ?")
    .run(presenceCutoff).changes;
  const daily = db
    .prepare("DELETE FROM device_presence_daily WHERE day < ?")
    .run(dailyCutoff).changes;
  return { presence, daily };
}

/**
 * Chamado no timer de persistência: atualiza o snapshot do dia e limpa
 * retenção. Falhas só logam no caller.
 */
export function maintainHistory(now = Date.now(), db: Db = getDb()): void {
  snapshotDaily(now, db);
  purgeOldPresence(now, db);
}
