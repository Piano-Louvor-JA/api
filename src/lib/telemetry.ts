import type { ErrorEvent } from "@sentry/node";

/**
 * Telemetria de erros — Glitchtip/Sentry (server-side).
 *
 * Sem SENTRY_DSN: 100% inativa (nenhuma inicialização, nenhum envio).
 * Com DSN: captura exceções não tratadas (onError global do Hono via
 * instrumentação no app.ts) e erros manuais. Nunca propaga falha própria:
 * telemetria é opcional, a API segue de pé.
 */
type ErrorContext = Record<string, unknown>;

type SentryNode = {
  captureException(error: unknown, hint?: { extra?: ErrorContext }): void;
  init(options: Record<string, unknown>): void;
};

let captureException: SentryNode["captureException"] | null = null;

// Use an allowlist: SDK integrations may attach request data or breadcrumbs.
function sanitizeEvent(event: ErrorEvent): ErrorEvent {
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: "error",
    exception: {
      values: event.exception?.values?.map((exception) => ({
        type: [
          "Error",
          "TypeError",
          "RangeError",
          "SyntaxError",
          "ReferenceError",
        ].includes(exception.type ?? "")
          ? exception.type
          : "Error",
        value: "Unhandled API error (message redacted)",
        stacktrace: {
          frames: exception.stacktrace?.frames?.map((frame) => ({
            filename: frame.filename?.split(/[\\/]/).pop()?.split(/[?#]/)[0],
            lineno: frame.lineno,
            colno: frame.colno,
            in_app: frame.in_app,
          })),
        },
      })),
    },
    extra: {
      route: event.extra?.route,
      method: event.extra?.method,
    },
  };
}

export function initTelemetry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  import("@sentry/node")
    .then((sentry: SentryNode) => {
      sentry.init({
        dsn,
        environment: process.env.NODE_ENV ?? "production",
        sendDefaultPii: false,
        tracesSampleRate: 0,
        defaultIntegrations: false,
        beforeSend: sanitizeEvent,
      });
      captureException = sentry.captureException;
    })
    .catch(() => {
      // Telemetria opcional: indisponibilidade nunca derruba a API.
    });
}

export function reportError(error: unknown, context?: ErrorContext): void {
  try {
    captureException?.(error, context ? { extra: context } : undefined);
  } catch {
    // SDK opcional: nunca propaga erro de diagnóstico.
  }
}
