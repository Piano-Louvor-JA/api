import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getDb } from "../../db/connection.js";
import {
  AlbumDetailSchema,
  AlbumsListResponseSchema,
} from "./albums.schemas.js";

const albumsRoutes = new OpenAPIHono();

// ============================================
// GET /v1/albums — lista paginada
// ============================================
const listAlbumsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["albums"],
  description: "Lista de coletâneas com paginação e filtro por idioma",
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
      content: { "application/json": { schema: AlbumsListResponseSchema } },
      description: "Lista de coletâneas com paginação",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

albumsRoutes.openapi(listAlbumsRoute, (c) => {
  const { lang, page, per_page } = c.req.valid("query");
  const pageNum = parseInt(page || "1", 10);
  const perPage = parseInt(per_page || "50", 10);
  const offset = (pageNum - 1) * perPage;

  try {
    const db = getDb();

    const { count } = db
      .prepare(`SELECT COUNT(*) as count FROM albums WHERE id_language = ?`)
      .get(lang) as { count: number };

    // Traduzido do PHP: concat(files_image.dir, '/', files_image.file_name) as url_image
    // No nosso SQLite, files.url ja tem o caminho completo
    const albums = db
      .prepare(
        `SELECT
          a.id_album,
          a.name,
          a.color,
          fi.url as url_image
        FROM albums a
        LEFT JOIN files fi ON a.id_file_image = fi.id_file
        WHERE a.id_language = ?
        ORDER BY a.name
        LIMIT ? OFFSET ?`,
      )
      .all(lang, perPage, offset) as Array<{
      id_album: number;
      name: string;
      color: string | null;
      url_image: string | null;
    }>;

    const data = albums.map((a) => ({
      id_album: a.id_album,
      name: a.name,
      color: a.color || null,
      url_image: a.url_image || null,
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
    return c.json({ error: "Erro ao buscar coletâneas" }, 500);
  }
});

// ============================================
// GET /v1/albums/:id — paridade com /json_db/album_{id}
// ============================================
const getAlbumRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["albums"],
  description:
    "Detalhe de coletânea com músicas aninhadas (paridade: album_{id})",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da Coletânea", example: "1" }),
    }),
    query: z.object({
      lang: z
        .string()
        .openapi({ description: "Idioma (ex: pt, es)", example: "pt" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: AlbumDetailSchema } },
      description: "Detalhes da coletânea com músicas",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Coletânea não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

albumsRoutes.openapi(getAlbumRoute, (c) => {
  const { id } = c.req.valid("param");
  const { lang } = c.req.valid("query");
  const idAlbum = parseInt(id, 10);

  try {
    const db = getDb();

    // Query principal do album_{id} — traduzida do PHP
    const album = db
      .prepare(
        `SELECT
          a.id_album,
          a.name,
          a.color,
          fi.url as url_image
        FROM albums a
        LEFT JOIN files fi ON a.id_file_image = fi.id_file
        WHERE a.id_album = ? AND a.id_language = ?`,
      )
      .get(idAlbum, lang) as
      | {
          id_album: number;
          name: string;
          color: string | null;
          url_image: string | null;
        }
      | undefined;

    if (!album) {
      return c.json({ error: "Coletânea não encontrada" }, 404);
    }

    // Categories: group_concat(concat(type,'.',slug) separator '|') — traduzido do PHP
    // Depois explode por '|' para virar array
    const catRow = db
      .prepare(
        `SELECT GROUP_CONCAT(ct.type || '.' || ct.slug, '|') as categories
         FROM categories ct
         INNER JOIN categories_albums ca ON ca.id_category = ct.id_category
         WHERE ca.id_album = ?`,
      )
      .get(idAlbum) as { categories: string | null } | undefined;

    const categories = catRow?.categories ? catRow.categories.split("|") : [];

    // Musicas do album — traduzido do PHP (relacionamento N:N via albums_musics)
    const musics = db
      .prepare(
        `SELECT
          m.id_music,
          m.name,
          CASE WHEN IFNULL(m.id_file_instrumental_music, 0) > 0 THEN 1 ELSE 0 END as has_instrumental_music,
          fm.duration as duration,
          am.track
        FROM musics m
        INNER JOIN albums_musics am ON am.id_music = m.id_music
        LEFT JOIN files fm ON m.id_file_music = fm.id_file
        WHERE am.id_album = ?
        ORDER BY am.track ASC`,
      )
      .all(idAlbum) as Array<{
      id_music: number;
      name: string;
      has_instrumental_music: number;
      duration: string | null;
      track: number;
    }>;

    return c.json(
      {
        id_album: album.id_album,
        name: album.name,
        color: album.color || null,
        url_image: album.url_image || null,
        categories,
        musics: musics.map((m) => ({
          id_music: m.id_music,
          name: m.name,
          has_instrumental_music: m.has_instrumental_music as 0 | 1,
          duration: m.duration || null,
          track: m.track,
        })),
      },
      200,
    );
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao buscar coletânea" }, 500);
  }
});

export { albumsRoutes };
