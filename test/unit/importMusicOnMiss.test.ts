import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importMusicById } from "../../src/lib/importMusicOnMiss.js";

vi.mock("../../src/lib/upstream.js", () => ({
  UpstreamError: class extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  },
  fetchUpstream: vi.fn(async (url: string) => {
    if (url.endsWith("/json_db/music_9999")) {
      return new Response(
        JSON.stringify({
          id_music: 9999,
          name: "Hino Teste On Miss",
          url_music: "https://files.louvorja.com.br/musics/teste.mp3",
          duration: "03:21",
          url_instrumental_music:
            "https://files.louvorja.com.br/musics/teste - PB.mp3",
          instrumental_duration: "03:25",
          lyric: [
            {
              id_lyric: 1,
              lyric: "Estrofe um",
              time: "00:00:10",
              order: 1,
              show_slide: true,
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: "Arquivo nao encontrado!" }), {
      status: 404,
    });
  }),
}));

let db: Database.Database;
const dbPath = join(mkdtempSync(join(tmpdir(), "onmiss-")), "t.db");

beforeEach(() => {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS musics (
      id_music INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      id_file_image INTEGER,
      id_file_music INTEGER,
      id_file_instrumental_music INTEGER,
      id_language TEXT DEFAULT 'pt'
    );
    CREATE TABLE IF NOT EXISTS files (
      id_file INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, path TEXT, type TEXT, url TEXT UNIQUE,
      size INTEGER DEFAULT 0, dir TEXT, file_name TEXT,
      duration TEXT, image_position INTEGER
    );
    CREATE TABLE IF NOT EXISTS lyrics (
      id_lyric INTEGER PRIMARY KEY AUTOINCREMENT,
      id_music INTEGER NOT NULL,
      lyric TEXT NOT NULL,
      aux_lyric TEXT,
      id_file_image INTEGER,
      time TEXT DEFAULT '00:00:00',
      instrumental_time TEXT DEFAULT '00:00:00',
      show_slide INTEGER DEFAULT 1,
      "order" INTEGER DEFAULT 0,
      id_language TEXT DEFAULT 'pt'
    );
  `);
});

describe("importMusicById (fetch on-miss)", () => {
  it("importa musica inexistente: musics + files + lyrics", async () => {
    const ok = await importMusicById(9999, db);
    expect(ok).toBe(true);

    const music = db
      .prepare("SELECT * FROM musics WHERE id_music = 9999")
      .get() as any;
    expect(music).toBeTruthy();
    expect(music.name).toBe("Hino Teste On Miss");
    expect(music.id_file_music).toBeGreaterThan(0);
    expect(music.id_file_instrumental_music).toBeGreaterThan(0);

    const lyrics = db
      .prepare('SELECT * FROM lyrics WHERE id_music = 9999 ORDER BY "order"')
      .all() as any[];
    expect(lyrics).toHaveLength(1);
    expect(lyrics[0].lyric).toBe("Estrofe um");

    const files = db
      .prepare("SELECT url FROM files WHERE url LIKE '%teste%'")
      .all() as any[];
    expect(files).toHaveLength(2);
  });

  it("retorna false quando upstream nao tem a musica", async () => {
    const ok = await importMusicById(8888, db);
    expect(ok).toBe(false);
    const music = db
      .prepare("SELECT * FROM musics WHERE id_music = 8888")
      .get();
    expect(music).toBeFalsy();
  });

  it("nao duplica files nem lyrics em re-import (idempotente)", async () => {
    await importMusicById(9999, db);
    await importMusicById(9999, db);
    const files = db
      .prepare("SELECT COUNT(*) as n FROM files WHERE url LIKE '%teste%'")
      .get() as any;
    const lyrics = db
      .prepare("SELECT COUNT(*) as n FROM lyrics WHERE id_music = 9999")
      .get() as any;
    expect(files.n).toBe(2);
    expect(lyrics.n).toBe(1);
  });
});

it("importa imagens e estrofe sem identificador opcional", async () => {
  const upstream = await import("../../src/lib/upstream.js");
  vi.mocked(upstream.fetchUpstream).mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        id_music: 7777,
        name: "Optional media",
        url_image: "https://files.louvorja.com.br/optional.jpg",
        lyric: [
          {
            lyric: "Verse",
            url_image: "https://files.louvorja.com.br/verse.jpg",
          },
        ],
      }),
    ),
  );
  expect(await importMusicById(7777, db)).toBe(true);
  expect(
    db
      .prepare(
        "SELECT image_position FROM files WHERE url LIKE '%optional.jpg'",
      )
      .get(),
  ).toEqual({ image_position: null });
  const verse = db
    .prepare(
      "SELECT id_lyric,lyric,id_file_image FROM lyrics WHERE id_music=7777",
    )
    .get() as any;
  expect(verse.id_lyric).toBeGreaterThan(0);
  expect(verse.lyric).toBe("Verse");
  expect(verse.id_file_image).toBeGreaterThan(0);
});
