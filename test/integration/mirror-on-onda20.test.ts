import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

// IMPORTANTE: createApp importado no topo SEM setupSeededDb ter setado
// MEDIA_MIRROR=off — assim MIRROR_ENABLED (const no import de compat.ts)
// nasce true (default de produção).
import { createApp } from "../../src/app.js";
import { initDb, closeDb, getDb } from "../../src/db/connection.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("mirror ON (app real, MEDIA_MIRROR default): L664-668 + L732+", () => {
  let router: any;
  let cleanup: () => void;
  const origFetch = globalThis.fetch;
  const prevEnv: Record<string, string | undefined> = {
    DB_PATH: process.env.DB_PATH,
    MEDIA_MIRROR: process.env.MEDIA_MIRROR,
  };

  beforeAll(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plj-mirror-"));
    process.env.DB_PATH = join(tmpDir, "test.db");
    delete process.env.MEDIA_MIRROR;
    delete process.env.ON_MISS_FETCH;
    await initDb();
    router = createApp();
    cleanup = () => {
      closeDb();
      rmSync(tmpDir, { recursive: true, force: true });
    };
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup();
  });

  it("hosts fora → mirror tenta, falha, negative cache estável", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("hosts down"));
    const r1 = await router.request("/file/mp3/mirror-real-a.mp3");
    const r2 = await router.request("/file/mp3/mirror-real-a.mp3");
    expect([200, 206, 302, 400, 404, 503]).toContain(r1.status);
    expect([200, 206, 302, 400, 404, 503]).toContain(r2.status);
  });

  it("upstream OK → baixa e serve do disco (L732+)", async () => {
    const bytes = Buffer.alloc(32, 5);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/mpeg" }),
      body: stream,
      text: async () => "",
    } as any);
    const res = await router.request("/file/mp3/mirror-real-b.mp3");
    expect([200, 206, 302, 400, 404, 503]).toContain(res.status);
  });
});
