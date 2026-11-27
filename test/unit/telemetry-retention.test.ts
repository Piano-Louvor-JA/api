import type { Context } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PartnerEnv } from "../../src/middleware/partnerKey.js";
import {
  resetTelemetryState,
  telemetryMiddleware,
} from "../../src/middleware/telemetry.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T10:00:00Z"));
  vi.stubEnv("TELEMETRY_DISABLED", "false");
  resetTelemetryState();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetTelemetryState();
});

function context(ip: string): Context<PartnerEnv> {
  return {
    req: {
      header: (name: string) => (name === "x-forwarded-for" ? ip : undefined),
      raw: { headers: new Headers() },
      path: "/legacy-status",
      method: "GET",
    },
    get: () => undefined,
  } as unknown as Context<PartnerEnv>;
}

it("mantém o caminho legado e sua contagem quando não há rota registrada", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const next = vi.fn(async () => {});
  await telemetryMiddleware(context("127.0.0.1"), next);
  await telemetryMiddleware(context("127.0.0.1"), next);
  const last = String(log.mock.calls.at(-1)?.[0]);
  expect(last).toContain('"GET /legacy-status":2');
  expect(next).toHaveBeenCalledTimes(2);
});

it("ao atingir capacidade expira minutos anteriores e preserva o minuto atual", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  for (let i = 0; i < 9999; i++) {
    await telemetryMiddleware(context(`old-${i}`), async () => {});
  }
  vi.advanceTimersByTime(60_000);
  await telemetryMiddleware(context("current"), async () => {});
  await telemetryMiddleware(context("trigger-expiry"), async () => {});
  await telemetryMiddleware(context("current"), async () => {});
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('"total":2');
  await telemetryMiddleware(context("old-0"), async () => {});
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('"total":1');
});
