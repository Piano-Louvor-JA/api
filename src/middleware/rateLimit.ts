/**
 * Rate limiting com Token Bucket por tipo de rota.
 * Porte das boas práticas do louvorja/api (app/Http/Middleware/RateLimitMiddleware.php).
 *
 * Cada bucket (files, metadata, general) tem seu próprio token bucket em memória.
 * O token bucket permite bursts (picos) instantâneos e depois aplica o limite
 * sustentado com recarga gradual.
 *
 * Conceito de Token Bucket:
 *   - maxTokens: tokens máximos acumulados (cap)
 *   - refillRate: tokens recarregados por segundo = maxTokens / decaySeconds
 *   - burst: tokens iniciais (pico permitido instantaneamente)
 *
 * Configurável via env:
 *   RATE_LIMIT_MAX=5000                (general: max tokens, default 5000)
 *   RATE_LIMIT_FILE_MAX=10000          (files: max tokens, default 10000)
 *   RATE_LIMIT_METADATA_MAX=10000      (metadata: max tokens, default 10000)
 *   RATE_LIMIT_DECAY=60               (janela em segundos, default 60)
 *   RATE_LIMIT_BURST=100              (burst/pico geral, default 100)
 *   RATE_LIMIT_FILE_BURST=200         (burst/pico files, default 200)
 *   RATE_LIMIT_METADATA_BURST=200     (burst/pico metadata, default 200)
 *
 * Headers de resposta (paridade com louvorja/api):
 *   X-RateLimit-Limit      — max tokens (cap) do bucket
 *   X-RateLimit-Remaining  — tokens disponíveis
 *   X-RateLimit-Reset      — timestamp unix até próximo refill cheio
 *   X-RateLimit-Bucket     — nome do bucket (files/metadata/general)
 *   Retry-After            — segundos até reset (quando 429)
 */

import type { Context, Next } from "hono";
import { incRateLimitBlocked } from "./metrics.js";

const FILE_ROUTES = ["/file/", "/player"];
const METADATA_ROUTES = ["/version", "/version_log", "/metadata"];

const LANG_PREFIXES = [
  "pt-BR",
  "en",
  "es",
  "fr",
  "de",
  "it",
  "ru",
  "zh",
  "ja",
  "ko",
];

type Bucket = "files" | "metadata" | "general";

interface BucketState {
  tokens: number;
  lastRefill: number;
}

/** Estado por (bucket, ip). Em memória — suficiente para instância única. */
const state = new Map<string, BucketState>();

// Limpa entradas mortas periodicamente (evita crescimento sem bound)
const MAX_KEYS = 10_000;
let lastSweep = Date.now();
function sweep(now: number): void {
  if (now - lastSweep < 60_000 || state.size < MAX_KEYS) return;
  // Remove entradas inativas há mais de 10 minutos
  for (const [key, s] of state) {
    if (now / 1000 - s.lastRefill > 600) state.delete(key);
  }
  lastSweep = now;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const DECAY_SECONDS = intEnv("RATE_LIMIT_DECAY", 60);

function resolveMaxTokens(bucket: Bucket): number {
  if (bucket === "files") return intEnv("RATE_LIMIT_FILE_MAX", 10_000);
  if (bucket === "metadata") return intEnv("RATE_LIMIT_METADATA_MAX", 10_000);
  return intEnv("RATE_LIMIT_MAX", 5000);
}

function resolveBurst(bucket: Bucket): number {
  if (bucket === "files") return intEnv("RATE_LIMIT_FILE_BURST", 200);
  if (bucket === "metadata") return intEnv("RATE_LIMIT_METADATA_BURST", 200);
  return intEnv("RATE_LIMIT_BURST", 100);
}

/** Normaliza o path removendo prefixo de idioma. /pt-BR/file/x -> /file/x */
function normalizePath(path: string): string {
  let p = path.startsWith("/") ? path : `/${path}`;
  const segments = p.split("/");
  if (segments.length > 2 && LANG_PREFIXES.includes(segments[1] ?? "")) {
    segments.splice(1, 1);
    p = segments.join("/") || "/";
  }
  return p;
}

function resolveBucket(normalizedPath: string): Bucket {
  if (FILE_ROUTES.some((r) => normalizedPath.startsWith(r))) return "files";
  if (METADATA_ROUTES.some((r) => normalizedPath === r)) return "metadata";
  return "general";
}

/**
 * RF-05: extração de IP segura contra spoofing de X-Forwarded-For.
 * Só confia no header quando TRUSTED_PROXY=true (ex: atrás de Cloudflare Tunnel).
 * Sem proxy confiável, qualquer cliente pode forjar o header pra burlar o bucket.
 */
export function getClientIpSafe(
  c: Context,
  opts: { TRUSTED_PROXY: string | boolean },
): string {
  const trusted = opts.TRUSTED_PROXY === true || opts.TRUSTED_PROXY === "true";
  if (trusted) {
    const fwd = c.req.header("x-forwarded-for");
    if (fwd) return (fwd.split(",")[0] ?? "").trim();
    const real = c.req.header("x-real-ip");
    if (real) return real;
  }
  return "unknown";
}

export async function rateLimit(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  const now = Math.floor(Date.now() / 1000);
  sweep(now * 1000);

  const normalizedPath = normalizePath(c.req.path);
  const bucket = resolveBucket(normalizedPath);
  const maxTokens = resolveMaxTokens(bucket);
  const burst = resolveBurst(bucket);

  const key = `rate_limit:${bucket}:${getClientIpSafe(c, { TRUSTED_PROXY: process.env.TRUSTED_PROXY ?? "false" })}`;
  const prev = state.get(key) ?? { tokens: burst, lastRefill: now };

  // Refill: adiciona tokens com base no tempo decorrido
  const refillRate = maxTokens / DECAY_SECONDS;
  const elapsed = now - prev.lastRefill;
  let tokens = prev.tokens;
  if (elapsed > 0) {
    tokens = Math.min(tokens + elapsed * refillRate, maxTokens);
  }

  if (tokens < 1.0) {
    const tokensNeeded = 1.0 - tokens;
    const retryAfter = Math.max(1, Math.ceil(tokensNeeded / refillRate));
    const resetAt = now + retryAfter;

    c.header("X-RateLimit-Limit", String(maxTokens));
    c.header("X-RateLimit-Remaining", "0");
    c.header("X-RateLimit-Reset", String(resetAt));
    c.header("X-RateLimit-Bucket", bucket);
    c.header("Retry-After", String(retryAfter));
    incRateLimitBlocked(c.req.path);
    return c.json(
      {
        error: "Too Many Requests",
        message: "Limite de requisições excedido. Tente novamente em breve.",
        retry_after: retryAfter,
        bucket,
      },
      429,
    );
  }

  tokens -= 1.0;
  state.set(key, { tokens, lastRefill: now });

  await next();

  c.header("X-RateLimit-Limit", String(maxTokens));
  c.header("X-RateLimit-Remaining", String(Math.max(Math.floor(tokens), 0)));
  c.header("X-RateLimit-Reset", String(now + DECAY_SECONDS));
  c.header("X-RateLimit-Bucket", bucket);
}
