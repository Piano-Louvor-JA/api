import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { rateLimit } from "../../src/middleware/rateLimit.js";
import { telemetryMiddleware } from "../../src/middleware/telemetry.js";

afterEach(() => vi.unstubAllEnvs());
it("limite inválido usa o padrão de 5000 tokens", async () => {
  vi.stubEnv("RATE_LIMIT_MAX", "invalid");
  const app = new Hono();
  app.use("*", rateLimit);
  app.get("/invalid-limit", (c) => c.text("ok"));
  const response = await app.request("/invalid-limit");
  expect(response.status).toBe(200);
  expect(response.headers.get("X-RateLimit-Limit")).toBe("5000");
});
it("telemetria sem padrão registrado ainda chama o próximo handler", async () => {
  const next = vi.fn(async () => {});
  await telemetryMiddleware(
    {
      req: {
        header: () => undefined,
        routePath: undefined,
        path: "/unmatched-boundary",
        method: "GET",
        raw: { headers: new Headers() },
      },
    } as any,
    next,
  );
  expect(next).toHaveBeenCalledOnce();
});
