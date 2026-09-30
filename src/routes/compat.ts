import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { getDb } from "../db/connection.js";
import { importMusicById, ON_MISS_ENABLED } from "../lib/importMusicOnMiss.js";
import { fetchUpstream, UpstreamError } from "../lib/upstream.js";

export const compatRoutes = new Hono();

const UPSTREAM = process.env.UPSTREAM_API ?? "https://api.louvorja.com.br";
const BIBLE_CACHE_DIR = join(process.cwd(), "data", "bible_cache");

// Versões ES do ecossistema LouvorJA (mesmos ids da prod). Usadas como
// fallback quando bible_versions ainda não tem linhas language='es'.
const ES_BIBLE_VERSIONS_FALLBACK = [
  {
    id_bible_version: 12,
    name: "Las Sagradas Escrituras",
    abbreviation: "SEV",
  },
  { id_bible_version: 10, name: "Reina-Valera", abbreviation: "RV" },
  { id_bible_version: 11, name: "Reino-Valera 1989", abbreviation: "RVA" },
];

const VERSION_ABBREVIATION_BY_NAME: Array<{ match: RegExp; abbr: string }> = [
  { match: /nova\s+almeida\s+atualizada/i, abbr: "NAA" },
  { match: /almeida\s+corrigida\s+e\s+revisada\s+fiel/i, abbr: "ACRF" },
  { match: /almeida\s+corrigida\s+e\s+fiel/i, abbr: "ACF" },
  { match: /almeida\s+revisada\s+imprensa/i, abbr: "ARIB" },
  { match: /almeida\s+revista\s+e\s+atualizada/i, abbr: "ARA" },
  { match: /almeida\s+revista\s+e\s+corrigida/i, abbr: "ARC" },
  { match: /king\s+james\s+atualizada/i, abbr: "KJA" },
  { match: /nova\s+vers[aã]o\s+internacional/i, abbr: "NVI" },
  { match: /sagradas\s+escrituras/i, abbr: "SEV" },
  { match: /reina[-\s]?valera\s*1989/i, abbr: "RVA" },
  { match: /reina[-\s]?valera/i, abbr: "RV" },
];

function cleanCatalogText(value: unknown): string {
  if (value == null) return "";
  const text = String(value).trim();
  if (
    !text ||
    text.toLowerCase() === "null" ||
    text.toLowerCase() === "undefined"
  ) {
    return "";
  }
  return text;
}

function resolveVersionAbbreviation(
  abbreviation: unknown,
  name: unknown,
  versionId?: unknown,
): string {
  const fromField = cleanCatalogText(abbreviation);
  if (fromField) return fromField;

  const versionName = cleanCatalogText(name);
  for (const entry of VERSION_ABBREVIATION_BY_NAME) {
    if (entry.match.test(versionName)) return entry.abbr;
  }

  const idText = cleanCatalogText(versionId);
  if (/^[a-z]{2,6}$/i.test(idText)) return idText.toUpperCase();
  return "";
}

function withVersionAbbreviation<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    abbreviation: resolveVersionAbbreviation(
      row.abbreviation,
      row.name,
      row.id_bible_version ?? row.id_version,
    ),
  };
}

// Fallback de es_bible_book: extrai os nomes do próprio upstream da prod
// (1 request, cacheado em bible_cache/es_bible_book.json). Espelha o
// contrato da prod (ids 67-132).
let esBookFallbackCache: unknown = null;
async function serveEsBibleBookFallback(c: any) {
  if (esBookFallbackCache) return c.json(esBookFallbackCache);
  try {
    const res = await fetchUpstream(`${UPSTREAM}/json_db/es_bible_book`);
    const data = JSON.parse(await res.text());
    esBookFallbackCache = data;
    return c.json(data);
  } catch {
    return c.json({ error: "Arquivo nao encontrado!" }, 404);
  }
}

// ==============================================
// GET /json_db — manifest de arquivos disponiveis
// ==============================================
compatRoutes.get("/json_db", (c) => {
  // Servir manifest estatico baseado nos dados que temos
  return c.json([
    {
      file: "config.json",
      table: "config",
      path: "/db/config",
      hash: "static",
    },
    {
      file: "pt_categories.json",
      table: "pt_categories",
      path: "/db/pt_categories",
      hash: "static",
    },
    {
      file: "pt_musics.json",
      table: "pt_musics",
      path: "/db/pt_musics",
      hash: "static",
    },
    {
      file: "pt_hymnal.json",
      table: "pt_hymnal",
      path: "/db/pt_hymnal",
      hash: "static",
    },
    {
      file: "pt_hymnal_1996.json",
      table: "pt_hymnal_1996",
      path: "/db/pt_hymnal_1996",
      hash: "static",
    },
    {
      file: "pt_bible_book.json",
      table: "pt_bible_book",
      path: "/db/pt_bible_book",
      hash: "static",
    },
    {
      file: "pt_bible_version.json",
      table: "pt_bible_version",
      path: "/db/pt_bible_version",
      hash: "static",
    },
  ]);
});

// ==============================================
// GET /json_db/:file — router generico que faz parse do filename
// ==============================================
compatRoutes.get("/json_db/:file", async (c) => {
  const file = c.req.param("file");
  const db = getDb();

  // config
  if (file === "config") {
    return c.json({
      datetime: new Date().toISOString().slice(0, 19).replace("T", " "),
      latest_updated: new Date().toISOString().slice(0, 19).replace("T", " "),
      version: Date.now(),
      version_number: 1,
    });
  }

  // pt_categories ou es_categories
  if (file === "pt_categories" || file === "es_categories") {
    const lang = file.split("_")[0];
    const categories = db
      .prepare(
        `SELECT id_category, name, slug, "order"
         FROM categories
         WHERE type = 'collection' AND id_language = ?
         ORDER BY "order"`,
      )
      .all(lang) as any[];

    const result = categories.map((cat) => {
      const albums = db
        .prepare(
          `SELECT al.id_album, al.name, al.color,
             fi.url as url_image,
             ca.name as subtitle, ca."order"
           FROM albums al
           INNER JOIN categories_albums ca ON ca.id_album = al.id_album
           LEFT JOIN files fi ON al.id_file_image = fi.id_file
           WHERE ca.id_category = ? AND al.id_language = ?
           ORDER BY ca."order"`,
        )
        .all(cat.id_category, lang) as any[];

      return {
        id_category: cat.id_category,
        name: cat.name,
        slug: cat.slug,
        order: cat.order,
        albums: albums.map((a) => ({
          id_album: a.id_album,
          name: a.name,
          color: a.color,
          url_image: a.url_image || null,
          subtitle: a.subtitle || "",
          order: a.order,
        })),
      };
    });

    return c.json(result);
  }

  // pt_musics ou es_musics
  if (file === "pt_musics" || file === "es_musics") {
    const lang = file.split("_")[0];
    const musics = db
      .prepare(
        `SELECT
          m.id_music, m.name,
          CASE WHEN IFNULL(m.id_file_instrumental_music, 0) > 0 THEN 1 ELSE 0 END as has_instrumental_music,
          fm.duration as duration,
          (SELECT COALESCE(GROUP_CONCAT(COALESCE(l.lyric, ''), ' '), '') FROM lyrics l WHERE l.id_music = m.id_music) as lyric,
          (SELECT GROUP_CONCAT(al.name, '|')
             FROM albums al
             INNER JOIN albums_musics am2 ON am2.id_album = al.id_album
             INNER JOIN categories_albums ca ON ca.id_album = al.id_album
             INNER JOIN categories ct ON ct.id_category = ca.id_category
             WHERE ct.type IN ('hymnal', 'collection')
               AND am2.id_music = m.id_music
             GROUP BY am2.id_music) as albums_names
        FROM musics m
        LEFT JOIN files fm ON m.id_file_music = fm.id_file
        WHERE m.id_language = ?`,
      )
      .all(lang) as any[];

    const result = musics.map((m) => {
      const albums = db
        .prepare(
          `SELECT al.id_album, al.name, MIN(ct."order") as "order", ct.type,
             am.track
           FROM albums_musics am
           INNER JOIN albums al ON al.id_album = am.id_album
           LEFT JOIN categories_albums ca ON ca.id_album = al.id_album
           LEFT JOIN categories ct ON ct.id_category = ca.id_category
           WHERE ct.type IN ('hymnal', 'collection') AND am.id_music = ?
           GROUP BY al.id_album, al.name, am.id_music, am.id_album, am.track, ct.type
           ORDER BY "order"`,
        )
        .all(m.id_music) as any[];

      return {
        id_music: m.id_music,
        name: m.name,
        has_instrumental_music: m.has_instrumental_music,
        duration: m.duration || null,
        lyric: m.lyric ?? "",
        albums_names: m.albums_names || null,
        albums: albums.map((a) => ({
          id_album: a.id_album,
          name: a.name,
          order: a.order,
          type: a.type,
          pivot: { id_music: m.id_music, id_album: a.id_album, track: a.track },
        })),
      };
    });

    return c.json(result);
  }

  // pt_hymnal ou es_hymnal
  if (file === "pt_hymnal" || file === "es_hymnal") {
    const lang = file.split("_")[0];
    const musics = db
      .prepare(
        `SELECT m.id_music, m.name, am.track,
           CASE WHEN IFNULL(m.id_file_instrumental_music, 0) > 0 THEN 1 ELSE 0 END as has_instrumental_music,
           fm.duration as duration,
           (SELECT COALESCE(GROUP_CONCAT(COALESCE(l.lyric, ''), ' '), '') FROM lyrics l WHERE l.id_music = m.id_music) as lyric
         FROM musics m
         INNER JOIN albums_musics am ON am.id_music = m.id_music
         INNER JOIN categories_albums ca ON ca.id_album = am.id_album
         INNER JOIN categories ct ON ct.id_category = ca.id_category
         LEFT JOIN files fm ON m.id_file_music = fm.id_file
         WHERE ct.slug = 'hymnal' AND m.id_language = ?
         ORDER BY am.track`,
      )
      .all(lang) as any[];

    return c.json(musics);
  }

  // pt_hymnal_1996
  if (file === "pt_hymnal_1996" || file === "es_hymnal_1996") {
    const lang = file.split("_")[0];
    const musics = db
      .prepare(
        `SELECT m.id_music, m.name, am.track,
           CASE WHEN IFNULL(m.id_file_instrumental_music, 0) > 0 THEN 1 ELSE 0 END as has_instrumental_music,
           fm.duration as duration,
           (SELECT COALESCE(GROUP_CONCAT(COALESCE(l.lyric, ''), ' '), '') FROM lyrics l WHERE l.id_music = m.id_music) as lyric
         FROM musics m
         INNER JOIN albums_musics am ON am.id_music = m.id_music
         INNER JOIN categories_albums ca ON ca.id_album = am.id_album
         INNER JOIN categories ct ON ct.id_category = ca.id_category
         LEFT JOIN files fm ON m.id_file_music = fm.id_file
         WHERE ct.slug = 'hymnal_1996' AND m.id_language = ?
         ORDER BY am.track`,
      )
      .all(lang) as any[];

    return c.json(musics);
  }

  // music_{id}
  const musicMatch = file.match(/^music_(\d+)$/);
  if (musicMatch) {
    const idMusic = parseInt(musicMatch[1], 10);
    // Fetch on-miss: se nao existe local e o upstream tem, importa e serve.
    const exists = db
      .prepare("SELECT 1 FROM musics WHERE id_music = ?")
      .get(idMusic);
    if (!exists && ON_MISS_ENABLED) {
      try {
        const imported = await importMusicById(idMusic, db);
        if (imported) return handleMusicDetail(c, db, idMusic);
      } catch {
        // upstream indisponivel: cai no 404 normal abaixo
      }
    }
    return handleMusicDetail(c, db, idMusic);
  }

  // album_{id}
  const albumMatch = file.match(/^album_(\d+)$/);
  if (albumMatch) {
    const idAlbum = parseInt(albumMatch[1], 10);
    return handleAlbumDetail(c, db, idAlbum);
  }

  // pt_bible_book / es_bible_book
  const bookLangMatch = file.match(/^(pt|es)_bible_book$/);
  if (bookLangMatch) {
    const books = db
      .prepare(
        `SELECT id_book AS id_bible_book, book_number, name, chapters, abbreviation, testament, keywords, color
         FROM bible_books WHERE id_language = ? ORDER BY book_number`,
      )
      .all(bookLangMatch[1]);
    return c.json(books);
  }

  // pt_bible_version / es_bible_version
  const versionLangMatch = file.match(/^(pt|es)_bible_version$/);
  if (versionLangMatch) {
    const versions = db
      .prepare(
        `SELECT id_version AS id_bible_version, name, abbreviation FROM bible_versions WHERE language = ? ORDER BY name`,
      )
      .all(versionLangMatch[1])
      .map((row) => withVersionAbbreviation(row as Record<string, unknown>));
    return c.json(versions);
  }

  // es_bible_book — espelha o formato da prod (ids 67-132, offset +66).
  // Fonte: dados ES do upstream, servidos do DB quando populados; fallback
  // deriva do cache de capítulos bible_{v}_{book}_{chapter} (books 67-132).
  if (file === "es_bible_book") {
    const books = db
      .prepare(
        `SELECT id_book AS id_bible_book, book_number, name, chapters, abbreviation, testament, keywords, color
         FROM bible_books WHERE id_book BETWEEN 67 AND 132 ORDER BY book_number`,
      )
      .all();
    if (books.length > 0) return c.json(books);

    // Fallback: busca um capítulo ES no upstream e extrai os nomes não é viável
    // — em vez disso, serve o manifest estático equivalente ao da prod.
    return serveEsBibleBookFallback(c);
  }

  // es_bible_version — versões ES do ecossistema (SEV=10, RV=11, RVA=12).
  if (file === "es_bible_version") {
    const versions = db
      .prepare(
        `SELECT id_version AS id_bible_version, name, abbreviation FROM bible_versions WHERE language = 'es' ORDER BY name`,
      )
      .all()
      .map((row) => withVersionAbbreviation(row as Record<string, unknown>));
    if (versions.length > 0) return c.json(versions);
    return c.json(ES_BIBLE_VERSIONS_FALLBACK);
  }

  // es_bible_book — espelha o formato da prod (ids 67-132, offset +66).
  // Fonte: dados ES do upstream, servidos do DB quando populados; fallback
  // deriva do cache de capítulos bible_{v}_{book}_{chapter} (books 67-132).
  if (file === "es_bible_book") {
    const books = db
      .prepare(
        `SELECT id_book AS id_bible_book, book_number, name, chapters, abbreviation, testament, keywords, color
         FROM bible_books WHERE id_book BETWEEN 67 AND 132 ORDER BY book_number`,
      )
      .all();
    if (books.length > 0) return c.json(books);

    // Fallback: busca um capítulo ES no upstream e extrai os nomes não é viável
    // — em vez disso, serve o manifest estático equivalente ao da prod.
    return serveEsBibleBookFallback(c);
  }

  // es_bible_version — versões ES do ecossistema (SEV=10, RV=11, RVA=12).
  if (file === "es_bible_version") {
    const versions = db
      .prepare(
        `SELECT id_version AS id_bible_version, name, abbreviation FROM bible_versions WHERE language = 'es' ORDER BY name`,
      )
      .all()
      .map((row) => withVersionAbbreviation(row as Record<string, unknown>));
    if (versions.length > 0) return c.json(versions);
    return c.json(ES_BIBLE_VERSIONS_FALLBACK);
  }

  // es_bible_book — espelha o formato da prod (ids 67-132, offset +66).
  // Fonte: dados ES do upstream, servidos do DB quando populados; fallback
  // deriva do cache de capítulos bible_{v}_{book}_{chapter} (books 67-132).
  if (file === "es_bible_book") {
    const books = db
      .prepare(
        `SELECT id_book AS id_bible_book, book_number, name, chapters, abbreviation, testament, keywords, color
         FROM bible_books WHERE id_book BETWEEN 67 AND 132 ORDER BY book_number`,
      )
      .all();
    if (books.length > 0) return c.json(books);

    // Fallback: busca um capítulo ES no upstream e extrai os nomes não é viável
    // — em vez disso, serve o manifest estático equivalente ao da prod.
    return serveEsBibleBookFallback(c);
  }

  // es_bible_version — versões ES do ecossistema (SEV=10, RV=11, RVA=12).
  if (file === "es_bible_version") {
    const versions = db
      .prepare(
        `SELECT id_version AS id_bible_version, name, abbreviation FROM bible_versions WHERE language = 'es' ORDER BY name`,
      )
      .all();
    if (versions.length > 0) return c.json(versions);
    return c.json(ES_BIBLE_VERSIONS_FALLBACK);
  }

  // es_bible_book — espelha o formato da prod (ids 67-132, offset +66).
  // Fonte: dados ES do upstream, servidos do DB quando populados; fallback
  // deriva do cache de capítulos bible_{v}_{book}_{chapter} (books 67-132).
  if (file === "es_bible_book") {
    const books = db
      .prepare(
        `SELECT id_book AS id_bible_book, book_number, name, chapters, abbreviation, testament, keywords, color
         FROM bible_books WHERE id_book BETWEEN 67 AND 132 ORDER BY book_number`,
      )
      .all();
    if (books.length > 0) return c.json(books);

    // Fallback: busca um capítulo ES no upstream e extrai os nomes não é viável
    // — em vez disso, serve o manifest estático equivalente ao da prod.
    return serveEsBibleBookFallback(c);
  }

  // es_bible_version — versões ES do ecossistema (SEV=10, RV=11, RVA=12).
  if (file === "es_bible_version") {
    const versions = db
      .prepare(
        `SELECT id_version AS id_bible_version, name, abbreviation FROM bible_versions WHERE language = 'es' ORDER BY name`,
      )
      .all();
    if (versions.length > 0) return c.json(versions);
    return c.json(ES_BIBLE_VERSIONS_FALLBACK);
  }

  // bible_{version}_{book}_{chapter} — lazy proxy
  const bibleMatch = file.match(/^bible_(\d+)_(\d+)_(\d+)$/);
  if (bibleMatch) {
    return await handleBibleChapter(c, file);
  }

  return c.json({ error: "Arquivo nao encontrado!" }, 404);
});

// ==============================================
// Handler: detalhe de musica
// ==============================================
function handleMusicDetail(c: any, db: any, idMusic: number) {
  const music = db
    .prepare(
      `SELECT m.id_music, m.name,
         fm.duration as duration,
         fi.duration as instrumental_duration,
         fi_img.url as url_image,
         fi_img.image_position as image_position,
         fm.url as url_music,
         fi_inst.url as url_instrumental_music
       FROM musics m
       LEFT JOIN files fi_img ON m.id_file_image = fi_img.id_file
       LEFT JOIN files fm ON m.id_file_music = fm.id_file
       LEFT JOIN files fi_inst ON m.id_file_instrumental_music = fi_inst.id_file
       LEFT JOIN files fi ON m.id_file_instrumental_music = fi.id_file
       WHERE m.id_music = ?`,
    )
    .get(idMusic);

  if (!music) return c.json({ error: "Arquivo nao encontrado!" }, 404);

  const lyrics = db
    .prepare(
      `SELECT l.id_lyric, l.id_music, l.lyric, l.aux_lyric,
         fi.url as url_image, fi.image_position as image_position,
         l.time,
         CASE WHEN l.instrumental_time = '00:00:00' THEN l.time ELSE l.instrumental_time END as instrumental_time,
         l.show_slide, l."order"
       FROM lyrics l
       LEFT JOIN files fi ON l.id_file_image = fi.id_file
       WHERE l.id_music = ?
       ORDER BY l."order" ASC`,
    )
    .all(idMusic);

  const albums = db
    .prepare(
      `SELECT al.id_album, al.name, am.track,
         fi.url as url_image,
         MIN(ct."order") as "order"
       FROM albums al
       INNER JOIN albums_musics am ON am.id_album = al.id_album
       LEFT JOIN files fi ON al.id_file_image = fi.id_file
       LEFT JOIN categories_albums ca ON ca.id_album = al.id_album
       LEFT JOIN categories ct ON ct.id_category = ca.id_category
       WHERE ct.type IN ('hymnal', 'collection') AND am.id_music = ?
       GROUP BY al.id_album, al.name, am.id_music, am.id_album, am.track
       ORDER BY "order"`,
    )
    .all(idMusic);

  return c.json({
    id_music: music.id_music,
    name: music.name,
    duration: music.duration || null,
    instrumental_duration: music.instrumental_duration || null,
    url_image: music.url_image || null,
    image_position: music.image_position ?? null,
    url_music: music.url_music || null,
    url_instrumental_music: music.url_instrumental_music || null,
    lyric: lyrics.map((l: any) => ({
      id_lyric: l.id_lyric,
      id_music: l.id_music,
      lyric: l.lyric,
      aux_lyric: l.aux_lyric,
      url_image: l.url_image || null,
      image_position: l.image_position ?? null,
      time: l.time,
      instrumental_time: l.instrumental_time,
      show_slide: l.show_slide,
      order: l.order,
    })),
    albums: albums.map((a: any) => ({
      id_album: a.id_album,
      name: a.name,
      track: a.track,
      url_image: a.url_image || null,
      order: a.order,
    })),
  });
}

// ==============================================
// Handler: detalhe de album
// ==============================================
function handleAlbumDetail(c: any, db: any, idAlbum: number) {
  const album = db
    .prepare(
      `SELECT a.id_album, a.name, a.color, fi.url as url_image
       FROM albums a
       LEFT JOIN files fi ON a.id_file_image = fi.id_file
       WHERE a.id_album = ?`,
    )
    .get(idAlbum);

  if (!album) return c.json({ error: "Arquivo nao encontrado!" }, 404);

  const catRow = db
    .prepare(
      `SELECT GROUP_CONCAT(ct.type || '.' || ct.slug, '|') as categories
       FROM categories ct
       INNER JOIN categories_albums ca ON ca.id_category = ct.id_category
       WHERE ca.id_album = ?`,
    )
    .get(idAlbum);

  const categories = catRow.categories ? catRow.categories.split("|") : [];

  const musics = db
    .prepare(
      `SELECT m.id_music, m.name,
         CASE WHEN IFNULL(m.id_file_instrumental_music, 0) > 0 THEN 1 ELSE 0 END as has_instrumental_music,
         CASE WHEN IFNULL(fm.url, '') <> '' THEN 1 ELSE 0 END as has_playback,
         fm.duration as duration, am.track
       FROM musics m
       INNER JOIN albums_musics am ON am.id_music = m.id_music
       LEFT JOIN files fm ON m.id_file_music = fm.id_file
       WHERE am.id_album = ?
       ORDER BY am.track ASC`,
    )
    .all(idAlbum);

  return c.json({
    id_album: album.id_album,
    name: album.name,
    color: album.color,
    url_image: album.url_image || null,
    categories,
    musics: musics.map((m: any) => ({
      id_music: m.id_music,
      name: m.name,
      has_instrumental_music: m.has_instrumental_music,
      has_playback: !!m.has_playback,
      duration: m.duration || null,
      track: m.track,
    })),
  });
}

// ==============================================
// Handler: bible chapter (lazy proxy com cache)
// ==============================================
async function handleBibleChapter(c: any, cacheKey: string) {
  mkdirSync(BIBLE_CACHE_DIR, { recursive: true });
  const cacheFile = join(BIBLE_CACHE_DIR, `${cacheKey}.json`);

  // Serve from local cache if available
  if (existsSync(cacheFile)) {
    const cached = readFileSync(cacheFile, "utf-8");
    return c.json(JSON.parse(cached));
  }

  // Fetch from upstream (rate-limited, com retry em 429/5xx) e cacheia
  try {
    const upstreamUrl = `${UPSTREAM}/json_db/${cacheKey}`;
    const res = await fetchUpstream(upstreamUrl);
    if (res.status === 404) {
      // Versão/capítulo não existe no upstream — espelha o 404 em vez de 502
      return c.json({ error: "Arquivo nao encontrado!" }, 404);
    }
    const data = await res.text();
    writeFileSync(cacheFile, data, "utf-8");
    return c.json(JSON.parse(data));
  } catch (e: unknown) {
    if (e instanceof UpstreamError && e.status === 404) {
      // Versão/capítulo não existe no upstream — espelha o 404 em vez de 502
      return c.json({ error: "Arquivo nao encontrado!" }, 404);
    }
    return c.json({ error: "Failed to fetch chapter from upstream" }, 502);
  }
}

// ==============================================
// GET /file/:path* — serve midias LOCAIS (media/) com mirror on-demand.
// Ordem: 1) arquivo local existe -> serve do disco
//        2) nao existe -> baixa do upstream, salva em media/ e serve (cache transparente)
//        3) upstream falhou -> 302 redirect (fallback) ou 502
// ==============================================
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MEDIA_DIR = join(process.cwd(), "media");
const MIRROR_ENABLED = process.env.MEDIA_MIRROR !== "off";
/** Fallback de mídia: workers.dev quando o host principal falhar. */
const MEDIA_FALLBACK_HOST = (
  process.env.UPSTREAM_FALLBACK_API ?? "https://api.louvorja.workers.dev"
).replace(/\/$/, "");

compatRoutes.get("/file/:path{.*}", async (c) => {
  const path = c.req.param("path");
  // RF-06: bloqueio explícito de path traversal e paths absolutos
  if (path.includes("..") || path.startsWith("/")) {
    return c.json({ error: "Invalid path" }, 400);
  }
  const localPath = join(MEDIA_DIR, path);
  const upstreamUrl = `${UPSTREAM}/file/${path}`;

  // 1. Serve do disco se ja existe no mirror
  if (existsSync(localPath)) {
    const ext = localPath.split(".").pop()?.toLowerCase() ?? "";
    const mime =
      ext === "mp3"
        ? "audio/mpeg"
        : ext === "bmp"
          ? "image/bmp"
          : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "png"
              ? "image/png"
              : "application/octet-stream";
    const fileStat = await fsStat(localPath);
    // Range requests (seek de audio)
    const range = c.req.header("range");
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : fileStat.size - 1;
        const node = await fsReadFile(localPath);
        const chunk = node.subarray(start, end + 1);
        return c.body(chunk, 206, {
          "Content-Type": mime,
          "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunk.length),
        });
      }
    }
    return c.body(await fsReadFile(localPath), 200, {
      "Content-Type": mime,
      "Content-Length": String(fileStat.size),
      "Accept-Ranges": "bytes",
    });
  }

  // 2. Mirror on-demand: baixa, salva e serve (host principal -> fallback)
  if (MIRROR_ENABLED) {
    const mediaUrls = [
      upstreamUrl,
      `${MEDIA_FALLBACK_HOST}/file/${path}`,
    ].filter(
      (u, i, arr) => arr.indexOf(u) === i, // dedup se host principal == fallback
    );
    for (const mediaUrl of mediaUrls) {
      try {
        const res = await fetch(mediaUrl);
        if (res.ok && res.body) {
          mkdirSync(dirname(localPath), { recursive: true });
          const tmp = `${localPath}.tmp`;
          await pipeline(
            Readable.fromWeb(res.body as any),
            createWriteStream(tmp),
          );
          renameSync(tmp, localPath);
          const buf = await fsReadFile(localPath);
          return c.body(buf, 200, {
            "Content-Type":
              res.headers.get("content-type") ?? "application/octet-stream",
            "Content-Length": String(buf.length),
            "Accept-Ranges": "bytes",
          });
        }
      } catch {
        // tenta próximo host
      }
    }
  }

  // 3. Fallback final: redirect pro upstream (principal, depois Cloudflare)
  return c.redirect(upstreamUrl, 302);
});
