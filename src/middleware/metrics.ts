/**
 * Métricas Prometheus — /metrics exposto para o Prometheus da VM Oracle.
 * Issue: pipeline autônomo 02/10 (Rafael pediu painéis de latência/erros/rate-limit no Grafana).
 *
 * Design (mesma disciplina do telemetry.ts — structurally incapaz de derrubar a API):
 *   - `await next()` primeiro; coleta pós-next, try/catch total.
 *   - Rota de baixa cardinalidade: "METHOD rota-registrada" (nunca URL crua —
 *     evita séries explosivas com IDs na URL).
 *   - /metrics NÃO passa pelo próprio coletor (self-scrape não conta request).
 *   - Sem auth no /metrics: só valores agregados e labels de rota; o bind do
 *     container é interno (Prometheus da VM scrapeia via rede interna/tailnet).
 *
 * Métricas:
 *   http_requests_total{method,route,status}     — contador por rota/status
 *   http_request_duration_seconds{method,route}  — histograma de latência (p50/p95/p99)
 *   http_errors_total{method,route}              — contador de 5xx
 *   rate_limit_blocked_total{route}              — bloqueios do rateLimit (SEC-7 telemetria)
 *   antibot_blocked_total{reason}                — bloqueios do antiBot
 *   process_* / nodejs_*                         — default do prom-client
 */
import { register, Counter, Histogram, collectDefaultMetrics } from "prom-client";
import type { Context, Next } from "hono";

// evita duplo registro em hot-reload/testes
if (!register.getSingleMetric("http_requests_total")) {
  collectDefaultMetrics({ prefix: "node_" });
}

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total de requests por método/rota/status",
  labelNames: ["method", "route", "status"] as const,
});

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Latência de request por método/rota",
  labelNames: ["method", "route"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpErrorsTotal = new Counter({
  name: "http_errors_total",
  help: "Total de respostas 5xx por método/rota",
  labelNames: ["method", "route"] as const,
});

export const rateLimitBlockedTotal = new Counter({
  name: "rate_limit_blocked_total",
  help: "Requests bloqueados pelo rate limit",
  labelNames: ["route"] as const,
});

export const antiBotBlockedTotal = new Counter({
  name: "antibot_blocked_total",
  help: "Requests bloqueados pelo antiBot",
  labelNames: ["reason"] as const,
});

/** Rotas conhecidas — reduz cardinalidade (URL crua vira template). */
function routeTemplate(path: string): string {
  if (!path.startsWith("/v1/") && !path.startsWith("/api/")) return path;
  // /v1/custom/abc123/sync → /v1/custom/:id/sync  (troca segmentos com ID por :id)
  return path
    .split("/")
    .map((seg) =>
      /^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || /^[A-Za-z0-9_-]{20,}$/.test(seg)
        ? ":id"
        : seg
    )
    .join("/");
}

/** True se a rota deve ser excluída da coleta (self-scrape, health). */
function skip(path: string): boolean {
  return path === "/metrics" || path === "/v1/health";
}

export async function metricsMiddleware(c: Context, next: Next) {
  if (skip(c.req.path)) return next();

  const method = c.req.method;
  const route = routeTemplate(c.req.path);
  const start = process.hrtime.bigint();
  let status = 500;

  try {
    await next();
    status = c.res.status;
  } finally {
    try {
      const dur = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = { method, route, status: String(status) };
      httpRequestsTotal.inc(labels);
      httpRequestDuration.observe({ method, route }, dur);
      if (status >= 500) httpErrorsTotal.inc({ method, route });
    } catch {
      // coleta de métricas JAMAIS derruba request (mesma disciplina do telemetry.ts)
    }
  }
}

export function incRateLimitBlocked(route: string) {
  try {
    rateLimitBlockedTotal.inc({ route: routeTemplate(route) });
  } catch {}
}

export function incAntiBotBlocked(reason: string) {
  try {
    antiBotBlockedTotal.inc({ reason });
  } catch {}
}

export async function metricsHandler(c: Context) {
  c.header("Content-Type", register.contentType);
  return c.body(await register.metrics());
}
