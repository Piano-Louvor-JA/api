// Cliente HTTP para o upstream (Workers primeiro, api.louvorja.com.br depois).
// Rate limit: max ~4500 req/h (0.8s entre chamadas) + respeito a 429/Retry-After.
// Ver .planning / references/upstream-sync-rate-limit-audit.md

const MIN_INTERVAL_MS = 800;
const MAX_RETRIES = 3;

/**
 * Fallback em cascata: hosts na ordem de tentativa.
 * A URL chamada é o primário (Workers). Se falhar (rede/5xx), tenta o
 * mesmo path em api.louvorja.com.br.
 * 404 NÃO troca de host — recurso não existe, fallback teria o mesmo.
 */
const FALLBACK_HOST = (
  process.env.UPSTREAM_FALLBACK_API ?? "https://api.louvorja.com.br"
).replace(/\/$/, "");

/** Hosts candidatos para uma URL: própria URL primeiro, depois fallback. */
export function _candidatesForTest(url: string): string[] {
  const u = new URL(url);
  const fb = new URL(FALLBACK_HOST);
  if (u.host === fb.host) return [url];
  const alt = `${fb.origin}${u.pathname}${u.search}`;
  return [url, alt];
}

let lastCall = 0;
let throttleQueue = Promise.resolve();

/** Reset do estado do throttle (uso exclusivo em testes). */
export function _resetThrottleForTest(): void {
  lastCall = 0;
  throttleQueue = Promise.resolve();
}

async function throttle(): Promise<void> {
  const previous = throttleQueue;
  let release!: () => void;
  throttleQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  const now = Date.now();
  const wait = lastCall + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  release();
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/**
 * fetch com rate limit global e retry em 429/5xx.
 * Fallback: em falha de rede/5xx no host primário, refaz a mesma requisição
 * no segundo host antes de lançar. 404 é imediato (não troca host).
 * Lança UpstreamError após esgotar tentativas — NUNCA busca sem throttle.
 */
export async function fetchUpstream(url: string): Promise<Response> {
  const candidates = _candidatesForTest(url);
  let lastError: UpstreamError | null = null;

  for (const candidateUrl of candidates) {
    let attempt = 0;
    for (;;) {
      await throttle();
      let res: Response;
      try {
        res = await fetch(candidateUrl);
      } catch {
        // Erro de rede (DNS down, timeout, conn refused): tenta fallback
        lastError = new UpstreamError(
          `Upstream network error: ${candidateUrl}`,
          503,
        );
        break;
      }
      if (res.ok) return res;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        // 404 ou esgotou retries neste host: 5xx pode ser queda do host
        // inteiro -> tenta fallback; 4xx definitivo -> lança direto
        if (res.status >= 500 || res.status === 429) {
          lastError = new UpstreamError(
            `Upstream returned ${res.status}`,
            res.status,
          );
          break;
        }
        throw new UpstreamError(`Upstream returned ${res.status}`, res.status);
      }
      // Retry-After em segundos; default progressivo 2s/4s/8s
      const ra = Number(res.headers.get("retry-after"));
      const delayMs =
        Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delayMs));
      attempt++;
    }
  }
  throw lastError ?? new UpstreamError("Upstream failed on all hosts", 502);
}
