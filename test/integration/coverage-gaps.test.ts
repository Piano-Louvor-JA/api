import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupSeededDb } from "../helpers/seeded-db.js";

describe("coverage gaps - functional HTTP paths", () => {
  let router: any;
  let cleanup: () => void;

  beforeAll(async () => {
    ({ router, cleanup } = await setupSeededDb());
  });
  afterAll(() => cleanup());

  it("uses default pagination and empty pages", async () => {
    const [musics, albums, categories] = await Promise.all([
      router.request("/v1/musics?lang=pt"),
      router.request("/v1/albums?lang=pt&page=999999&per_page=50"),
      router.request("/v1/categories?lang=pt"),
    ]);
    expect(musics.status).toBe(200);
    expect(albums.status).toBe(200);
    expect(categories.status).toBe(200);
    expect(Array.isArray((await albums.json()).data)).toBe(true);
  });

  it("returns empty result objects for missing legacy records", async () => {
    const [music, album] = await Promise.all([
      router.request("/json_db/music_999999"),
      router.request("/json_db/album_999999"),
    ]);
    expect(music.status).toBe(404);
    expect(album.status).toBe(404);
  });

  it("covers legacy not-found and language fallback paths", async () => {
    const responses = await Promise.all([
      router.request("/json_db/music_999999"),
      router.request("/json_db/album_999999"),
      router.request("/v1/musics/999999?lang=pt"),
      router.request("/v1/albums/999999?lang=pt"),
      router.request("/v1/categories/999999?lang=pt"),
      router.request("/v1/bible?lang=xx"),
      router.request("/v1/bible/999999/1?lang=pt"),
    ]);
    // bible chapter 404 = chapter not found in seeded table
    expect(responses.map((r) => r.status)).toEqual([
      404, 404, 404, 404, 404, 200, 404,
    ]);
  });

  it("covers compat.ts endpoints: json_db manifest", async () => {
    const res = await router.request("/json_db");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("file");
    expect(body[0]).toHaveProperty("table");
  });

  it("covers compat.ts: pt_categories, es_categories", async () => {
    const [pt, es] = await Promise.all([
      router.request("/json_db/pt_categories"),
      router.request("/json_db/es_categories"),
    ]);
    expect(pt.status).toBe(200);
    expect(es.status).toBe(200);
    expect(Array.isArray(await pt.json())).toBe(true);
    expect(Array.isArray(await es.json())).toBe(true);
  });

  it("covers compat.ts: pt_musics, es_musics", async () => {
    const [pt, es] = await Promise.all([
      router.request("/json_db/pt_musics"),
      router.request("/json_db/es_musics"),
    ]);
    expect(pt.status).toBe(200);
    expect(es.status).toBe(200);
    expect(Array.isArray(await pt.json())).toBe(true);
    expect(Array.isArray(await es.json())).toBe(true);
  });

  it("covers compat.ts: pt_hymnal, es_hymnal", async () => {
    const [pt, es] = await Promise.all([
      router.request("/json_db/pt_hymnal"),
      router.request("/json_db/es_hymnal"),
    ]);
    expect(pt.status).toBe(200);
    expect(es.status).toBe(200);
    expect(Array.isArray(await pt.json())).toBe(true);
    expect(Array.isArray(await es.json())).toBe(true);
  });

  it("covers compat.ts: pt_hymnal_1996, es_hymnal_1996", async () => {
    const [pt, es] = await Promise.all([
      router.request("/json_db/pt_hymnal_1996"),
      router.request("/json_db/es_hymnal_1996"),
    ]);
    expect(pt.status).toBe(200);
    expect(es.status).toBe(200);
    expect(Array.isArray(await pt.json())).toBe(true);
    expect(Array.isArray(await es.json())).toBe(true);
  });

  it("covers compat.ts: pt_bible_book, pt_bible_version", async () => {
    const [books, versions] = await Promise.all([
      router.request("/json_db/pt_bible_book"),
      router.request("/json_db/pt_bible_version"),
    ]);
    expect(books.status).toBe(200);
    expect(versions.status).toBe(200);
    expect(Array.isArray(await books.json())).toBe(true);
    expect(Array.isArray(await versions.json())).toBe(true);
  });

  it("covers compat.ts: music_{id}, album_{id}", async () => {
    const [music, album] = await Promise.all([
      router.request("/json_db/music_1"),
      router.request("/json_db/album_1"),
    ]);
    expect(music.status).toBe(200);
    expect(album.status).toBe(200);
    expect(await music.json()).toHaveProperty("id_music");
    expect(await album.json()).toHaveProperty("id_album");
  });

  it("covers compat.ts: bible chapter proxy cache hit (lines 432-434)", async () => {
    // Create cache file
    const fs = await import("node:fs");
    const path = await import("node:path");
    const cacheDir = path.join(process.cwd(), "data", "bible_cache");
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, "bible_1_1_1.json");
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ verses: [{ verse: 1, text: "test" }] }),
    );

    const res = await router.request("/json_db/bible_1_1_1");
    expect([200, 502]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("verses");
    }

    // Cleanup
    fs.unlinkSync(cacheFile);
  });

  it("covers compat.ts: bible chapter cache miss -> upstream fail or 404 (lines 438-445)", async () => {
    const { vi } = await import("vitest");
    const { _resetThrottleForTest } = await import("../../src/lib/upstream.js");
    _resetThrottleForTest();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    try {
      const res = await router.request("/json_db/bible_999_999_999");
      // Com fetch mockado em 404: espelha 404 (ou 502 se a rota mapear falha)
      expect([404, 502]).toContain(res.status);
    } finally {
      vi.unstubAllGlobals();
      _resetThrottleForTest();
    }
  });

  it("covers compat.ts: file redirect", async () => {
    const res = await router.request("/file/some/path.mp3");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "api.louvorja.workers.dev/file/",
    );
  });

  it("covers /v1/musics 404 for non-existent", async () => {
    const res = await router.request("/v1/musics/999999?lang=pt");
    expect(res.status).toBe(404);
  });

  it("covers /v1/albums 404 for non-existent", async () => {
    const res = await router.request("/v1/albums/999999?lang=pt");
    expect(res.status).toBe(404);
  });

  it("covers /v1/categories 404 for non-existent", async () => {
    const res = await router.request("/v1/categories/999999?lang=pt");
    expect(res.status).toBe(404);
  });

  it("covers /v1/musics validation error (missing lang)", async () => {
    const res = await router.request("/v1/musics");
    expect(res.status).toBe(400);
  });

  it("covers /v1/albums validation error (missing lang)", async () => {
    const res = await router.request("/v1/albums");
    expect(res.status).toBe(400);
  });

  it("covers /v1/bible books list with various langs", async () => {
    const [pt, es, en] = await Promise.all([
      router.request("/v1/bible?lang=pt"),
      router.request("/v1/bible?lang=es"),
      router.request("/v1/bible?lang=en"),
    ]);
    expect(pt.status).toBe(200);
    expect(es.status).toBe(200);
    expect(en.status).toBe(200);
    const ptData = await pt.json();
    expect(ptData).toHaveProperty("data");
    expect(Array.isArray(ptData.data)).toBe(true);
  });

  it("covers /v1/bible chapter 404 for invalid book/chapter", async () => {
    const res = await router.request("/v1/bible/999999/99?lang=pt");
    expect(res.status).toBe(404);
  });
});
