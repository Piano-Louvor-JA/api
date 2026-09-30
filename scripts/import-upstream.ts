/**
 * Script de importacao do catalogo louvorja.com.br
 * Baixa de /json_db/ (formato cru, sem wrapper) e /db/ (com wrapper {data,meta})
 * Salva no SQLite com paridade completa de dados.
 *
 * Uso: npx tsx scripts/import-upstream.ts
 * Env: UPSTREAM_API (default: https://api.louvorja.com.br)
 *      DB_PATH (default: ./data/catalog.db)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

const UPSTREAM = process.env.UPSTREAM_API ?? "https://api.louvorja.com.br";
const DB_PATH = process.env.DB_PATH ?? "./data/catalog.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Rodar migrations (com try/catch pra ALTER TABLE duplicado)
const migrationsDir = join(process.cwd(), "src", "db", "migrations");
if (existsSync(migrationsDir)) {
  const files = readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    try {
      db.exec(readFileSync(join(migrationsDir, file), "utf-8"));
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }
  }
  console.log(`${files.length} migrations aplicadas`);
}

// ==============================================
// Helpers
// ==============================================

async function fetchJson(path: string): Promise<any> {
  const url = `${UPSTREAM}${path}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  FAIL ${res.status}: ${url}`);
        return null;
      }
      return res.json();
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(attempt * 500);
    }
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureLanguages() {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO languages (id_language, name) VALUES (?, ?)",
  );
  insert.run("pt", "Portugues");
  insert.run("en", "English");
  insert.run("es", "Espanol");
  console.log("Linguagens garantidas: pt, en, es");
}

/**
 * Converte path do upstream (ex: /musics/pt/album/song.mp3) em dir + file_name.
 * dir = tudo ate a ultima /, file_name = ultima parte.
 */
function parseFilePath(fullPath: string): { dir: string; file_name: string } {
  const idx = fullPath.lastIndexOf("/");
  if (idx === -1) return { dir: "/", file_name: fullPath };
  return {
    dir: fullPath.substring(0, idx),
    file_name: fullPath.substring(idx + 1),
  };
}

// ==============================================
// 1. CONFIG (version metadata)
// ==============================================

async function importConfig() {
  console.log("\n=== IMPORTANDO CONFIG ===");
  const config = await fetchJson("/json_db/config");
  if (!config) {
    console.log("  Sem config");
    return;
  }
  console.log(
    `  version: ${config.version_number}, updated: ${config.latest_updated}`,
  );
  // Salvar como registro unico na tabela licenses? Nao, guardar em memoria.
  // O app consome via /json_db/config que as rotas compat ja servem.
}

// ==============================================
// 2. CATEGORIAS + ALBUMS (com slug, type, order)
// ==============================================

async function importCategoriesWithAlbums(lang = "pt") {
  console.log(`\n=== IMPORTANDO CATEGORIAS (${lang}) ===`);

  // O upstream serve /json_db/{lang}_categories (array cru, sem wrapper)
  const categories = await fetchJson(`/json_db/${lang}_categories`);

  if (!Array.isArray(categories)) {
    console.log("  Sem categorias (resposta nao e array)");
    return { categories: 0, albums: 0 };
  }

  const insertCat = db.prepare(`
    INSERT OR REPLACE INTO categories (id_category, name, slug, "order", type, id_language)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertAlbum = db.prepare(`
    INSERT OR REPLACE INTO albums (id_album, name, id_file_image, color, id_language)
    VALUES (?, ?, NULL, ?, ?)
  `);

  const insertCatAlbum = db.prepare(`
    INSERT OR REPLACE INTO categories_albums (id_category, id_album, name, "order", id_language)
    VALUES (?, ?, ?, ?, ?)
  `);

  // Inserir ou atualizar file
  const insertFile = db.prepare(`
    INSERT OR REPLACE INTO files (name, path, type, url, size, dir, file_name)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `);

  let catCount = 0;
  let albumCount = 0;

  for (const cat of categories) {
    insertCat.run(
      cat.id_category,
      cat.name,
      cat.slug || null,
      cat.order ?? 0,
      "collection",
      lang,
    );
    catCount++;

    if (cat.albums && Array.isArray(cat.albums)) {
      for (const album of cat.albums) {
        let imageFileId: number | null = null;

        // Importar capa do album se tiver url_image
        if (album.url_image) {
          const { dir, file_name } = parseFilePath(album.url_image);
          // Gerar ID unico deterministico baseado no path
          const fileKey = album.url_image;
          // Buscar se ja existe
          const existing = db
            .prepare("SELECT id_file FROM files WHERE url = ?")
            .get(fileKey) as any;
          if (existing) {
            imageFileId = existing.id_file;
          } else {
            const result = insertFile.run(
              file_name,
              fileKey,
              "image",
              fileKey,
              dir,
              file_name,
            );
            imageFileId = Number(result.lastInsertRowid);
          }
        }

        insertAlbum.run(
          album.id_album,
          album.name,
          album.color || "#000000",
          lang,
        );

        // Atualizar id_file_image do album
        if (imageFileId) {
          db.prepare(
            "UPDATE albums SET id_file_image = ? WHERE id_album = ?",
          ).run(imageFileId, album.id_album);
        }

        insertCatAlbum.run(
          cat.id_category,
          album.id_album,
          album.subtitle || null,
          album.order ?? 0,
          lang,
        );
        albumCount++;
      }
    }
  }

  console.log(`  ${catCount} categorias, ${albumCount} albums`);
  return { categories: catCount, albums: albumCount };
}

// ==============================================
// 3. MUSICAS (com letra texto, albums com track)
// ==============================================

async function importMusics(lang = "pt") {
  console.log(`\n=== IMPORTANDO MUSICAS (${lang}) ===`);

  // /json_db/{lang}_musics retorna array cru de todas as musicas
  const musics = await fetchJson(`/json_db/${lang}_musics`);

  if (!Array.isArray(musics)) {
    console.log("  Sem musicas (resposta nao e array)");
    return 0;
  }

  console.log(`  Total: ${musics.length} musicas`);

  const insertMusic = db.prepare(`
    INSERT OR REPLACE INTO musics (id_music, name, id_file_image, id_file_music, id_file_instrumental_music, id_language)
    VALUES (?, ?, NULL, NULL, NULL, ?)
  `);

  const ensureAlbum = db.prepare(`
    INSERT OR IGNORE INTO albums (id_album, name, id_file_image, color, id_language)
    VALUES (?, ?, NULL, '#000000', ?)
  `);

  const insertAlbumMusic = db.prepare(`
    INSERT OR REPLACE INTO albums_musics (id_album, id_music, track, id_language)
    VALUES (?, ?, ?, ?)
  `);

  // Limpar letras simplificadas antes de importar
  // (as detalhadas virao no importMusicDetails)
  const deleteLyrics = db.prepare("DELETE FROM lyrics WHERE id_music = ?");

  let count = 0;

  for (const music of musics) {
    insertMusic.run(music.id_music, music.name, lang);

    // Processar albums da musica (agora vem como array de objetos com pivot)
    if (music.albums && Array.isArray(music.albums)) {
      for (const alb of music.albums) {
        const albumId = alb.id_album ?? (typeof alb === "number" ? alb : null);
        if (!albumId) continue;
        const albumName = alb.name ?? `Album ${albumId}`;
        const track = alb.pivot?.track ?? alb.track ?? null;

        ensureAlbum.run(albumId, albumName, lang);
        insertAlbumMusic.run(albumId, music.id_music, track, lang);
      }
    }

    // Inserir letra como texto completo (sera substituida por estrofes detalhadas depois)
    if (music.lyric) {
      deleteLyrics.run(music.id_music);
      db.prepare(`
        INSERT INTO lyrics (id_music, lyric, aux_lyric, id_file_image, time, instrumental_time, show_slide, "order", id_language)
        VALUES (?, ?, NULL, NULL, '00:00:00', '00:00:00', 1, 1, ?)
      `).run(music.id_music, music.lyric, lang);
    }

    count++;
    if (count % 200 === 0) {
      process.stdout.write(`\r  ${count}/${musics.length} musicas`);
    }
  }

  console.log(`\n  ${count} musicas importadas`);
  return count;
}

// ==============================================
// 4. DETALHES DE CADA MUSICA (audio, imagem, estrofes com timing)
// ==============================================

async function importMusicDetails(lang = "pt") {
  console.log(
    `\n=== IMPORTANDO DETALHES DE MUSICAS (audio, imagem, estrofes) ===`,
  );

  const musics = db
    .prepare(
      `SELECT id_music FROM musics WHERE id_language = ? ORDER BY id_music`,
    )
    .all(lang) as { id_music: number }[];

  console.log(`  ${musics.length} musicas precisam de detalhes`);

  const insertFile = db.prepare(`
    INSERT INTO files (name, path, type, url, size, dir, file_name, duration, image_position)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
  `);

  const updateMusicFiles = db.prepare(`
    UPDATE musics SET id_file_image = ?, id_file_music = ?, id_file_instrumental_music = ?
    WHERE id_music = ?
  `);

  const deleteLyrics = db.prepare("DELETE FROM lyrics WHERE id_music = ?");

  const insertDetailedLyric = db.prepare(`
    INSERT OR REPLACE INTO lyrics (id_lyric, id_music, lyric, aux_lyric, id_file_image, time, instrumental_time, show_slide, "order", id_language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Buscar ou criar file de imagem de estrofe
  const findFileByUrl = db.prepare("SELECT id_file FROM files WHERE url = ?");

  let count = 0;
  let fails = 0;

  for (const m of musics) {
    // /json_db/music_{id} retorna objeto cru (sem wrapper)
    const detail = await fetchJson(`/json_db/music_${m.id_music}`);

    if (!detail || detail.error) {
      fails++;
      continue;
    }

    let imageFileId: number | null = null;
    let musicFileId: number | null = null;
    let instrumentalFileId: number | null = null;

    // URL da imagem da musica
    if (detail.url_image) {
      const existing = findFileByUrl.get(detail.url_image) as any;
      if (existing) {
        imageFileId = existing.id_file;
      } else {
        const { dir, file_name } = parseFilePath(detail.url_image);
        const result = insertFile.run(
          file_name,
          detail.url_image,
          "image",
          detail.url_image,
          dir,
          file_name,
          null,
          detail.image_position ?? null,
        );
        imageFileId = Number(result.lastInsertRowid);
      }
    }

    // URL do audio cantado
    if (detail.url_music) {
      const existing = findFileByUrl.get(detail.url_music) as any;
      if (existing) {
        musicFileId = existing.id_file;
      } else {
        const { dir, file_name } = parseFilePath(detail.url_music);
        const result = insertFile.run(
          file_name,
          detail.url_music,
          "audio",
          detail.url_music,
          dir,
          file_name,
          detail.duration ?? null,
          null,
        );
        musicFileId = Number(result.lastInsertRowid);
      }
    }

    // URL do audio instrumental
    if (detail.url_instrumental_music) {
      const existing = findFileByUrl.get(detail.url_instrumental_music) as any;
      if (existing) {
        instrumentalFileId = existing.id_file;
      } else {
        const { dir, file_name } = parseFilePath(detail.url_instrumental_music);
        const result = insertFile.run(
          file_name,
          detail.url_instrumental_music,
          "audio",
          detail.url_instrumental_music,
          dir,
          file_name,
          detail.instrumental_duration ?? null,
          null,
        );
        instrumentalFileId = Number(result.lastInsertRowid);
      }
    }

    updateMusicFiles.run(
      imageFileId,
      musicFileId,
      instrumentalFileId,
      m.id_music,
    );

    // Inserir estrofes detalhadas (com timing, show_slide, order, url_image)
    if (
      detail.lyric &&
      Array.isArray(detail.lyric) &&
      detail.lyric.length > 0
    ) {
      deleteLyrics.run(m.id_music);

      for (const lyric of detail.lyric) {
        let lyricImageFileId: number | null = null;

        if (lyric.url_image) {
          const existing = findFileByUrl.get(lyric.url_image) as any;
          if (existing) {
            lyricImageFileId = existing.id_file;
          } else {
            const { dir, file_name } = parseFilePath(lyric.url_image);
            const result = insertFile.run(
              file_name,
              lyric.url_image,
              "image",
              lyric.url_image,
              dir,
              file_name,
              null,
              lyric.image_position ?? null,
            );
            lyricImageFileId = Number(result.lastInsertRowid);
          }
        }

        insertDetailedLyric.run(
          lyric.id_lyric ?? null,
          m.id_music,
          lyric.lyric || "",
          lyric.aux_lyric || null,
          lyricImageFileId,
          lyric.time || "00:00:00",
          lyric.instrumental_time || "00:00:00",
          lyric.show_slide ? 1 : 0,
          lyric.order ?? 0,
          lang,
        );
      }
    }

    count++;
    if (count % 50 === 0) {
      process.stdout.write(
        `\r  ${count}/${musics.length} processadas (${fails} falhas)`,
      );
    }

    await sleep(30);
  }

  console.log(`\n  ${count}/${musics.length} processadas (${fails} falhas)`);
  return count;
}

// ==============================================
// 5. ALBUMS: importar track e has_instrumental_music
// ==============================================

async function importAlbumDetails(lang = "pt") {
  console.log(`\n=== IMPORTANDO DETALHES DE ALBUMS (musics com track) ===`);

  const albums = db
    .prepare(
      `SELECT id_album FROM albums WHERE id_language = ? ORDER BY id_album`,
    )
    .all(lang) as { id_album: number }[];

  console.log(`  ${albums.length} albums para processar`);

  const updateAlbumMusicTrack = db.prepare(`
    UPDATE albums_musics SET track = ? WHERE id_album = ? AND id_music = ?
  `);

  let count = 0;
  let fails = 0;

  for (const a of albums) {
    const detail = await fetchJson(`/json_db/album_${a.id_album}`);

    if (!detail || detail.error) {
      fails++;
      continue;
    }

    // Atualizar track de cada musica no album
    if (detail.musics && Array.isArray(detail.musics)) {
      for (const music of detail.musics) {
        updateAlbumMusicTrack.run(
          music.track ?? null,
          a.id_album,
          music.id_music,
        );
      }
    }

    count++;
    if (count % 50 === 0) {
      process.stdout.write(
        `\r  ${count}/${albums.length} albums (${fails} falhas)`,
      );
    }

    await sleep(30);
  }

  console.log(
    `\n  ${count}/${albums.length} albums processados (${fails} falhas)`,
  );
  return count;
}

// ==============================================
// 6. HINARIOS (pt_hymnal, pt_hymnal_1996)
// ==============================================

async function importHymnals(lang = "pt") {
  console.log(`\n=== IMPORTANDO HINARIOS (${lang}) ===`);

  // O upstream serve /json_db/{lang}_hymnal que e a lista de musicas do hinario
  // Essas musicas pertencem a albums que tem categoria slug='hymnal' no MySQL original
  // Precisamos criar essas categorias no nosso SQLite e linkar os albums

  // Criar categoria hymnal se nao existir
  db.prepare(`
    INSERT OR IGNORE INTO categories (id_category, name, slug, "order", type, id_language)
    VALUES (100, 'Hinario Adventista', 'hymnal', 0, 'hymnal', ?)
  `).run(lang);

  db.prepare(`
    INSERT OR IGNORE INTO categories (id_category, name, slug, "order", type, id_language)
    VALUES (101, 'Hinario Adventista 1996', 'hymnal_1996', 1, 'hymnal', ?)
  `).run(lang);

  // Importar pt_hymnal: ja sao as musicas com track do hinario
  const hymnal = await fetchJson(`/json_db/${lang}_hymnal`);
  if (Array.isArray(hymnal)) {
    console.log(`  ${lang}_hymnal: ${hymnal.length} hinos`);

    // Linkar cada musica ao album do hinario via categoria hymnal
    // O hinario adventista e um album so (geralmente id_album do primeiro album da categoria)
    // Como nao temos o id_album exato do upstream, criar um album virtual
    db.prepare(`
      INSERT OR IGNORE INTO albums (id_album, name, id_file_image, color, id_language)
      VALUES (1000, 'Hinario Adventista', NULL, '#1a472a', ?)
    `).run(lang);

    db.prepare(`
      INSERT OR IGNORE INTO categories_albums (id_category, id_album, name, "order", id_language)
      VALUES (100, 1000, 'Hinario Adventista', 0, ?)
    `).run(lang);

    // Para cada musica do hinario, garantir track no albums_musics
    const updateTrack = db.prepare(`
      UPDATE albums_musics SET track = ? WHERE id_album = 1000 AND id_music = ?
    `);
    const insertAlbumMusic = db.prepare(`
      INSERT OR IGNORE INTO albums_musics (id_album, id_music, track, id_language)
      VALUES (1000, ?, ?, ?)
    `);

    for (const h of hymnal) {
      if (h.id_music && h.track != null) {
        insertAlbumMusic.run(h.id_music, h.track, lang);
      }
    }
  }

  // Mesma coisa pro hinario 1996
  const hymnal1996 = await fetchJson(`/json_db/${lang}_hymnal_1996`);
  if (Array.isArray(hymnal1996)) {
    console.log(`  ${lang}_hymnal_1996: ${hymnal1996.length} hinos`);

    db.prepare(`
      INSERT OR IGNORE INTO albums (id_album, name, id_file_image, color, id_language)
      VALUES (1001, 'Hinario Adventista 1996', NULL, '#0d3b1f', ?)
    `).run(lang);

    db.prepare(`
      INSERT OR IGNORE INTO categories_albums (id_category, id_album, name, "order", id_language)
      VALUES (101, 1001, 'Hinario Adventista 1996', 1, ?)
    `).run(lang);

    const insertAlbumMusic1996 = db.prepare(`
      INSERT OR IGNORE INTO albums_musics (id_album, id_music, track, id_language)
      VALUES (1001, ?, ?, ?)
    `);

    for (const h of hymnal1996) {
      if (h.id_music && h.track != null) {
        insertAlbumMusic1996.run(h.id_music, h.track, lang);
      }
    }
  }
}

// ==============================================
// 7. BIBLIA
// ==============================================

async function importBible() {
  console.log("\n=== IMPORTANDO BIBLIA (PT) ===");

  // Versoes
  const versions = await fetchJson("/json_db/pt_bible_version");
  if (Array.isArray(versions)) {
    for (const v of versions) {
      db.prepare(
        "INSERT OR IGNORE INTO bible_versions (id_version, name, language, abbreviation) VALUES (?, ?, ?, ?)",
      ).run(v.id_bible_version ?? v.id, v.name, "pt", v.abbreviation ?? null);
    }
    console.log(`  ${versions.length} versoes`);
  }

  // Livros
  const books = await fetchJson("/json_db/pt_bible_book");
  if (Array.isArray(books)) {
    for (const b of books) {
      db.prepare(
        "INSERT OR IGNORE INTO bible_books (id_book, name, abbreviation, chapters, book_number, id_language) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        b.id_bible_book ?? b.id_book,
        b.name,
        b.abbreviation,
        b.chapters,
        b.book_number,
        "pt",
      );
    }
    console.log(`  ${books.length} livros`);
  }

  console.log("  (versiculos importados sob demanda via lazy proxy)");
}

async function importBibleEs() {
  console.log("\n=== IMPORTANDO BIBLIA (ES) ===");

  // Versoes (ids ES: 10, 11, 12 — sem colisao com PT "1.0".."13.0")
  const versions = await fetchJson("/json_db/es_bible_version");
  if (Array.isArray(versions)) {
    for (const v of versions) {
      db.prepare(
        "INSERT OR IGNORE INTO bible_versions (id_version, name, language, abbreviation) VALUES (?, ?, 'es', ?)",
      ).run(String(v.id_bible_version ?? v.id), v.name, v.abbreviation ?? null);
    }
    console.log(`  ${versions.length} versoes`);
  }

  // Livros (ids ES: 67..132 — sem colisao com PT 1..66)
  const books = await fetchJson("/json_db/es_bible_book");
  if (Array.isArray(books)) {
    for (const b of books) {
      db.prepare(
        "INSERT OR IGNORE INTO bible_books (id_book, name, abbreviation, chapters, book_number, id_language, testament, keywords, color) VALUES (?, ?, ?, ?, ?, 'es', ?, ?, ?)",
      ).run(
        b.id_bible_book ?? b.id_book,
        b.name,
        b.abbreviation ?? null,
        b.chapters ?? 0,
        b.book_number ?? 0,
        b.testament ?? null,
        b.keywords ?? null,
        b.color ?? null,
      );
    }
    console.log(`  ${books.length} livros`);
  }

  // Capitulos ES NAO existem no upstream (bible_10_1_1 -> 404):
  // o lazy proxy espelha o 404, paridade mantida.
}

// ==============================================
// MAIN
// ==============================================

async function main() {
  const startTime = Date.now();
  console.log("=========================================");
  console.log("IMPORTACAO DO CATALOGO louvorja.com.br");
  console.log(`Upstream: ${UPSTREAM}`);
  console.log(`DB: ${DB_PATH}`);
  console.log("=========================================");

  ensureLanguages();

  // 0. Config
  await importConfig();

  const lang = process.env.IMPORT_LANG ?? "pt";

  // 1. Categorias + Albums (com slug, type, order, subtitle, url_image)
  await importCategoriesWithAlbums(lang);

  // 2. Musicas (com letra texto, albums com track do pivot)
  await importMusics(lang);

  // 3. Hinarios
  await importHymnals(lang);

  // 4. Detalhes de cada album (atualizar track das musicas)
  await importAlbumDetails(lang);

  // 5. Detalhes de cada musica (audio, imagem, estrofes com timing)
  await importMusicDetails(lang);

  // 6. Biblia (somente uma vez, pt)
  if (lang === "pt") {
    await importBible();
    await importBibleEs();
  }

  // Stats finais
  const tables = [
    "categories",
    "albums",
    "musics",
    "lyrics",
    "files",
    "albums_musics",
    "categories_albums",
    "bible_books",
  ];
  const stats: Record<string, number> = {};
  for (const t of tables) {
    const row = db.prepare(`SELECT count(*) as c FROM ${t}`).get() as any;
    stats[t] = row?.c ?? 0;
  }

  // Verificar colunas populadas
  const populatedCheck = {
    cats_with_slug:
      (
        db
          .prepare(
            `SELECT count(*) as c FROM categories WHERE slug IS NOT NULL`,
          )
          .get() as any
      )?.c ?? 0,
    albums_with_track:
      (
        db
          .prepare(
            `SELECT count(*) as c FROM albums_musics WHERE track IS NOT NULL`,
          )
          .get() as any
      )?.c ?? 0,
    files_with_duration:
      (
        db
          .prepare(`SELECT count(*) as c FROM files WHERE duration IS NOT NULL`)
          .get() as any
      )?.c ?? 0,
    files_with_dir:
      (
        db
          .prepare(`SELECT count(*) as c FROM files WHERE dir IS NOT NULL`)
          .get() as any
      )?.c ?? 0,
    lyrics_with_id:
      (
        db
          .prepare(
            `SELECT count(*) as c FROM lyrics WHERE id_lyric IS NOT NULL`,
          )
          .get() as any
      )?.c ?? 0,
  };

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n=========================================");
  console.log("IMPORTACAO CONCLUIDA");
  console.log(`Tempo: ${elapsed}s`);
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log("\nColunas populadas (paridade):");
  for (const [k, v] of Object.entries(populatedCheck)) {
    console.log(`  ${k}: ${v}`);
  }

  const pageSize = db.pragma("page_size", { simple: true }) as number;
  const pageCount = db.pragma("page_count", { simple: true }) as number;
  const sizeMB = ((pageSize * pageCount) / 1024 / 1024).toFixed(1);
  console.log(`\nSQLite: ${sizeMB} MB`);
  console.log("=========================================");

  db.close();
}

main().catch((err) => {
  console.error("ERRO FATAL:", err);
  db.close();
  process.exit(1);
});
