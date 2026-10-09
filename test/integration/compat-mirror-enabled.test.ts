import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

describe("Compat fetch-on-miss and enabled media mirror", () => {
  let app: SeededDb;
  let dir: string;
  const fetchMock = vi.fn<typeof fetch>();
  beforeAll(async () => {
    mkdirSync(join(process.cwd(), "media"), { recursive: true });
    dir = mkdtempSync(join(process.cwd(), "media", "coverage-mirror-"));
    vi.stubGlobal("fetch", fetchMock);
    app = await setupSeededDb({ mediaMirror: "on", onMiss: "on" });
  });
  afterEach(() => fetchMock.mockReset());
  afterAll(() => {
    app.cleanup();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });
  const file = (name: string) => `/file/${basename(dir)}/${name}`;

  it("imports a missing music and serves the actual imported data", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id_music: 777001,
          name: "Imported",
          url_music: "https://cdn.test/audio.mp3",
          url_instrumental_music: "https://cdn.test/instrumental.mp3",
          lyric: [{ lyric: "Verse", url_image: "https://cdn.test/image.jpg" }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const response = await app.router.request("/json_db/music_777001");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id_music: 777001,
      name: "Imported",
      lyric: [expect.objectContaining({ lyric: "Verse" })],
    });
    expect(
      app
        .getDb()
        .prepare("SELECT name FROM musics WHERE id_music = 777001")
        .get(),
    ).toEqual({ name: "Imported" });
    const calls = fetchMock.mock.calls.length;
    expect((await app.router.request("/json_db/music_777001")).status).toBe(
      200,
    );
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });
  it("a definitively missing upstream music remains 404", async () => {
    fetchMock.mockResolvedValue(new Response("missing", { status: 404 }));
    expect((await app.router.request("/json_db/music_777002")).status).toBe(
      404,
    );
  });
  it("upstream network failure does not change missing music into a 500", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect((await app.router.request("/json_db/music_777003")).status).toBe(
      404,
    );
  });
  it("downloads media, stores it, and serves the cached bytes without another fetch", async () => {
    fetchMock.mockResolvedValue(
      new Response("audio bytes", {
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    const response = await app.router.request(file("download.mp3"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(await response.text()).toBe("audio bytes");
    expect(readFileSync(join(dir, "download.mp3"), "utf8")).toBe("audio bytes");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await app.router.request(file("download.mp3"))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("a successful mirror response without MIME uses octet-stream", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const response = await app.router.request(file("no-mime.mp3"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
  it("caches a miss after all mirror hosts fail instead of repeatedly fetching", async () => {
    fetchMock.mockResolvedValue(new Response("missing", { status: 404 }));
    expect((await app.router.request(file("missing.mp3"))).status).toBe(302);
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect((await app.router.request(file("missing.mp3"))).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });
  it("falls back to the next mirror host after a network failure", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("fallback"));
    const response = await app.router.request(file("fallback.mp3"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fallback");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("caps concurrent downloads and releases slots after a failure", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async () => {
      await barrier;
      return new Response("missing", { status: 404 });
    });
    const pending = Array.from({ length: 8 }, (_, i) =>
      app.router.request(file(`busy-${i}.mp3`)),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
    const ninth = await app.router.request(file("ninth.mp3"));
    expect(ninth.status).toBe(503);
    expect(await ninth.json()).toEqual({
      error: "Mirror ocupado, tente novamente",
    });
    release();
    await Promise.all(pending);
    fetchMock.mockResolvedValue(new Response("available"));
    expect((await app.router.request(file("available.mp3"))).status).toBe(200);
  });
});
