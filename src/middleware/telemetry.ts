import { createRoute, z } from "@hono/zod-openapi";
import { Context, type Next } from "hono";

interface TelemetryMetrics {
  minute: string; // ISO minute format
  ip: string;
  method: string;
  path: string;
  count: number;
}

const metrics: TelemetryMetrics[] = [];
const lock = new Map<string, boolean>();

export function telemetryMiddleware(): (c: Context, next: Next) => Promise<Response | void> {
  return async (c, next) => {
    const start = Date.now();
    const ip = c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0] ?? (c.req.raw.headers.get("cf-connecting-ip") || "unknown");
    const method = c.req.method;
    const path = c.req.path;
    const minuteKey = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM

    await next();

    const duration = Date.now() - start;

    // Simplified counter (unique key per request)
    const lockKey = `${ip}:${minuteKey}:${path}`;
    if (lock.get(lockKey)) return;
    lock.set(lockKey, true);

    try {
      const existing = metrics.find(m => m.minute === minuteKey && m.ip === ip && m.method === method && m.path === path);
      if (existing) {
        existing.count++;
      } else {
        metrics.push({
          minute: minuteKey,
          ip,
          method,
          path,
          count: 1,
        });
      }
    } finally {
      lock.delete(lockKey);
    }
  };
}

export function getTelemetryMetrics(): TelemetryMetrics[] {
  return [...metrics];
}

export const telemetryRoute = createRoute({
  method: "get",
  path: "/v1/telemetry/debug",
  summary: "Debug de telemetria",
  description: "Exporta métricas agregadas por IP/min (só em staging/dev)",
  tags: ["debug"],
  responses: {
    200: {
      description: "Lista de métricas",
      content: {
        "application/json": {
          schema: z.array(z.object({
            minute: z.string(),
            ip: z.string(),
            method: z.string(),
            path: z.string(),
            count: z.number(),
          })),
        },
      },
    },
  },
});

// Script de análise (Node puro, só exportar para CLI)
export function analyzeByMinute(metrics: TelemetryMetrics[]): {
  total: number;
  byMinute: Record<string, {
    totalRequests: number;
    topIPs: Array<{ ip: string; count: number }>;
    topPaths: Array<{ path: string; count: number }>;
  }>;
  percentiles: {
    p95: number;
    p99: number;
  };
} {
  const byMinute: Record<string, TelemetryMetrics[]> = {};
  metrics.forEach(m => {
    if (!byMinute[m.minute]) byMinute[m.minute] = [];
    byMinute[m.minute].push(m);
  });

  const allCounts = metrics.map(m => m.count).sort((a, b) => a - b);
  const p95 = allCounts[Math.floor(allCounts.length * 0.95)] || 0;
  const p99 = allCounts[Math.floor(allCounts.length * 0.99)] || 0;

  return {
    total: metrics.length,
    byMinute: Object.fromEntries(Object.entries(byMinute).map(([minute, metrics]) => {
      const ipCounts = metrics.reduce((acc, m) => {
        acc[m.ip] = (acc[m.ip] || 0) + m.count;
        return acc;
      }, {} as Record<string, number>);
      const pathCounts = metrics.reduce((acc, m) => {
        acc[m.path] = (acc[m.path] || 0) + m.count;
        return acc;
      }, {} as Record<string, number>);

      return [minute, {
        totalRequests: metrics.reduce((sum, m) => sum + m.count, 0),
        topIPs: Object.entries(ipCounts)
          .map(([ip, count]) => ({ ip, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5),
        topPaths: Object.entries(pathCounts)
          .map(([path, count]) => ({ path, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5),
      }];
    })),
    percentiles: { p95, p99 },
  };
}