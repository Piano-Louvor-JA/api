import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const { upstream, importer } = vi.hoisted(() => {
  process.env.MEDIA_MIRROR = "on";
  return { upstream: vi.fn(), importer: vi.fn() };
});
vi.mock("../../src/lib/upstream.js", () => ({ fetchUpstream: upstream }));
vi.mock("../../src/lib/importMusicOnMiss.js", () => ({
  ON_MISS_ENABLED: true,
  importMusicById: importer,
}));

import { createApp } from "../../src/app.js";
import { resolveBibleCacheDir } from "../../src/lib/bibleCacheDir.js";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

let fixture: SeededDb, app: ReturnType<typeof createApp>;
const prefix = `test-upstream-${process.pid}`;
beforeAll(async () => {
  fixture = await setupSeededDb();
  for (const chapter of [1, 2, 3, 4])
    rmSync(join(resolveBibleCacheDir(), `bible_97531_1_${chapter}.json`), {
      force: true,
    });
  app = createApp();
});
afterEach(() => {
  vi.unstubAllGlobals();
  upstream.mockReset();
  importer.mockReset();
});
afterAll(() => {
  fixture.cleanup();
  rmSync(join(process.cwd(), "media", prefix), {
    recursive: true,
    force: true,
  });
});
it("download real de stream é armazenado e servido", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const res = await app.request(`/file/${prefix}/download.mp3`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("audio/mpeg");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  const cached = await app.request(`/file/${prefix}/download.mp3`);
  expect(cached.status).toBe(200);
  expect(fetch).toHaveBeenCalledOnce();
});
it("stream sem Content-Type usa tipo binário", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([4]))),
  );
  const res = await app.request(`/file/${prefix}/unknown-header.mp3`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
});
it("resposta sem stream e host falho não são armazenados", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockRejectedValue(new Error("host down"));
  vi.stubGlobal("fetch", fetch);
  const first = await app.request(`/file/${prefix}/missing.mp3`);
  expect(first.status).toBe(302);
  const count = fetch.mock.calls.length;
  const second = await app.request(`/file/${prefix}/missing.mp3`);
  expect(second.status).toBe(404);
  expect(fetch).toHaveBeenCalledTimes(count);
});
it("oito downloads em andamento limitam o nono e liberam vagas depois", async () => {
  const releases: (() => void)[] = [];
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) =>
        releases.push(() => resolve(new Response(new Uint8Array([7])))),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const pending = Array.from({ length: 8 }, (_, i) =>
    app.request(`/file/${prefix}/parallel-${i}.mp3`),
  );
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(8));
  expect((await app.request(`/file/${prefix}/parallel-9.mp3`)).status).toBe(
    503,
  );
  for (const release of releases) release();
  expect((await Promise.all(pending)).every((res) => res.status === 200)).toBe(
    true,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([8]))),
  );
  expect((await app.request(`/file/${prefix}/after-parallel.mp3`)).status).toBe(
    200,
  );
});
it("importação sob demanda delega e serve música importada", async () => {
  importer.mockImplementation(
    async (id: number, db: ReturnType<SeededDb["getDb"]>) => {
      db.prepare(
        "INSERT INTO musics (id_music,name,id_language) VALUES (?,?,'pt')",
      ).run(id, "Imported");
      return true;
    },
  );
  const res = await app.request("/json_db/music_555001");
  expect(res.status).toBe(200);
  expect(importer).toHaveBeenCalledWith(555001, fixture.getDb());
});
it.each([false, "throw"])(
  "importação sem música (%s) preserva 404",
  async (mode) => {
    if (mode === "throw")
      importer.mockRejectedValue(new Error("import unavailable"));
    else importer.mockResolvedValue(false);
    const res = await app.request("/json_db/music_555002");
    expect(res.status).toBe(404);
  },
);
it("capítulo é sanitizado e servido do cache na segunda leitura", async () => {
  upstream.mockResolvedValue(
    new Response(JSON.stringify({ 1: "<J>texto</J>", 2: 7, 3: "  " })),
  );
  const path = "/json_db/bible_97531_1_1";
  const first = await app.request(path);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ 1: "texto" });
  expect((await app.request(path)).status).toBe(200);
  expect(upstream).toHaveBeenCalledOnce();
  rmSync(join(resolveBibleCacheDir(), "bible_97531_1_1.json"), {
    force: true,
  });
});
it.each([null, [], "scalar"])(
  "capítulo não objeto (%s) preserva contrato",
  async (value) => {
    const suffix = value === null ? 2 : Array.isArray(value) ? 3 : 4;
    upstream.mockResolvedValue(new Response(JSON.stringify(value)));
    const res = await app.request(`/json_db/bible_97531_1_${suffix}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(value);
    rmSync(join(resolveBibleCacheDir(), `bible_97531_1_${suffix}.json`), {
      force: true,
    });
  },
);

it("capítulo ausente no upstream retorna 404 sem cache", async () => {
  upstream.mockResolvedValue(new Response("missing", { status: 404 }));
  expect((await app.request("/json_db/bible_97531_1_99")).status).toBe(404);
});
it("catálogo espanhol sem registros usa fallback e reaproveita resultado", async () => {
  fixture
    .getDb()
    .prepare("DELETE FROM bible_books WHERE id_language = 'es'")
    .run();
  upstream.mockRejectedValueOnce(new Error("unavailable"));
  expect((await app.request("/json_db/es_bible_book")).status).toBe(404);
  const books = [{ id_bible_book: 67, name: "Génesis" }];
  upstream.mockResolvedValue(new Response(JSON.stringify(books)));
  expect(await (await app.request("/json_db/es_bible_book")).json()).toEqual(
    books,
  );
  expect(await (await app.request("/json_db/es_bible_book")).json()).toEqual(
    books,
  );
  expect(upstream).toHaveBeenCalledTimes(2);
  fixture
    .getDb()
    .prepare("DELETE FROM bible_versions WHERE language = 'es'")
    .run();
  const versions = await app.request("/json_db/es_bible_version");
  expect(versions.status).toBe(200);
  expect((await versions.json()).length).toBeGreaterThan(0);
});
it("abreviações inválidas usam identificador textual ou vazio", async () => {
  const insert = fixture
    .getDb()
    .prepare(
      "INSERT INTO bible_versions (id_version,name,language,abbreviation) VALUES (?,?,?,?)",
    );
  for (const [id, abbr] of [
    ["xyz", null],
    ["abc", "null"],
    ["def", "undefined"],
    ["1234567", ""],
  ])
    insert.run(id, "Unknown translation", "pt", abbr);
  const versions = await (
    await app.request("/json_db/pt_bible_version")
  ).json();
  for (const [id, abbr] of [
    ["xyz", "XYZ"],
    ["abc", "ABC"],
    ["def", "DEF"],
    ["1234567", ""],
  ])
    expect(
      versions.find((v: any) => v.id_bible_version === id).abbreviation,
    ).toBe(abbr);
});
