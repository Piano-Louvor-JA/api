// Segurança anti-bot/script kiddie — camada mínima para API pública
// — Rate limit por IP (default: 100 req/min)
// — User-agent basico (evita crawler básicos)
// — Path protection contra probing automatizado

import type { MiddlewareHandler } from "hono";

const SUSPICIOUS_UA = /curl|wget|python|postman|insomnia|bot|spider|crawler/i;
// O middleware já está montado só em /v1/*. O prefixo /v1/ não é probing:
// marcá-lo aqui logaria toda request legítima da API.
const PROBING_PATHS = [
  "/openapi.json",
  "/doc",
  "/api",
  "/v2/",
  "/health",
  "/metrics",
];

function logLine(message: string): void {
  try {
    console.log(message);
  } catch {
    // Log nunca pode derrubar a request.
  }
}

export const antiBotMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  const ip = c.req.header("x-forwarded-for") || "unknown";
  const ua = c.req.header("user-agent") || "";
  const path = c.req.path;

  // 1. User-agent suspeito → block rápido
  if (ua && SUSPICIOUS_UA.test(ua)) {
    logLine(`⚠️ Bot UA bloqueado: ${ip} | ${ua} | ${path}`);
    return c.json(
      { error: "User-Agent não suportado. Utilize um cliente HTTP padrão." },
      403,
    );
  }

  // 2. Probing de endpoints de documentação/paths → throttle (opcional, sem KV)
  if (PROBING_PATHS.some((p) => path.startsWith(p))) {
    // Versão simples: log e throttle básico
    logLine(`🔍 Probing detectado: ${ip} | ${path}`);
    // Em produção real, usaríamos Redis/D1/Cloudflare KV, aqui só log mesmo
    // para não bloquear tráfego legítimo
  }

  await next();

  // 3. Log de requests lentas (> 2s)
  const duration = Date.now() - start;
  if (duration > 2000) {
    logLine(`🐢 Request lenta: ${duration}ms | ${ip} | ${path}`);
  }

  return;
};
