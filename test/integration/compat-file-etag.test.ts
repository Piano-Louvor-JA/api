import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// createApp no topo, antes de qualquer MEDIA_MIRROR=off: o mirror nasce
// ligado (default de produção) para cobrir o ETag do arquivo recém-baixado.
import { createApp } from "../../src/app.js";
import { closeDb, initDb } from "../../src/db/connection.js";

/**
 * /file com validadores HTTP: ETag (hash do conteúdo), Last-Modified e
 * Cache-Control: no-cache — o parceiro descobre arquivo corrigido no mesmo
 * endereço via If-None-Match/If-Modified-Since e recebe 304 quando nada mudou.
 */
describe("/file ETag e Last-Modified", () => {
  let router: any;
  let tmpDb: string;
  let dir: string;
  let prefix: string;
  const origFetch = globalThis.fetch;
  const prevEnv = {
    DB_PATH: process.env.DB_PATH,
    MEDIA_MIRROR: process.env.MEDIA_MIRROR,
  };
  const mp3 = () => join(dir, "faixa.mp3");
  const url = () => `/file/${prefix}/faixa.mp3`;

  beforeAll(async () => {
    tmpDb = mkdtempSync(join(tmpdir(), "plj-etag-"));
    process.env.DB_PATH = join(tmpDb, "test.db");
    delete process.env.MEDIA_MIRROR;
    await initDb();
    router = createApp();
    mkdirSync(join(process.cwd(), "media"), { recursive: true });
    dir = mkdtempSync(join(process.cwd(), "media", "test-etag-"));
    prefix = basename(dir);
    writeFileSync(mp3(), Buffer.alloc(1024, 7));
    utimesSync(
      mp3(),
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z"),
    );
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    closeDb();
    rmSync(tmpDb, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("200 traz ETag forte do conteúdo, Last-Modified e no-cache", async () => {
    const res = await router.request(url());
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers.get("last-modified")).toBe(
      "Thu, 01 Jan 2026 00:00:00 GMT",
    );
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("mesmo conteúdo → mesmo ETag; Range também traz o ETag", async () => {
    const a = await router.request(url());
    const b = await router.request(url(), { headers: { range: "bytes=0-9" } });
    expect(b.status).toBe(206);
    expect(b.headers.get("etag")).toBe(a.headers.get("etag"));
  });

  it("If-None-Match igual → 304 sem corpo; diferente → 200", async () => {
    const etag = (await router.request(url())).headers.get("etag");
    const hit = await router.request(url(), {
      headers: { "if-none-match": etag },
    });
    expect(hit.status).toBe(304);
    expect(hit.headers.get("etag")).toBe(etag);
    expect((await hit.arrayBuffer()).byteLength).toBe(0);

    const list = await router.request(url(), {
      headers: { "if-none-match": `"outro", ${etag}` },
    });
    expect(list.status).toBe(304);

    const miss = await router.request(url(), {
      headers: { "if-none-match": '"outro"' },
    });
    expect(miss.status).toBe(200);
  });

  it("If-Modified-Since sem If-None-Match → 304 se não mudou, 200 se mudou", async () => {
    const same = await router.request(url(), {
      headers: { "if-modified-since": "Thu, 01 Jan 2026 00:00:00 GMT" },
    });
    expect(same.status).toBe(304);
    const older = await router.request(url(), {
      headers: { "if-modified-since": "Wed, 31 Dec 2025 00:00:00 GMT" },
    });
    expect(older.status).toBe(200);
    const garbage = await router.request(url(), {
      headers: { "if-modified-since": "ontem" },
    });
    expect(garbage.status).toBe(200);
  });

  it("arquivo corrigido no mesmo endereço (mesmo tamanho) → ETag novo", async () => {
    const before = (await router.request(url())).headers.get("etag");
    writeFileSync(mp3(), Buffer.alloc(1024, 9));
    utimesSync(
      mp3(),
      new Date("2026-02-01T00:00:00Z"),
      new Date("2026-02-01T00:00:00Z"),
    );
    const res = await router.request(url(), {
      headers: { "if-none-match": before },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(before);
    expect(res.headers.get("last-modified")).toBe(
      "Sun, 01 Feb 2026 00:00:00 GMT",
    );
  });

  it("arquivo recém-baixado pelo mirror já sai com ETag", async () => {
    const name = `${prefix}/mirror.mp3`;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/mpeg" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.alloc(64, 3));
          controller.close();
        },
      }),
    } as any);
    const first = await router.request(`/file/${name}`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers.get("cache-control")).toBe("no-cache");

    const again = await router.request(`/file/${name}`);
    expect(again.headers.get("etag")).toBe(etag);
  });
});
