import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 9: importMusicById com upstream MOCKADO (fetch global mock) —
 * import feliz (files+musics+lyrics), 404 → false, 500 → throw, payload
 * inválido → false. Sem rede real.
 */
describe("importMusicById (upstream mockado)", () => {
  let app: SeededDb;
  let mod: typeof import("../../src/lib/importMusicOnMiss.js");
  const origFetch = globalThis.fetch;

  beforeAll(async () => {
    app = await setupSeededDb();
    mod = await import("../../src/lib/importMusicOnMiss.js");
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
    app.cleanup();
  });

  function mockFetch(status: number, body: unknown) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as any);
  }

  it("idempotente: música já existente → true sem fetch", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as any;
    const ok = await mod.importMusicById(1, app.getDb());
    expect(ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("404 upstream → false", async () => {
    mockFetch(404, { error: "não encontrado" });
    const ok = await mod.importMusicById(424242, app.getDb());
    expect(ok).toBe(false);
  });

  it("payload sem name → false", async () => {
    mockFetch(200, { error: "algo" });
    const ok = await mod.importMusicById(424243, app.getDb());
    expect(ok).toBe(false);
  });

  it("500 upstream → throw (chamador decide)", async () => {
    mockFetch(500, { error: "boom" });
    await expect(mod.importMusicById(424244, app.getDb())).rejects.toThrow();
  });

  it("import sem mídias (só name) → files null", async () => {
    mockFetch(200, { name: "Só Nome" });
    const ok = await mod.importMusicById(778, app.getDb());
    expect(ok).toBe(true);
    const row = app
      .getDb()
      .prepare(
        "SELECT id_file_image, id_file_music, id_file_instrumental_music FROM musics WHERE id_music = 778",
      )
      .get() as any;
    expect(row.id_file_image).toBeNull();
    expect(row.id_file_music).toBeNull();
  });

  it("import com instrumental e lyric com todos os campos", async () => {
    mockFetch(200, {
      name: "Completa",
      url_image: "https://cdn/img/c.jpg",
      image_position: 2,
      url_music: "https://cdn/mp3/c.mp3",
      duration: "00:01:00",
      url_instrumental_music: "https://cdn/mp3/ci.mp3",
      instrumental_duration: "00:01:05",
      lyric: [
        {
          id_lyric: 901,
          lyric: "V",
          aux_lyric: "A",
          url_image: "https://cdn/img/l.jpg",
          image_position: 1,
          time: "00:09",
          instrumental_time: "00:11",
          show_slide: false,
          order: 3,
        },
        { lyric: "V2" },
      ],
    });
    const ok = await mod.importMusicById(779, app.getDb());
    expect(ok).toBe(true);
    const n = app
      .getDb()
      .prepare("SELECT COUNT(*) c FROM lyrics WHERE id_music = 779")
      .get() as { c: number };
    expect(n.c).toBe(2);
  });

  it("import idempotente com url repetida reaproveita file (branch existingFile)", async () => {
    mockFetch(200, {
      name: "Reusa",
      url_image: "https://cdn/img/c.jpg",
      lyric: [{ lyric: "V", url_image: "https://cdn/img/c.jpg" }],
    });
    const ok = await mod.importMusicById(780, app.getDb());
    expect(ok).toBe(true);
  });

  it("import feliz: importa music + files + lyrics", async () => {
    mockFetch(200, {
      name: "Importada",
      url_image: "https://cdn/img/importada.jpg",
      image_position: 4,
      url_music: "https://cdn/mp3/importada.mp3",
      duration: "00:03:20",
      url_instrumental_music: "https://cdn/mp3/importada_inst.mp3",
      lyric: [
        { lyric: "Verso 1", order: 1, time: "00:10", show_slide: true },
        { lyric: "Verso 2", order: 2, time: "00:20", show_slide: false },
      ],
    });
    const ok = await mod.importMusicById(777, app.getDb());
    expect(ok).toBe(true);

    const row = app
      .getDb()
      .prepare("SELECT name FROM musics WHERE id_music = 777")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("Importada");

    const lyrics = app
      .getDb()
      .prepare("SELECT COUNT(*) c FROM lyrics WHERE id_music = 777")
      .get() as { c: number };
    expect(lyrics.c).toBe(2);
  });
});
