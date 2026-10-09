import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

describe("Configured CORS policy in production", () => {
  let app: SeededDb;
  beforeAll(async () => {
    vi.stubEnv("CORS_ORIGINS", "https://allowed.test, https://second.test ");
    vi.stubEnv("NODE_ENV", "production");
    app = await setupSeededDb();
  });
  afterAll(() => {
    app.cleanup();
    vi.unstubAllEnvs();
  });
  it.each(["https://allowed.test", "https://second.test"])(
    "permits the configured origin %s",
    async (origin) => {
      const response = await app.router.request("/v1/health", {
        headers: { origin },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("cross-origin-resource-policy")).toBe(
        "same-origin",
      );
      expect(response.headers.get("strict-transport-security")).toContain(
        "max-age=31536000",
      );
    },
  );
  it("does not grant CORS access to another origin", async () => {
    const response = await app.router.request("/v1/health", {
      headers: { origin: "https://untrusted.test" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
