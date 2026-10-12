import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";

afterEach(() => vi.unstubAllEnvs());
it("lista de CORS remove espaços e aceita somente origem configurada", async () => {
  vi.stubEnv("CORS_ORIGINS", " https://web.example , https://app.example ");
  const app = createApp();
  const allowed = await app.request("/v1/health", {
    headers: { origin: "https://app.example" },
  });
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("access-control-allow-origin")).toBe(
    "https://app.example",
  );
  expect(allowed.headers.get("cross-origin-resource-policy")).toBe(
    "same-origin",
  );
  const denied = await app.request("/v1/health", {
    headers: { origin: "https://untrusted.example" },
  });
  expect(denied.headers.get("access-control-allow-origin")).toBeNull();
});
