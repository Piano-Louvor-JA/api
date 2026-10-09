import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SeededDb {
  router: any;
  cleanup: () => void;
  getDb: () => ReturnType<typeof import("../../src/db/connection.js").getDb>;
}

/**
 * Cria um DB sqlite temporário, roda migrations + seed determinístico
 * e retorna o router da app apontando para ele.
 * Sempre chame cleanup() no afterAll.
 */
export async function setupSeededDb(
  options: { mediaMirror?: "on" | "off"; onMiss?: "on" | "off" } = {},
): Promise<SeededDb> {
  const tmpDir = mkdtempSync(join(tmpdir(), "piano-seed-"));
  const originalDbPath = process.env.DB_PATH;
  const originalOnMiss = process.env.ON_MISS_FETCH;
  const originalMirror = process.env.MEDIA_MIRROR;
  process.env.DB_PATH = join(tmpDir, "test.db");
  process.env.PORT = "0";
  // Evita fetch real ao upstream em /json_db/music_{id} (timeouts flaky no CI).
  process.env.ON_MISS_FETCH = options.onMiss ?? "off";
  // Evita download on-demand em /file/* (mesmo problema de timeout).
  process.env.MEDIA_MIRROR = options.mediaMirror ?? "off";

  const { initDb, getDb, closeDb } = await import("../../src/db/connection.js");

  await initDb();
  const db = getDb();
  db.pragma("foreign_keys = OFF");

  db.exec(`
    INSERT OR IGNORE INTO languages (id_language, name) VALUES ('pt','Portugues'), ('es','Espanhol');

    INSERT INTO files (id_file, name, path, type, url, size, dir, file_name, duration, version, image_position)
    VALUES
      (1,'img1','img/img1.jpg','image','https://cdn/img1.jpg',10,'img','img1.jpg',NULL,1,4),
      (2,'mus1','mp3/m1.mp3','audio','https://cdn/m1.mp3',200,'mp3','m1.mp3','00:03:20',1,NULL),
      (3,'inst1','mp3/i1.mp3','audio','https://cdn/i1.mp3',200,'mp3','i1.mp3','00:03:25',1,NULL),
      (4,'img_album','img/alb.jpg','image','https://cdn/alb.jpg',10,'img','alb.jpg',NULL,1,NULL);

    INSERT INTO albums (id_album, name, id_file_image, color, id_language) VALUES
      (1,'Album Um',4,'#112233','pt'),
      (20,'Album Cheio',4,'#112233','pt'),
      (21,'Album Vazio',NULL,NULL,'pt');

    INSERT INTO musics (id_music, name, id_file_image, id_file_music, id_file_instrumental_music, id_language) VALUES
      (1,'Musica Um',1,2,3,'pt'),
      (30,'Musica Cheia',1,2,3,'pt'),
      (31,'Musica Nula',NULL,NULL,NULL,'pt');

    INSERT INTO lyrics (id_lyric, id_music, lyric, aux_lyric, id_file_image, time, instrumental_time, show_slide, "order", id_language) VALUES
      (1,1,'Solo ao Deus de Israel','aux',1,'00:10','00:12',1,1,'pt'),
      (2,30,'Solo ao Deus de Israel','aux',1,'00:10','00:12',1,1,'pt'),
      (3,31,'Letra sem imagem','aux',NULL,'00:20','00:00:00',0,1,'pt');

    INSERT INTO albums_musics (id_album, id_music, track, id_language) VALUES
      (1,1,1,'pt'), (20,30,1,'pt'), (21,31,1,'pt');

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
      (11,1,1,'pt'), (11,20,1,'pt'), (12,20,2,'pt'), (11,21,2,'pt');

    DROP TABLE IF EXISTS bible_verses;
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
  `);

  const { createApp } = await import("../../src/app.js");
  const router = createApp();

  const cleanup = () => {
    closeDb();
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    if (originalOnMiss === undefined) delete process.env.ON_MISS_FETCH;
    else process.env.ON_MISS_FETCH = originalOnMiss;
    if (originalMirror === undefined) delete process.env.MEDIA_MIRROR;
    else process.env.MEDIA_MIRROR = originalMirror;
    rmSync(tmpDir, { recursive: true, force: true });
  };

  return { router, cleanup, getDb };
}
