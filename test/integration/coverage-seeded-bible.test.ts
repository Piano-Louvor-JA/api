import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveBibleCacheDir } from "../../src/lib/bibleCacheDir.js";
import { setupSeededDb } from "../helpers/seeded-db.js";

describe("coverage seeded — bible proxy", () => {
  let router: any;
  let cleanup: () => void;

  beforeAll(async () => {
    ({ router, cleanup } = await setupSeededDb());
  });

  afterAll(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("bible_1_50_1 via cache local e 502 quando upstream falha", async () => {
    const cacheDir = resolveBibleCacheDir();
    const cacheFile = join(cacheDir, "bible_1_50_1.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ cached: true }), "utf-8");
    const hit = await router.request("/json_db/bible_1_50_1");
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({ cached: true });

    try {
      rmSync(join(cacheDir, "bible_999_99_9.json"));
    } catch {}
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("upstream down")),
    );
    const miss = await router.request("/json_db/bible_999_99_9");
    expect(miss.status).toBe(502);

    const cacheFile888 = join(cacheDir, "bible_888_88_8.json");
    try {
      rmSync(cacheFile888);
    } catch {}
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ ok: true, chapter: 9 })),
      }),
    );
    const fresh = await router.request("/json_db/bible_888_88_8");
    expect(fresh.status).toBe(200);
    expect(existsSync(join(cacheDir, "bible_888_88_8.json"))).toBe(true);
    const fetchCount = (globalThis.fetch as any).mock.calls.length;
    const cached = await router.request("/json_db/bible_888_88_8");
    expect(cached.status).toBe(200);
    expect((globalThis.fetch as any).mock.calls.length).toBe(fetchCount);
  });
});
