/**
 * SPEC piano-site-telemetria-v2 v1.0.0 (RF-A3).
 *
 * Séries temporais do dashboard admin — porte do endpoint Nitro
 * server/api/admin/timeseries.get.ts do piano-site, que nunca roda em
 * produção (hosting SSG).
 *
 * GET /v1/geo/timeseries?period=7d|30d|12m — atrás do adminAuth.
 * Fontes:
 * - visits: Firestore geoStats (doc/dia, countries.{país}) — soma por bucket.
 * - downloads: Firestore downloadSnapshots (doc/dia { day, total }) — TOTAL
 *   por dia (não delta); buckets mensais usam o último snapshot do mês.
 * - subscribers: Buttondown API (delta de novos assinantes por bucket) —
 *   opcional: sem BUTTONDOWN_API_KEY a série vem zerada (fail-soft).
 * Resposta: { period, buckets, visits, subscribers, downloads } — mesmo
 * contrato que o site já consome (TimeseriesResponse).
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { adminAuth } from "../custom/admin.middleware.js";
import { firebaseAuth } from "../custom/firebase-auth.middleware.js";

// ── Períodos/buckets (paridade com timeseries-buckets.ts do site) ──
export type Period = "7d" | "30d" | "12m";

export function resolvePeriod(raw: string | undefined): Period {
  return raw === "7d" || raw === "30d" || raw === "12m" ? raw : "30d";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function buildBuckets(period: Period): string[] {
  const out: string[] = [];
  const now = new Date();
  if (period === "12m") {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
      );
      out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`);
    }
  } else {
    const days = period === "7d" ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      out.push(dayKey(new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
    }
  }
  return out;
}

/** Match exato para dias, prefixo YYYY-MM para meses. */
function matchesBucket(bucket: string, day: string): boolean {
  return bucket.length === 7 ? day.startsWith(bucket) : day === bucket;
}

// ── Firestore (com test-hook igual ao geo-visit) ─────────────────
let firestoreOverride: ReturnType<typeof getFirestore> | null = null;
export function setTimeseriesFirestoreForTests(
  db: ReturnType<typeof getFirestore> | null,
): void {
  firestoreOverride = db;
}

async function getDb(): Promise<ReturnType<typeof getFirestore>> {
  if (firestoreOverride) return firestoreOverride;
  return getFirestore(await getFirebaseApp());
}

interface Point {
  key: string;
  value: number;
}

/** Agrega docs diários { day, countries } — soma dos países por bucket. */
export async function fetchVisitsSeries(buckets: string[]): Promise<Point[]> {
  if (buckets.length === 0) return [];
  const db = await getDb();
  const first = buckets.reduce((a, b) => (a < b ? a : b));
  const last = buckets.reduce((a, b) => (a > b ? a : b));
  const snap = await db
    .collection("geoStats")
    .where("day", ">=", first)
    .where("day", "<=", last + "\uf8ff")
    .get();

  const totals = new Map<string, number>(buckets.map((b) => [b, 0]));
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const day = typeof data.day === "string" ? data.day : doc.id;
    const countries = (data.countries ?? {}) as Record<string, unknown>;
    let sum = 0;
    for (const v of Object.values(countries)) {
      if (typeof v === "number") sum += v;
    }
    for (const bucket of buckets) {
      if (matchesBucket(bucket, day)) {
        totals.set(bucket, (totals.get(bucket) ?? 0) + sum);
        break;
      }
    }
  }
  return [...totals.entries()].map(([key, value]) => ({ key, value }));
}

/**
 * Série de downloads — snapshot é TOTAL acumulado do dia, não delta.
 * Diário: o próprio total do dia. Mensal: o último snapshot do mês
 * (total vigente no fim do mês).
 */
export async function fetchDownloadsSeries(
  buckets: string[],
): Promise<Point[]> {
  if (buckets.length === 0) return [];
  const db = await getDb();
  const first = buckets.reduce((a, b) => (a < b ? a : b));
  const last = buckets.reduce((a, b) => (a > b ? a : b));
  const snap = await db
    .collection("downloadSnapshots")
    .where("day", ">=", first)
    .where("day", "<=", last + "\uf8ff")
    .get();

  const byBucket = new Map<string, number>(buckets.map((b) => [b, 0]));
  const isMonthly = buckets[0]?.length === 7;
  const latest = new Map<string, { day: string; total: number }>();
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const day = typeof data.day === "string" ? data.day : doc.id;
    const total = typeof data.total === "number" ? data.total : 0;
    for (const bucket of buckets) {
      if (!matchesBucket(bucket, day)) continue;
      if (isMonthly) {
        const cur = latest.get(bucket);
        if (!cur || day > cur.day) latest.set(bucket, { day, total });
      } else {
        byBucket.set(bucket, total);
      }
      break;
    }
  }
  if (isMonthly) {
    for (const [bucket, cur] of latest) byBucket.set(bucket, cur.total);
  }
  return [...byBucket.entries()].map(([key, value]) => ({ key, value }));
}

// ── Buttondown (assinantes, fail-soft) ──────────────────────────
interface ButtondownSubscriber {
  email?: string;
  email_address?: string;
  creation_date?: string;
  created_at?: string;
}

interface SubPoint {
  email: string;
  createdAt: string;
}

export async function fetchSubscribers(): Promise<SubPoint[]> {
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key) return [];
  const subscribers: SubPoint[] = [];
  let url: string | null = "https://api.buttondown.com/v1/subscribers";
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Token ${key}` },
    });
    if (!res.ok) return subscribers;
    const body = (await res.json()) as {
      results?: ButtondownSubscriber[];
      next?: string | null;
    };
    for (const raw of body.results ?? []) {
      subscribers.push({
        email: raw.email ?? raw.email_address ?? "",
        createdAt: raw.creation_date ?? raw.created_at ?? "",
      });
    }
    url = body.next ?? null;
  }
  return subscribers;
}

export async function fetchSubscribersSeries(
  buckets: string[],
): Promise<Point[]> {
  if (buckets.length === 0) return [];
  const totals = new Map<string, number>(buckets.map((b) => [b, 0]));
  try {
    const subscribers = await fetchSubscribers();
    for (const sub of subscribers) {
      const day = sub.createdAt.slice(0, 10);
      for (const bucket of buckets) {
        if (matchesBucket(bucket, day)) {
          totals.set(bucket, (totals.get(bucket) ?? 0) + 1);
          break;
        }
      }
    }
  } catch {
    // fail-soft: sem Buttondown a série vem zerada
  }
  return [...totals.entries()].map(([key, value]) => ({ key, value }));
}

// ── Rotas ───────────────────────────────────────────────────────
export const geoTimeseriesRoutes = new OpenAPIHono<{
  Variables: { tenantId: string };
}>();

const timeseriesRoute = createRoute({
  method: "get",
  path: "/timeseries",
  tags: ["geo"],
  description:
    "Séries temporais do dashboard (visitas/downloads/assinantes) por período. Gate ADMIN_EMAILS fail-closed.",
  request: {
    query: z.object({
      period: z.enum(["7d", "30d", "12m"]).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            period: z.string(),
            buckets: z.array(z.string()),
            visits: z.array(z.object({ key: z.string(), value: z.number() })),
            subscribers: z.array(
              z.object({ key: z.string(), value: z.number() }),
            ),
            downloads: z.array(
              z.object({ key: z.string(), value: z.number() }),
            ),
          }),
        },
      },
      description: "Séries por bucket",
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

geoTimeseriesRoutes.use("/timeseries", firebaseAuth, adminAuth);

geoTimeseriesRoutes.openapi(timeseriesRoute, async (c) => {
  const period = resolvePeriod(c.req.query("period"));
  const buckets = buildBuckets(period);

  const [visits, downloads, subscribers] = await Promise.all([
    fetchVisitsSeries(buckets).catch(() =>
      buckets.map((key) => ({ key, value: 0 })),
    ),
    fetchDownloadsSeries(buckets).catch(() =>
      buckets.map((key) => ({ key, value: 0 })),
    ),
    fetchSubscribersSeries(buckets),
  ]);

  return c.json({ period, buckets, visits, subscribers, downloads }, 200);
});
