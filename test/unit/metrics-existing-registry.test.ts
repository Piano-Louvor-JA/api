import { register } from "prom-client";
import { expect, it } from "vitest";

it("reimport com registro existente preserva a proibição de métricas duplicadas", async () => {
  await import("../../src/middleware/metrics.js");
  expect(register.getSingleMetric("http_requests_total")).toBeDefined();
  const { vi } = await import("vitest");
  vi.resetModules();
  await expect(import("../../src/middleware/metrics.js")).rejects.toThrow(
    "already been registered",
  );
  register.clear();
});
