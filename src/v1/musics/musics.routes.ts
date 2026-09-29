import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getDb } from "../../db/connection.js";
import {
  MusicDetailSchema,
  MusicsListResponseSchema,
} from "./musics.schemas.js";

const musicsRoutes = new OpenAPIHono();

// ============================================
// GET /v1/musics — paridade com /json_db/pt_musics
// ============================================
const listMusicsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["musics"],
  description:
    "Lista todas as músicas com paginação e filtro por idioma (paridade: pt_musics)",
  request: {
    query: z.object({
      lang: z
        .string()
        .openapi({ description: "Idioma (ex: pt, es)", example: "pt" }),
      page: z
        .string()
        .optional()
        .openapi({ description: "Página atual (default: 1)", example: "1" }),
      per_page: z.string().optional().openapi({
        description: "Itens por página (default: 50)",
        example: "50",
      }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: MusicsListResponseSchema } },
      description: "Lista de músicas com paginação",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

musicsRoutes.openapi(listMusicsRoute, (c) => {
  const { lang, page, per_page } = c.req.valid("query");
  const pageNum = parseInt(page || "1", 10);
  const perPage = parseInt(per_page || "50", 10);
  const offset = (pageNum - 1) * perPage;

  try {
    const db = getDb();

    // Total para meta
    const { count } = db
      .prepare(`SELECT COUNT(*) as count FROM musics WHERE id_language = ?`)
      .get(lang) as { count: number };

    // Query principal — traduzida do PHP DataBase::export_json() (pt_musics)
    // Subqueries para lyric (texto plano) e albums_names
    const musics = db
      .prepare(
        `SELECT
          m.id_music,
          m.name,
          CASE WHEN IFNULL(m.id_file_instrumental_music, 0) > 0 THEN 1 ELSE 0 END as has_instrumental_music,
          fm.duration as duration,
          (SELECT GROUP_CONCAT(l.lyric, ' ') FROM lyrics l WHERE l.id_music = m.id_music) as lyric,
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
        WHERE m.id_language = ?
        LIMIT ? OFFSET ?`,
      )
      .all(lang, perPage, offset) as Array<{
      id_music: number;
      name: string;
      has_instrumental_music: number;
      duration: string | null;
      lyric: string | null;
      albums_names: string | null;
    }>;

    // Para cada música, buscar os albums com pivot (relacionamento N:N)
    const musicIds = musics.map((m) => m.id_music);
    const albumsByMusic: Record<
      number,
      Array<{
        id_album: number;
        name: string;
        order: number | null;
        type: string;
        pivot: { id_music: number; id_album: number; track: number };
      }>
    > = {};

    if (musicIds.length > 0) {
      const placeholders = musicIds.map(() => "?").join(",");
      const albumRows = db
        .prepare(
          `SELECT
            am.id_music,
            al.id_album,
            al.name,
            MIN(ct."order") as "order",
            ct.type,
            am.track
          FROM albums_musics am
          INNER JOIN albums al ON al.id_album = am.id_album
          LEFT JOIN categories_albums ca ON ca.id_album = al.id_album
          LEFT JOIN categories ct ON ct.id_category = ca.id_category
          WHERE ct.type IN ('hymnal', 'collection')
            AND am.id_music IN (${placeholders})
          GROUP BY al.id_album, al.name, am.id_music, am.id_album, am.track, ct.type
          ORDER BY "order"`,
        )
        .all(...musicIds) as Array<{
        id_music: number;
        id_album: number;
        name: string;
        order: number | null;
        type: string;
        track: number;
      }>;

      for (const row of albumRows) {
        if (!albumsByMusic[row.id_music]) albumsByMusic[row.id_music] = [];
        albumsByMusic[row.id_music].push({
          id_album: row.id_album,
          name: row.name,
          order: row.order,
          type: row.type,
          pivot: {
            id_music: row.id_music,
            id_album: row.id_album,
            track: row.track,
          },
        });
      }
    }

    const data = musics.map((m) => ({
      id_music: m.id_music,
      name: m.name,
      has_instrumental_music: m.has_instrumental_music as 0 | 1,
      duration: m.duration || null,
      lyric: m.lyric || null,
      albums_names: m.albums_names || null,
      albums: albumsByMusic[m.id_music] || [],
    }));

    return c.json(
      {
        data,
        meta: {
          total: count,
          per_page: perPage,
          current_page: pageNum,
          last_page: Math.ceil(count / perPage),
        },
      },
      200,
    );
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao buscar músicas" }, 500);
  }
});

// ============================================
// GET /v1/musics/:id — paridade com /json_db/music_{id}
// ============================================
const getMusicRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["musics"],
  description:
    "Detalhe de uma música com letras (estrofes) e URLs de mídia (paridade: music_{id})",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da Música", example: "1" }),
    }),
    query: z.object({
      lang: z
        .string()
        .openapi({ description: "Idioma (ex: pt, es)", example: "pt" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: MusicDetailSchema } },
      description: "Detalhes da música com letras",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Música não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

musicsRoutes.openapi(getMusicRoute, (c) => {
  const { id } = c.req.valid("param");
  const { lang } = c.req.valid("query");
  const idMusic = parseInt(id, 10);

  try {
    const db = getDb();

    // Query principal do music_{id} — traduzida do PHP
    const music = db
      .prepare(
        `SELECT
          m.id_music,
          m.name,
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
        WHERE m.id_music = ? AND m.id_language = ?`,
      )
      .get(idMusic, lang) as
      | {
          id_music: number;
          name: string;
          duration: string | null;
          instrumental_duration: string | null;
          url_image: string | null;
          image_position: string | null;
          url_music: string | null;
          url_instrumental_music: string | null;
        }
      | undefined;

    if (!music) {
      return c.json({ error: "Música não encontrada" }, 404);
    }

    // Buscar lyrics (estrofes) — traduzido do PHP
    // instrumental_time: se 00:00:00, usar time; senao usar instrumental_time
    const lyrics = db
      .prepare(
        `SELECT
          l.id_lyric,
          l.id_music,
          l.lyric,
          l.aux_lyric,
          fi.url as url_image,
          fi.image_position as image_position,
          l.time,
          CASE WHEN l.instrumental_time = '00:00:00' THEN l.time ELSE l.instrumental_time END as instrumental_time,
          l.show_slide,
          l."order"
        FROM lyrics l
        LEFT JOIN files fi ON l.id_file_image = fi.id_file
        WHERE l.id_music = ?
        ORDER BY l."order" ASC`,
      )
      .all(idMusic) as Array<{
      id_lyric: number;
      id_music: number;
      lyric: string;
      aux_lyric: string | null;
      url_image: string | null;
      image_position: string | null;
      time: string;
      instrumental_time: string | null;
      show_slide: number;
      order: number;
    }>;

    // Buscar albums da musica (paridade com music_{id} do upstream)
    const albums = db
      .prepare(
        `SELECT
          al.id_album,
          al.name,
          am.track,
          fi.url as url_image,
          MIN(ct."order") as "order"
        FROM albums al
        INNER JOIN albums_musics am ON am.id_album = al.id_album
        LEFT JOIN files fi ON al.id_file_image = fi.id_file
        LEFT JOIN categories_albums ca ON ca.id_album = al.id_album
        LEFT JOIN categories ct ON ct.id_category = ca.id_category
        WHERE ct.type IN ('hymnal', 'collection')
          AND am.id_music = ?
        GROUP BY al.id_album, al.name, am.id_music, am.id_album, am.track
        ORDER BY "order"`,
      )
      .all(idMusic) as Array<{
      id_album: number;
      name: string;
      track: number;
      url_image: string | null;
      order: number | null;
    }>;

    return c.json(
      {
        id_music: music.id_music,
        name: music.name,
        duration: music.duration || null,
        instrumental_duration: music.instrumental_duration || null,
        url_image: music.url_image || null,
        image_position: music.image_position ?? null,
        url_music: music.url_music || null,
        url_instrumental_music: music.url_instrumental_music || null,
        lyric: lyrics.map((l) => ({
          id_lyric: l.id_lyric,
          id_music: l.id_music,
          lyric: l.lyric,
          aux_lyric: l.aux_lyric,
          url_image: l.url_image || null,
          image_position: l.image_position ?? null,
          time: l.time,
          instrumental_time: l.instrumental_time,
          show_slide: l.show_slide as 0 | 1,
          order: l.order,
        })),
        albums: albums.map((a) => ({
          id_album: a.id_album,
          name: a.name,
          track: a.track,
          url_image: a.url_image || null,
          order: a.order,
        })),
      },
      200,
    );
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao buscar música" }, 500);
  }
});

export { musicsRoutes };
