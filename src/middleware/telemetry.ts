/**
 * SEC-6 Fase 0 — telemetria de requests por IP/min (LOG-ONLY).
 * Issue: Piano-louvor-JA/api#127
 *
 * Este middleware NÃO bloqueia, NÃO limita e NÃO altera nenhuma resposta.
 * Ele existe exclusivamente para coletar dados reais de tráfego (2–4 semanas)
 * antes de qualquer decisão de threshold de rate limit (Fase 1 — fora do
 * escopo). Lição crítica da issue: rate limit mal dimensionado JÁ QUEBROU a
 * API num sábado; dados antes de limites.
 *
 * Design (structuralmente incapaz de negar request):
 *   - `await next()` SEMPRE roda primeiro; o código depois dele é contagem
 *     pura (Map increment) e nunca lança para fora (try/catch total).
 *   - Nenhuma resposta é construída, modificada ou retornada aqui.
 *   - Expira buckets antigos (MAX_BUCKETS) para não crescer sem bound.
 *
 * Formato do log agregado (1 linha por IP/minuto, post-next):
 *   [telemetry] {"minute":"2026-09-29T12:34","ip":"1.2.3.4","total":12,
 *                "routes":{"GET /v1/musics":8,"GET /v1/albums":4}}
 *
 * O relatório p95/p99 lê essas linhas: scripts/analyze-telemetry.ts
 *
 * Env:
 *   TELEMETRY_DISABLED=true  → desliga a coleta (kill switch sem deploy
 *                              — log-only, zero risco a tráfego)
 */

import type { Context, Next } from "hono";

/** Chave de baixa cardinalidade: "METHOD rota-registrada" (não URL crua). */
type RouteKey = string;

interface Bucket {
  /** minute em UTC ISO: YYYY-MM-DDTHH:MM */
  minute: string;
  ip: string;
  /** plataforma do cliente (X-Client-Platform), ex: desktop-windows, web, apk-android */
  platform: string;
  total: number;
  routes: Map<RouteKey, number>;
}

/**
 * Estado por (minute|ip). Em memória — suficiente para instância única
 * (mesma abordagem do rateLimit.ts). Chaves expiram ao virar o minuto e
 * via marcação MAX_BUCKETS.
 */
const buckets = new Map<string, Bucket>();

/** Hard cap defensivo: ~10k IPs ativos/min é ordens de grandeza acima do
 *  tráfego real; protege memória se a expiração por minuto falhar. */
const MAX_BUCKETS = 10_000;

let disabled = process.env.TELEMETRY_DISABLED === "true";

export function isTelemetryDisabled(): boolean {
  return disabled;
}

/** Reseta estado interno (testes). */
export function resetTelemetryState(): void {
  buckets.clear();
  disabled = process.env.TELEMETRY_DISABLED === "true";
}

function currentMinuteKey(now = new Date()): string {
  // ISO UTC truncado no minuto: "2026-09-29T12:34"
  return now.toISOString().slice(0, 16);
}

function expireOldMinutes(current: string): void {
  // Mantém apenas a janela corrente (o log por minuto já foi emitido).
  for (const key of buckets.keys()) {
    if (buckets.get(key)?.minute !== current) {
      buckets.delete(key);
    }
  }
}

function clientIp(c: Context): string {
  // Ordem alinhada ao header usado pelo rateLimit.ts / Cloudflare Tunnel.
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = c.req.header("x-real-ip");
  if (real) return real.trim();
  return c.req.raw.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

const VALID_PLATFORMS = new Set([
  "desktop-windows",
  "desktop-mac",
  "desktop-linux",
  "web",
  "apk-android",
  "apk-ios",
  "palco-webos",
  "palco-tizen",
  "palco-androidtv",
]);

/**
 * Plataforma do cliente: header X-Client-Platform (padrão da org, definido
 * nos 4 clientes) com fallback heurístico por User-Agent quando o header
 * ainda não existe (transição até todos os apps atualizarem).
 */
function clientPlatform(c: Context): string {
  const declared = c.req.header("x-client-platform")?.trim().toLowerCase();
  if (declared && VALID_PLATFORMS.has(declared)) return declared;
  const ua = c.req.header("user-agent") || "";
  if (/Android/i.test(ua)) return "apk-android";
  if (/iPhone|iPad|iOS/i.test(ua)) return "apk-ios";
  if (/Electron/i.test(ua)) {
    if (/Windows/i.test(ua)) return "desktop-windows";
    if (/Mac/i.test(ua)) return "desktop-mac";
    return "desktop-linux";
  }
  return "unknown";
}

/**
 * Middleware log-only. SEMPRE chama next(); depois apenas conta.
 * Qualquer erro interno é engolido — telemetria nunca derruba request.
 */
export async function telemetryMiddleware(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  await next();

  try {
    if (disabled) return;

    const minute = currentMinuteKey();
    const ip = clientIp(c);
    const platform = clientPlatform(c);
    // routePath = pattern registrado (ex: "/v1/musics/:id") → cardinalidade
    // fixa por rota. Fora de handler registrado (compat paths) cai no path cru.
    const route = c.req.routePath || c.req.path;
    const routeKey = `${c.req.method} ${route}`;

    const key = `${minute}|${ip}|${platform}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) expireOldMinutes(minute);
      bucket = { minute, ip, platform, total: 0, routes: new Map() };
      buckets.set(key, bucket);
    }
    bucket.total++;
    bucket.routes.set(routeKey, (bucket.routes.get(routeKey) ?? 0) + 1);

    // Log estruturado agregado: 1 linha por IP/minuto (não por request).
    console.log(
      `[telemetry] ${JSON.stringify({
        minute,
        ip,
        platform: bucket.platform,
        total: bucket.total,
        routes: Object.fromEntries(bucket.routes),
      })}`,
    );
  } catch {
    // Engolido deliberadamente: log-only nunca impacta tráfego.
  }
}
