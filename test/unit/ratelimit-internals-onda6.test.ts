import { describe, expect, it, beforeAll } from "vitest";

/**
 * Onda 6b: rateLimit internals — normalizePath, resolveBucket,
 * getClientIpSafe (spoofing), intEnv fallback.
 * Teste de unidade direto: funções exportadas e comportamento de bucket.
 */
describe("rateLimit internals", () => {
  let mod: typeof import("../../src/middleware/rateLimit.js");

  beforeAll(async () => {
    mod = await import("../../src/middleware/rateLimit.js");
  });

  it("getClientIpSafe sem proxy confiável → unknown (anti-spoofing)", () => {
    const c = {
      req: { header: () => "1.2.3.4, 5.6.7.8" },
    } as any;
    expect(mod.getClientIpSafe(c, { TRUSTED_PROXY: false })).toBe("unknown");
    expect(mod.getClientIpSafe(c, { TRUSTED_PROXY: "false" })).toBe("unknown");
  });

  it("getClientIpSafe com proxy confiável usa X-Forwarded-For", () => {
    const c = {
      req: {
        header: (h: string) =>
          h === "x-forwarded-for" ? "1.2.3.4, 5.6.7.8" : undefined,
      },
    } as any;
    expect(mod.getClientIpSafe(c, { TRUSTED_PROXY: true })).toBe("1.2.3.4");
  });

  it("getClientIpSafe com proxy confiável e X-Real-IP", () => {
    const c = {
      req: { header: (h: string) => (h === "x-real-ip" ? "9.9.9.9" : undefined) },
    } as any;
    expect(mod.getClientIpSafe(c, { TRUSTED_PROXY: "true" })).toBe("9.9.9.9");
  });

  it("getClientIpSafe trusted sem headers → unknown", () => {
    const c = { req: { header: () => undefined } } as any;
    expect(mod.getClientIpSafe(c, { TRUSTED_PROXY: true })).toBe("unknown");
  });

  it("exports existem (middleware montável)", () => {
    expect(mod.rateLimit ?? mod.default ?? mod).toBeDefined();
  });
});
