import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB temporario dedicado ANTES de qualquer import do app
const tmpDir = mkdtempSync(join(tmpdir(), "piano-seeded-"));
const originalDbPath = process.env.DB_PATH;
process.env.DB_PATH = join(tmpDir, "test.db");
process.env.PORT = "0";

const { initDb, getDb, closeDb } = await import("../../src/db/connection.js");

let router: any;

beforeAll(async () => {
  await initDb();
  const db = getDb();
  db.pragma("foreign_keys = OFF");

  // ===== SEED =====
  db.exec(`
    INSERT OR IGNORE INTO languages (id_language, name) VALUES ('pt','Portugues'), ('es','Espanhol');

    INSERT INTO files (id_file, name, path, type, url, size, dir, file_name, duration, version, image_position)
    VALUES
      (1,'img1','img/img1.jpg','image','https://cdn/img1.jpg',10,'img','img1.jpg',NULL,1,4),
      (2,'mus1','mp3/m1.mp3','audio','https://cdn/m1.mp3',200,'mp3','m1.mp3','00:03:20',1,NULL),
      (3,'inst1','mp3/i1.mp3','audio','https://cdn/i1.mp3',200,'mp3','i1.mp3','00:03:25',1,NULL),
      (4,'img2','img/img2.jpg','image','https://cdn/img2.jpg',10,'img','img2.jpg',NULL,1,7),
      (5,'img_album','img/alb.jpg','image','https://cdn/alb.jpg',10,'img','alb.jpg',NULL,1,NULL);

    INSERT INTO albums (id_album, name, id_file_image, color, id_language) VALUES
      (20,'Album Cheio',5,'#112233','pt'),
      (21,'Album Vazio',NULL,NULL,'pt');

    INSERT INTO musics (id_music, name, id_file_image, id_file_music, id_file_instrumental_music, id_language) VALUES
      (30,'Musica Cheia',1,2,3,'pt'),
      (31,'Musica Nula',NULL,NULL,NULL,'pt'),
      (32,'Musica Sem Album',NULL,NULL,NULL,'pt');

    INSERT INTO lyrics (id_lyric, id_music, lyric, aux_lyric, id_file_image, time, instrumental_time, show_slide, "order", id_language) VALUES
      (1,30,'Solo ao Deus de Israel','aux',1,'00:10','00:12',1,1,'pt'),
      (2,31,'Letra sem imagem','aux',NULL,'00:20','00:00:00',0,1,'pt');

    INSERT INTO albums_musics (id_album, id_music, track, id_language) VALUES
      (20,30,1,'pt'), (21,31,1,'pt');

    CREATE TABLE bible_chapters (
      id_bible_chapter INTEGER PRIMARY KEY,
      id_bible_book INTEGER NOT NULL,
      id_language TEXT NOT NULL,
      chapter INTEGER NOT NULL
    );
    INSERT INTO bible_chapters (id_bible_chapter, id_bible_book, id_language, chapter) VALUES
      (1,50,'pt',1);

    INSERT INTO categories (id_category, name, id_language, slug, "order", type) VALUES
      (11,'Coletanea Teste','pt','coletanea',5,'collection'),
      (12,'Hinario Teste','pt','hymnal',6,'hymnal');

    INSERT INTO categories_albums (id_category, id_album, "order", id_language) VALUES
      (11,20,1,'pt'),
      (12,20,2,'pt'),
      (11,21,2,'pt');

    DROP TABLE bible_verses;
    CREATE TABLE bible_verses (
      id_verse INTEGER PRIMARY KEY,
      id_bible_chapter INTEGER NOT NULL,
      verse INTEGER NOT NULL,
      text TEXT NOT NULL
    );

    INSERT INTO bible_versions (id_version, name, language, abbreviation) VALUES
      ('acf','Almeida Revisada','pt','ACF');

    INSERT INTO bible_books (id_book, name, abbreviation, chapters, book_number, id_language, testament, keywords, color) VALUES
      (50,'Gálatas','Gl',6,48,'pt',2,'cristo,liberdade','#1a2b3c');

    INSERT INTO bible_verses (id_bible_chapter, verse, text) VALUES
      (1,1,'Paulo, apostolo');

    INSERT INTO bible_versions (id_version, name, language, abbreviation) VALUES
      ('10','Reina-Valera','es','RV'),
      ('12','Las Sagradas Escrituras','es','SEV');

    INSERT INTO bible_books (id_book, name, abbreviation, chapters, book_number, id_language, testament, keywords, color) VALUES
      (67,'Génesis','Gn',50,1,'es',1,'genesis','#01a2d9'),
      (68,'Éxodo','Ex',40,2,'es',1,'exodo','#01a2d9');
  `);

  const { createApp } = await import("../../src/app.js");
  router = createApp();
});

afterAll(() => {
  closeDb();
  if (originalDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalDbPath;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

// helper: dropa tabela (deixa ausente) — rotas devem cair no catch 500
function dropTable(table: string) {
  getDb().exec(`DROP TABLE IF EXISTS "${table}"`);
}

describe("coverage gaps — seeded temp DB", () => {
  describe("compat /json_db — branches de dados (nulos e preenchidos)", () => {
    it("pt_categories: album cheio (url_image/color) e album vazio (nulls)", async () => {
      const res = await router.request("/json_db/pt_categories");
      expect(res.status).toBe(200);
      const data = await res.json();
      const coletanea = data.find((c: any) => c.id_category === 11);
      expect(coletanea.albums).toHaveLength(2);
      expect(coletanea.albums[0].url_image).toBe("https://cdn/alb.jpg");
      expect(coletanea.albums[0].subtitle).toBe("");
      expect(coletanea.albums[1].url_image).toBeNull();
    });

    it("pt_musics: duration/lyric preenchidos e musics sem album/lyric", async () => {
      const res = await router.request("/json_db/pt_musics");
      const data = await res.json();
      const cheia = data.find((m: any) => m.id_music === 30);
      const semAlbum = data.find((m: any) => m.id_music === 32);
      expect(cheia.duration).toBe("00:03:20");
      expect(cheia.lyric).toContain("Solo ao Deus de Israel");
      expect(cheia.albums_names).toBe("Album Cheio|Album Cheio");
      expect(semAlbum.albums_names).toBeNull();
      const vazia = data.find((m: any) => m.id_music === 31);
      expect(vazia.albums_names).toBe("Album Vazio");
    });

    it("music_31 com todos os campos nulos (branches || null e ?? null)", async () => {
      const res = await router.request("/json_db/music_31");
      const m = await res.json();
      expect(m.duration).toBeNull();
      expect(m.instrumental_duration).toBeNull();
      expect(m.url_image).toBeNull();
      expect(m.image_position).toBeNull();
      expect(m.url_music).toBeNull();
      expect(m.url_instrumental_music).toBeNull();
      expect(m.lyric[0].url_image).toBeNull();
      expect(m.lyric[0].image_position).toBeNull();
      expect(m.lyric[0].instrumental_time).toBe("00:20"); // 00:00:00 → time
      expect(m.lyric[0].show_slide).toBe(0);
      expect(m.albums).toHaveLength(1); // album 21 (vazio) via categories type collection
      expect(m.albums[0].url_image).toBeNull();
    });

    it("music_30 com campos preenchidos (image_position, instrumental_time custom)", async () => {
      const res = await router.request("/json_db/music_30");
      const m = await res.json();
      expect(m.url_image).toBe("https://cdn/img1.jpg");
      expect(m.image_position).toBe(4);
      expect(m.instrumental_duration).toBe("00:03:25");
      expect(m.lyric[0].instrumental_time).toBe("00:12");
      expect(m.albums[0].url_image).toBe("https://cdn/alb.jpg");
    });

    it("album_20 com 2 categorias e album_21 sem categorias", async () => {
      const res20 = await router.request("/json_db/album_20");
      const a20 = await res20.json();
      expect(a20.categories).toContain("collection.coletanea");
      expect(a20.categories).toContain("hymnal.hymnal");
      expect(a20.url_image).toBe("https://cdn/alb.jpg");
      expect(a20.musics).toHaveLength(1);
      expect(a20.musics[0].has_instrumental_music).toBe(1);

      const res21 = await router.request("/json_db/album_21");
      const a21 = await res21.json();
      expect(a21.url_image).toBeNull();
      expect(a21.categories).toContain("collection.coletanea");
      expect(a21.musics).toHaveLength(1); // music 31
      expect(a21.musics[0].has_instrumental_music).toBe(0);
    });

    it("pt_hymnal e pt_hymnal_1996 retornam musicas do hinario", async () => {
      const res = await router.request("/json_db/pt_hymnal");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.some((m: any) => m.id_music === 30)).toBe(true);
      const res96 = await router.request("/json_db/pt_hymnal_1996");
      expect(res96.status).toBe(200);
    });

    it("pt_bible_book e pt_bible_version com colunas novas", async () => {
      const books = await (
        await router.request("/json_db/pt_bible_book")
      ).json();
      expect(books[0].id_bible_book).toBe(50);
      expect(books[0].testament).toBe(2);
      expect(books[0].keywords).toContain("cristo");
      const versions = await (
        await router.request("/json_db/pt_bible_version")
      ).json();
      expect(versions[0].id_bible_version).toBe("acf");
      expect(versions[0].abbreviation).toBe("ACF");
    });

    it("es_bible_book retorna só livros em espanhol", async () => {
      const books = await (
        await router.request("/json_db/es_bible_book")
      ).json();
      expect(books).toHaveLength(2);
      expect(books[0].id_bible_book).toBe(67);
      expect(books[0].name).toBe("Génesis");
      expect(books[0].book_number).toBe(1);
      expect(books[0].testament).toBe(1);
      // nao vaza livro PT (id 50)
      expect(books.some((b: any) => b.id_bible_book === 50)).toBe(false);
    });

    it("es_bible_version retorna só versões em espanhol", async () => {
      const versions = await (
        await router.request("/json_db/es_bible_version")
      ).json();
      expect(versions).toHaveLength(2);
      const rv = versions.find((v: any) => v.id_bible_version === "10");
      expect(rv.name).toBe("Reina-Valera");
      expect(rv.abbreviation).toBe("RV");
      // nao vaza versão PT
      expect(versions.some((v: any) => v.id_bible_version === "acf")).toBe(
        false,
      );
    });

    it("GET /json_db/config retorna metadata", async () => {
      const res = await router.request("/json_db/config");
      expect(res.status).toBe(200);
      const cfg = await res.json();
      expect(cfg.version_number).toBe(1);
      expect(cfg.datetime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("albums com color/track nulos e music 32 sem lyric/albums (branches || null)", async () => {
      getDb().exec(`UPDATE albums SET color = NULL WHERE id_album = 20;`);
      const list = await router.request("/v1/albums?lang=pt");
      const albums = (await list.json()).data;
      const a20 = albums.find((a: any) => a.id_album === 20);
      expect(a20.color).toBeNull();

      const detail = await router.request("/v1/albums/20?lang=pt");
      const alb = await detail.json();
      expect(alb.musics[0].duration).toBe("00:03:20"); // files.fm.duration preenchido
      expect(alb.musics[0].track).toBe(1);

      const detail21 = await router.request("/v1/albums/21?lang=pt");
      const alb21 = await detail21.json();
      expect(alb21.musics[0].duration).toBeNull(); // LEFT JOIN files sem match

      const listMusics = await router.request("/v1/musics?lang=pt");
      const musics = await listMusics.json();
      const m32 = musics.data.find((m: any) => m.id_music === 32);
      expect(m32.lyric).toBeNull();
      expect(m32.albums_names).toBeNull();
      expect(m32.albums).toEqual([]); // albumsByMusic fallback []
    });
    it("categoria collection sem albums → albums vazio (93-94) e /v1/musics vazio (91)", async () => {
      getDb().exec(
        `INSERT INTO categories (id_category, name, id_language, slug, "order", type) VALUES (15,'Vazia','pt','vazia',7,'collection')`,
      );
      const list = await router.request("/v1/categories?lang=pt");
      const cats = await list.json();
      const vazia = cats.find((c: any) => c.id_category === 15);
      expect(vazia.albums).toEqual([]);
    });
  });

  describe("v1 routes — dados completos e erros", () => {
    it("GET /v1/bible?lang=pt lista livros", async () => {
      const res = await router.request("/v1/bible?lang=pt");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data[0].id_bible_book).toBe(50);
      expect(data.data[0].name).toBe("Gálatas");
    });

    it("GET /v1/bible/50/1?lang=pt: 200, 404 livro inexistente, 400 id invalido", async () => {
      const ok = await router.request("/v1/bible/50/1?lang=pt");
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.chapter).toBe(1);
      expect(body.verses[0].text).toContain("Paulo");
      const nf = await router.request("/v1/bible/999/1?lang=pt");
      expect(nf.status).toBe(404);

      const bad = await router.request("/v1/bible/abc/1?lang=pt");
      expect(bad.status).toBe(404); // parseInt NaN → nenhum livro
    });

    it("GET /v1/albums/20 e /v1/categories/11 com dados", async () => {
      const res = await router.request("/v1/albums/20?lang=pt");
      expect(res.status).toBe(200);
      const album = await res.json();
      expect(album.name).toBe("Album Cheio");
      expect(album.musics.length).toBeGreaterThan(0);

      const resCat = await router.request("/v1/categories/11?lang=pt");
      expect(resCat.status).toBe(200);
      const cat = await resCat.json();
      expect(cat.name).toBe("Coletanea Teste");
    });

    it("GET /v1/musics/30 (cheia) e /v1/musics/31 (nula) cobrem || null/?? null", async () => {
      const r30 = await router.request("/v1/musics/30?lang=pt");
      const m30 = await r30.json();
      expect(m30.image_position).toBe(4);
      expect(m30.lyric[0].image_position).toBe(4);
      expect(m30.lyric[0].instrumental_time).toBe("00:12");
      expect(m30.albums).toHaveLength(1); // album 20
      expect(m30.albums[0].url_image).toBe("https://cdn/alb.jpg");

      const r31 = await router.request("/v1/musics/31?lang=pt");
      const m31 = await r31.json();
      expect(m31.duration).toBeNull();
      expect(m31.image_position).toBeNull();
      expect(m31.lyric[0].url_image).toBeNull();
      expect(m31.lyric[0].instrumental_time).toBe("00:20");
      expect(m31.albums).toHaveLength(1); // album 21 sem imagem
      expect(m31.albums[0].url_image).toBeNull();
    });
  });

  describe("catch blocks 500 — tabela dropada e recriada vazia", () => {
    it("/v1/musics com tabela vazia → data [] (branch musicIds vazio)", async () => {
      getDb().exec(`DELETE FROM musics;`);
      const res = await router.request("/v1/musics?lang=pt");
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([]);
    });

    it("album detail sem relacoes em albums_musics → categories vazia (catRow null)", async () => {
      getDb().exec(`DELETE FROM categories_albums; DELETE FROM albums_musics;`);
      const res = await router.request("/json_db/album_20");
      expect(res.status).toBe(200);
      const alb = await res.json();
      expect(alb.categories).toEqual([]);
      expect(alb.musics).toEqual([]);

      const resV1 = await router.request("/v1/albums/20?lang=pt");
      expect(resV1.status).toBe(200);
      const albV1 = await resV1.json();
      expect(albV1.categories).toEqual([]);
    });

    it("GET /v1/musics e /v1/musics/30 retornam 500 sem tabela musics", async () => {
      dropTable("musics");
      const list = await router.request("/v1/musics?lang=pt");
      expect(list.status).toBe(500);
      const detail = await router.request("/v1/musics/30?lang=pt");
      expect(detail.status).toBe(500);
    });

    it("GET /v1/albums e /v1/albums/20 retornam 500 sem tabela albums", async () => {
      dropTable("albums");
      const list = await router.request("/v1/albums?lang=pt");
      expect(list.status).toBe(500);
      const detail = await router.request("/v1/albums/20?lang=pt");
      expect(detail.status).toBe(500);
    });

    it("GET /v1/categories e /v1/categories/11 retornam 500 sem tabela categories", async () => {
      dropTable("categories");
      const list = await router.request("/v1/categories?lang=pt");
      expect(list.status).toBe(500);
      const detail = await router.request("/v1/categories/11?lang=pt");
      expect(detail.status).toBe(500);
    });

    it("GET /v1/bible e /v1/bible/50/1 retornam 500 sem tabela bible_books", async () => {
      dropTable("bible_books");
      dropTable("bible_chapters");
      const list = await router.request("/v1/bible?lang=pt");
      expect(list.status).toBe(500);
      const detail = await router.request("/v1/bible/50/1?lang=pt");
      expect(detail.status).toBe(500);
    });
    it("GET /json_db/arquivo-invalido → 404 (nenhum padrao bate)", async () => {
      const res = await router.request("/json_db/foo_bar");
      expect(res.status).toBe(404);
    });
  });

  describe("bible proxy — cache e 502", () => {
    it("bible_1_50_1 via cache local e 502 quando upstream falha", async () => {
      // Pre-cache: simula arquivo já baixado
      const cacheDir = join(process.cwd(), "data", "bible_cache");
      const cacheFile = join(cacheDir, "bible_1_50_1.json");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ cached: true }), "utf-8");
      const hit = await router.request("/json_db/bible_1_50_1");
      expect(hit.status).toBe(200);
      expect(await hit.json()).toEqual({ cached: true });

      // Cache miss + upstream falha → 502
      try {
        rmSync(join(cacheDir, "bible_999_99_9.json"));
      } catch {}
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("upstream down")),
      );
      const miss = await router.request("/json_db/bible_999_99_9");
      expect(miss.status).toBe(502);

      // Cache miss + upstream responde → 200 + arquivo gravado (cache-hit path)
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
      // Segunda chamada agora serve do cache (fetch não é chamado)
      const fetchCount = (globalThis.fetch as any).mock.calls.length;
      const cached = await router.request("/json_db/bible_888_88_8");
      expect(cached.status).toBe(200);
      expect((globalThis.fetch as any).mock.calls.length).toBe(fetchCount);
    });
  });
});
