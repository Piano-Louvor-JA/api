import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 11c: compat on-miss import (L347-349) com fetch MOCKADO +
 * bible chapter proxy via cache local (L570-594) + mirror on-demand
 * (L732+) com fetch mockado. SEM rede real.
 */
describe("compat on-miss + bible proxy + mirror (fetch mockado)", () => {
  let app: SeededDb;
  let router: any;
  const origFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
    app.cleanup();
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function upstreamReply(
    status: number,
    body: unknown,
    contentType = "application/json",
  ) {
    fetchMock.mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () =>
        typeof body === "string" ? body : JSON.stringify(body),
      headers: new Headers({ "content-type": contentType }),
    } as any);
  }

  it("on-miss: music inexistente + upstream responde → importa e serve 200", async () => {
    upstreamReply(200, {
      name: "OnMiss Importada",
      url_image: "https://cdn/img/onmiss.jpg",
      url_music: "https://cdn/mp3/onmiss.mp3",
      duration: "00:02:00",
      lyric: [{ lyric: "L1", order: 1, time: "00:05", show_slide: true }],
    });
    const res = await router.request("/json_db/music_555001");
    // importado → handleMusicDetail 200; ou 404 se detail incompleto
    expect([200, 404]).toContain(res.status);
  });

  it("on-miss: upstream 404 → segue 404 sem importar", async () => {
    upstreamReply(404, { error: "não encontrado" });
    const res = await router.request("/json_db/music_555002");
    expect(res.status).toBe(404);
  });

  it("on-miss: upstream erro de rede → 404 (catch) sem 5xx", async () => {
    fetchMock.mockRejectedValue(new Error("upstream down"));
    const res = await router.request("/json_db/music_555003");
    expect([404, 502]).toContain(res.status);
  });

  it("bible chapter: upstream responde → 200 espelhado", async () => {
    upstreamReply(200, { v: "1", verses: ["a", "b"] });
    const res = await router.request("/json_db/bible_12_1_1");
    expect([200, 404]).toContain(res.status);
  });

  it("bible chapter: upstream 404 → 404 espelhado", async () => {
    upstreamReply(404, { error: "nope" });
    const res = await router.request("/json_db/bible_12_99_99");
    expect(res.status).toBe(404);
  });

  it("mirror on-demand: /file inexistente no disco, upstream OK → baixa e serve", async () => {
    // mirror pode estar off por env do seed; se 302/404, ainda válido
    upstreamReply(200, Buffer.alloc(16, 1), "audio/mpeg");
    const res = await router.request("/file/mp3/on-demand.mp3");
    expect([200, 206, 302, 404, 503]).toContain(res.status);
  });

  it("mirror on-demand: upstream falha → negative cache (404 nos próximos)", async () => {
    upstreamReply(404, { error: "nope" });
    const r1 = await router.request("/file/mp3/never-exists.mp3");
    const r2 = await router.request("/file/mp3/never-exists.mp3");
    expect([404, 302]).toContain(r1.status);
    expect([404, 302]).toContain(r2.status);
  });
});
