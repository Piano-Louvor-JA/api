/**
 * Telemetria de erros — Glitchtip/Sentry (server-side).
 *
 * Sem SENTRY_DSN: 100% inativa (nenhuma inicialização, nenhum envio).
 * Com DSN: captura exceções não tratadas (onError global do Hono via
 * instrumentação no app.ts) e erros manuais. Nunca propaga falha própria:
 * telemetria é opcional, a API segue de pé.
 */
type ErrorContext = Record<string, unknown>

type SentryNode = {
  captureException(error: unknown, hint?: { extra?: ErrorContext }): void
  init(options: Record<string, unknown>): void
}

let captureException: SentryNode["captureException"] | null = null

export function initTelemetry(): void {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return

  import("@sentry/node")
    .then((sentry: SentryNode) => {
      sentry.init({
        dsn,
        environment: process.env.NODE_ENV ?? "production",
        sendDefaultPii: false,
        tracesSampleRate: 0,
      })
      captureException = sentry.captureException
    })
    .catch(() => {
      // Telemetria opcional: indisponibilidade nunca derruba a API.
    })
}

export function reportError(error: unknown, context?: ErrorContext): void {
  try {
    captureException?.(error, context ? { extra: context } : undefined)
  } catch {
    // SDK opcional: nunca propaga erro de diagnóstico.
  }
}
