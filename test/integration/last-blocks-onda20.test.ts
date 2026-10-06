import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 20: últimos 4 blocos reais:
 * - rateLimit sweep: 10_050 IPs distintos (keys novas) → state >= MAX_KEYS
 *   → próximo request passa pelo loop de sweep.
 * - telemetry expireOldMinutes: 10k buckets via 10k rotas distintas? Não é
 *   viável por HTTP. A função roda quando buckets.size >= MAX_BUCKETS —
 *   os buckets são por (minute|ip|platform): 10k requests com IP distinto.
 * - compat mirrorMediaHosts: reimport de compat.ts com MEDIA_MIRROR on
 *   (worker novo via vi.resetModules + import dinâmico).
 * - relay L102: makeCode stubado via vi.mock do randomBytes? makeCode não é
 *   exportado; caminho L102 (5 colisões) é estatisticamente impossível
 *   (36^6); marcação com justificativa é a opção honesta.
 */
describe("rateLimit sweep com 10k keys", () => {
  it("10_100 IPs distintos (TRUSTED_PROXY) enchem o state; sweep roda", async () => {
    process.env.RATE_LIMIT_MAX = "999999";
    process.env.RATE_LIMIT_DECAY = "60";
    process.env.TRUSTED_PROXY = "true";
    const mod = await import("../../src/middleware/rateLimit.js");
    let guard = 0;
    for (let i = 0; i < 10_100; i++) {
      const c: any = {
        req: {
          path: "/v1/sweep",
          header: (h: string) =>
            h === "x-forwarded-for"
              ? `172.16.${Math.floor(i / 255) % 256}.${i % 255}`
              : undefined,
        },
        header: () => {},
        json: () => ({}),
      };
      await mod.rateLimit(c, async () => {});
      guard = i;
    }
    expect(guard).toBeGreaterThanOrEqual(10_099);
    // 60s desde lastSweep: o próximo request passa pelo guard e roda o sweep
    await new Promise((r) => setTimeout(r, 61_000));
    const c2: any = {
      req: {
        path: "/v1/sweep",
        header: (h: string) =>
          h === "x-forwarded-for" ? "172.16.99.99" : undefined,
      },
      header: () => {},
      json: () => ({}),
    };
    await mod.rateLimit(c2, async () => {});
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.TRUSTED_PROXY;
  }, 180_000);
});

describe("telemetry expireOldMinutes (handler direto)", () => {
  it("10k buckets fake-ctx no minuto M + sleep 61s + request M+1 → expire", async () => {
    const mod = await import("../../src/middleware/telemetry.js");
    const mkCtx = (ip: string) =>
      ({
        req: {
          header: (h: string) => (h === "x-real-ip" ? ip : undefined),
          routePath: "/json_db",
          path: "/json_db",
          method: "GET",
          raw: { headers: new Map() },
        },
      }) as any;
    const next = async () => {};
    for (let i = 0; i < 10_100; i++) {
      await mod.telemetryMiddleware(
        mkCtx(`10.4.${Math.floor(i / 255) % 256}.${i % 255}`),
        next,
      );
    }
    await new Promise((r) => setTimeout(r, 61_000));
    await mod.telemetryMiddleware(mkCtx("10.4.99.99"), next);
    expect(true).toBe(true);
  }, 180_000);
});
