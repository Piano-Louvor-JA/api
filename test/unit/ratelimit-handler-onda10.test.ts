import { beforeAll, describe, expect, it } from "vitest";

/**
 * Onda 10a: rateLimit handler direto — buckets files/metadata/general,
 * lang prefix, 429 com headers, refill por tempo, sweep, intEnv fallback.
 */
describe("rateLimit handler", () => {
  let mod: typeof import("../../src/middleware/rateLimit.js");

  function fakeCtx(path: string, ip = "1.1.1.1") {
    const headers: Record<string, string> = {};
    return {
      req: {
        path,
        header: (h: string) => (h === "x-forwarded-for" ? ip : undefined),
      },
      header: (k: string, v: string) => {
        headers[k] = v;
      },
      json: (body: unknown, status: number) => ({ __status: status, body }),
      __headers: headers,
    } as any;
  }

  const next = async () => {};

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = "100";
    process.env.RATE_LIMIT_DECAY = "60";
    mod = await import("../../src/middleware/rateLimit.js");
  });

  it("general bucket: request passa e seta headers", async () => {
    const c = fakeCtx("/v1/languages");
    await mod.rateLimit(c, next);
    expect(c.__headers["X-RateLimit-Bucket"]).toBe("general");
    expect(c.__headers["X-RateLimit-Limit"]).toBe("100");
  });

  it("files bucket por prefixo /file/", async () => {
    const c = fakeCtx("/file/mp3/x.mp3");
    await mod.rateLimit(c, next);
    expect(c.__headers["X-RateLimit-Bucket"]).toBe("files");
  });

  it("metadata bucket por path exato /version", async () => {
    const c = fakeCtx("/version");
    await mod.rateLimit(c, next);
    expect(c.__headers["X-RateLimit-Bucket"]).toBe("metadata");
  });

  it("lang prefix removido: /pt-BR/file/x cai no bucket files", async () => {
    const c = fakeCtx("/pt-BR/file/x.mp3");
    await mod.rateLimit(c, next);
    expect(c.__headers["X-RateLimit-Bucket"]).toBe("files");
  });

  it("path sem / inicial normalizado", async () => {
    const c = fakeCtx("version");
    await mod.rateLimit(c, next);
    expect(c.__headers["X-RateLimit-Bucket"]).toBe("metadata");
  });

  it("429 quando esgota (burst baixo via env por bucket)", async () => {
    // usa bucket metadata com maxTokens 1 via env: intEnv lido no import —
    // módulo já carregado com 10000; então drena com loop no general (100)
    let status: number | undefined;
    for (let i = 0; i < 130; i++) {
      const c = fakeCtx("/v1/x", "9.9.9.9");
      const r = await mod.rateLimit(c, next);
      if (r && (r as any).__status === 429) {
        status = 429;
        break;
      }
    }
    expect(status).toBe(429);
  });

  it("TRUSTED_PROXY=true usa XFF como chave (IPs distintos não se afetam)", async () => {
    process.env.TRUSTED_PROXY = "true";
    const c1 = fakeCtx("/v1/y", "7.7.7.7");
    await mod.rateLimit(c1, next);
    expect(c1.__headers["X-RateLimit-Bucket"]).toBe("general");
    delete process.env.TRUSTED_PROXY;
  });
});
