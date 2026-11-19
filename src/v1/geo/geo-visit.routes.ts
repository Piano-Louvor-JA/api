/**
 * SPEC piano-site-telemetria-v2 v1.0.0 (RF-A1..A4) + ADR-001.
 *
 * Telemetria de audiência do site (LGPD-compliant) — porte do pipeline
 * Nitro do piano-site (server/utils/geo-visit.ts + middleware), que nunca
 * roda em produção porque o hosting é SSG estático.
 *
 * - POST /v1/geo/visit — beacon público do site. País extraído de headers
 *   CDN (x-hcdn-country > x-visitor-country > cf-ipcountry > x-vercel-ip-
 *   country); dedup diária por hash SHA-256(ip|ua+dia, salt opcional) que
 *   NUNCA é persistido; grava geoStats/{YYYY-MM-DD} countries.{país} += 1
 *   (Firestore, mesmo schema histórico da v1). Sem país/IP → 204 sem efeito.
 *   Rate-limit leve em memória (20/min por IP).
 * - GET /v1/geo/stats — agregado {totalVisits, days, countries, telemetryMode},
 *   atrás do gate adminAuth fail-closed (ADMIN_EMAILS). Fonte única do
 *   dashboard do site.
 */

import { createHash } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { adminAuth } from "../custom/admin.middleware.js";
import { getFirebaseApp } from "../custom/firebase-auth.middleware.js";

export function countryFromHeaders(
  headers: Record<string, string | undefined>,
): string | null {
  const candidates = [
    headers["x-hcdn-country"],
    headers["x-visitor-country"],
    headers["cf-ipcountry"],
    headers["x-vercel-ip-country"],
  ];
  for (const c of candidates) {
    if (c && /^[A-Za-z]{2}$/.test(c.trim())) return c.trim().toUpperCase();
  }
  return null;
}

export function clientIpFrom(
  headers: Record<string, string | undefined>,
): string | null {
  const xff = headers["x-forwarded-for"];
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers["x-real-ip"]?.trim() || null;
}

function geoDayBucket(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

// ── Dedup + rate-limit em memória (por instância) ────────────────
const seenVisitors = new Set<string>();
const SEEN_MAX = 10_000;
const rateBuckets = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;

export function resetGeoVisitStateForTests(): void {
  seenVisitors.clear();
  rateBuckets.clear();
  cachedStats = null;
}

let firestoreOverride: ReturnType<typeof getFirestore> | null = null;
/** Test-hook: injeta Firestore fake (em memória). */
export function setGeoVisitFirestoreForTests(
  db: ReturnType<typeof getFirestore> | null,
): void {
  firestoreOverride = db;
}

async function getDb(): Promise<ReturnType<typeof getFirestore>> {
  if (firestoreOverride) return firestoreOverride;
  return getFirestore(await getFirebaseApp());
}

// ── Rate-limit ──────────────────────────────────────────────────
export function checkRateLimit(ip: string, now = Date.now()): boolean {
  const arr = (rateBuckets.get(ip) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (arr.length >= RATE_MAX) {
    rateBuckets.set(ip, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(ip, arr);
  return true;
}

// ── Dedup diária (visitorId efêmero, nunca persistido) ──────────
export function visitorIdFor(
  ip: string,
  ua: string,
  day: string,
  salt: string,
): string {
  const hash = createHash("sha256")
    .update(`${ip}|${ua}|${day}|${salt}`)
    .digest("hex");
  return `${day}:${hash.slice(0, 16)}`;
}

// ── Gravação ────────────────────────────────────────────────────
export async function recordVisit(input: {
  country: string;
  ip: string;
  ua: string;
  salt: string;
  day?: string;
}): Promise<"counted" | "dedup" | "no-country" | "no-ip" | "rate-limited"> {
  if (!input.country) return "no-country";
  if (!input.ip) return "no-ip";
  if (!checkRateLimit(input.ip)) return "rate-limited";

  const day = input.day ?? geoDayBucket();
  const visitorId = visitorIdFor(input.ip, input.ua, day, input.salt);
  if (seenVisitors.has(visitorId)) return "dedup";
  seenVisitors.add(visitorId);
  if (seenVisitors.size > SEEN_MAX) {
    const first = seenVisitors.values().next().value;
    if (first !== undefined) seenVisitors.delete(first);
  }

  const db = await getDb();
  await db
    .collection("geoStats")
    .doc(day)
    .set(
      { day, countries: { [input.country]: FieldValue.increment(1) } },
      { merge: true },
    );
  return "counted";
}

// ── Leitura agregada (RF-A2) ────────────────────────────────────
export interface GeoStatsResult {
  totalVisits: number;
  days: number;
  countries: Array<{ country: string; visits: number }>;
  telemetryMode: "salted" | "unsalted";
}

let cachedStats: { data: GeoStatsResult; ts: number } | null = null;
const STATS_TTL_MS = 60_000;

export async function getGeoStats(days = 30): Promise<GeoStatsResult> {
  if (
    cachedStats &&
    cachedStats.data.days === days &&
    Date.now() - cachedStats.ts < STATS_TTL_MS
  ) {
    return cachedStats.data;
  }
  const db = await getDb();
  const cutoff = geoDayBucket(
    new Date(Date.now() - days * 24 * 60 * 60 * 1000),
  );
  const snapshot = await db
    .collection("geoStats")
    .where("day", ">=", cutoff)
    .orderBy("day", "asc")
    .get();

  const byCountry = new Map<string, number>();
  let totalVisits = 0;
  for (const doc of snapshot.docs) {
    const countries = (doc.data().countries ?? {}) as Record<string, number>;
    for (const [country, visits] of Object.entries(countries)) {
      const n = Number(visits) || 0;
      totalVisits += n;
      byCountry.set(country, (byCountry.get(country) ?? 0) + n);
    }
  }
  const data: GeoStatsResult = {
    totalVisits,
    days,
    countries: [...byCountry.entries()]
      .map(([country, visits]) => ({ country, visits }))
      .sort((a, b) => b.visits - a.visits),
    telemetryMode: process.env.GEO_SALT ? "salted" : "unsalted",
  };
  cachedStats = { data, ts: Date.now() };
  return data;
}

// ── Rotas ───────────────────────────────────────────────────────
export const geoVisitRoutes = new OpenAPIHono<{
  Variables: { tenantId: string };
}>();

const visitRoute = createRoute({
  method: "post",
  path: "/visit",
  tags: ["geo"],
  description:
    "Beacon de visita do site (LGPD: agregado por país, hash de dedup nunca persistido). Sempre 204.",
  responses: {
    204: { description: "Registrado (ou silenciosamente ignorado)" },
  },
});

geoVisitRoutes.openapi(visitRoute, async (c) => {
  const h = c.req.raw.headers;
  const headers: Record<string, string | undefined> = {};
  for (const key of [
    "x-hcdn-country",
    "x-visitor-country",
    "cf-ipcountry",
    "x-vercel-ip-country",
    "x-forwarded-for",
    "x-real-ip",
    "user-agent",
  ]) {
    headers[key] = h.get(key) ?? undefined;
  }
  const salt = process.env.GEO_SALT ?? "";
  try {
    await recordVisit({
      country: countryFromHeaders(headers) ?? "",
      ip: clientIpFrom(headers) ?? "",
      ua: headers["user-agent"] ?? "",
      salt,
    });
  } catch {
    // telemetria é best-effort — nunca falha a request
  }
  return c.body(null, 204);
});

const statsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["geo"],
  description:
    "Agregado de audiência por país (30d default). Gate ADMIN_EMAILS fail-closed.",
  request: {
    query: z.object({
      days: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            totalVisits: z.number(),
            days: z.number(),
            countries: z.array(
              z.object({ country: z.string(), visits: z.number() }),
            ),
            telemetryMode: z.enum(["salted", "unsalted"]),
          }),
        },
      },
      description: "Agregado",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Não autenticado",
    },
    403: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Sem papel",
    },
  },
});

geoVisitRoutes.use("/stats", adminAuth);

geoVisitRoutes.openapi(statsRoute, async (c) => {
  const rawDays = Number(c.req.query("days"));
  const days =
    Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 30;
  const stats = await getGeoStats(days);
  return c.json(stats, 200);
});
