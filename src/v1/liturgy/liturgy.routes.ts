import { createHash } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getDb } from "../../db/connection.js";
import { zodErrorHook } from "../../lib/zodErrorHook.js";

/**
 * SPEC 9 (apk#98) — Catálogo de liturgia/kids agregado.
 *
 * Um único request para o APK cachear offline:
 * - categories: categorias de catálogo fixo (kids=98, doxology=99) com álbuns
 *   e faixas aninhadas (conteúdo + mídias: duração, capa, áudio, instrumental).
 * - programs: liturgias cadastradas (tabela liturgy_programs quando existir).
 *
 * Reaproveita exatamente os dados da migration 016 (ábaluns 9000+, faixas 90101+).
 */

const LiturgyTrackSchema = z.object({
  id_music: z.number().openapi({ example: 90122 }),
  name: z.string().openapi({ example: "Sim, Cristo me Ama" }),
  duration: z.string().nullable().openapi({ example: "00:03:19" }),
  track: z.number().nullable().openapi({ example: 1 }),
  has_instrumental_music: z.union([z.literal(0), z.literal(1)]),
  url_music: z.string().nullable().openapi({ example: "musics/pt/90122.mp3" }),
  url_instrumental_music: z.string().nullable(),
  url_image: z.string().nullable(),
});

const LiturgyAlbumSchema = z.object({
  id_album: z.number().openapi({ example: 9000 }),
  name: z.string().openapi({ example: "Infantis" }),
  color: z.string().nullable(),
  url_image: z.string().nullable(),
  subtitle: z.string().nullable(),
  order: z.number(),
  musics: z.array(LiturgyTrackSchema),
});

const LiturgyCategorySchema = z.object({
  id_category: z.number().openapi({ example: 98 }),
  name: z.string().openapi({ example: "Infantis" }),
  slug: z.string().openapi({ example: "kids" }),
  order: z.number(),
  albums: z.array(LiturgyAlbumSchema),
});

const LiturgyProgramSchema = z.object({
  id_program: z.number(),
  name: z.string(),
  active: z.boolean(),
  url_file: z.string().nullable(),
});

const LiturgyCatalogResponseSchema = z.object({
  categories: z.array(LiturgyCategorySchema),
  programs: z.array(LiturgyProgramSchema),
});

const liturgyRoutes = new OpenAPIHono({ defaultHook: zodErrorHook });

const listLiturgyCatalogRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["liturgy"],
  description:
    "Catálogo agregado de liturgia/kids com categorias, álbuns, faixas (conteúdo + mídias) e programas — pensado para cache offline no APK (SPEC 9, apk#98)",
  request: {
    query: z.object({
      lang: z
        .string()
        .optional()
        .openapi({ description: "Idioma (default: pt)", example: "pt" }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: LiturgyCatalogResponseSchema },
      },
      description: "Catálogo de liturgia/kids",
    },
    304: {
      description: "Não modificado (ETag igual ao If-None-Match)",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

liturgyRoutes.openapi(listLiturgyCatalogRoute, (c) => {
  const lang = c.req.valid("query").lang || "pt";

  try {
    const db = getDb();

    // 1. Categorias de catálogo fixo com álbuns e faixas aninhadas.
    const categories = db
      .prepare(
        `SELECT id_category, name, slug, "order"
         FROM categories
         WHERE type = 'collection' AND slug IN ('kids', 'doxology') AND id_language = ?
         ORDER BY "order"`,
      )
      .all(lang) as Array<{
      id_category: number;
      name: string;
      slug: string;
      order: number;
    }>;

    const catalogCategories = categories.map((cat) => {
      const albums = db
        .prepare(
          `SELECT
            al.id_album, al.name, al.color,
            fi.url as url_image,
            ca.name as subtitle, ca."order"
          FROM albums al
          INNER JOIN categories_albums ca ON ca.id_album = al.id_album
          LEFT JOIN files fi ON al.id_file_image = fi.id_file
          WHERE ca.id_category = ? AND al.id_language = ?
          ORDER BY ca."order"`,
        )
        .all(cat.id_category, lang) as Array<{
        id_album: number;
        name: string;
        color: string | null;
        url_image: string | null;
        subtitle: string | null;
        order: number;
      }>;

      return {
        id_category: cat.id_category,
        name: cat.name,
        slug: cat.slug,
        order: cat.order,
        albums: albums.map((al) => {
          const musics = db
            .prepare(
              `SELECT
                m.id_music, m.name,
                fm.duration, am.track,
                CASE WHEN m.id_file_instrumental_music IS NOT NULL THEN 1 ELSE 0 END as has_instrumental_music,
                fm.url as url_music,
                fi.url as url_instrumental_music,
                fc.url as url_image
              FROM albums_musics am
              INNER JOIN musics m ON m.id_music = am.id_music
              LEFT JOIN files fm ON fm.id_file = m.id_file_music
              LEFT JOIN files fi ON fi.id_file = m.id_file_instrumental_music
              LEFT JOIN files fc ON fc.id_file = m.id_file_image
              WHERE am.id_album = ? AND am.id_language = ?
              ORDER BY am.track`,
            )
            .all(al.id_album, lang) as Array<{
            id_music: number;
            name: string;
            duration: string | null;
            track: number | null;
            has_instrumental_music: 0 | 1;
            url_music: string | null;
            url_instrumental_music: string | null;
            url_image: string | null;
          }>;

          return {
            id_album: al.id_album,
            name: al.name,
            color: al.color || null,
            url_image: al.url_image || null,
            subtitle: al.subtitle || null,
            order: al.order,
            musics: musics.map((m) => ({
              id_music: m.id_music,
              name: m.name,
              duration: m.duration || null,
              track: m.track ?? null,
              has_instrumental_music: m.has_instrumental_music,
              url_music: m.url_music || null,
              url_instrumental_music: m.url_instrumental_music || null,
              url_image: m.url_image || null,
            })),
          };
        }),
      };
    });

    // 2. Programas de liturgia cadastrados (tabela pode não existir em DBs legados).
    let programs: Array<{
      id_program: number;
      name: string;
      active: boolean;
      url_file: string | null;
    }> = [];
    const hasProgramsTable = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='liturgy_programs'`,
      )
      .get();
    if (hasProgramsTable) {
      const rows = db
        .prepare(
          `SELECT lp.id_program, lp.name, lp.active, fl.url as url_file
           FROM liturgy_programs lp
           LEFT JOIN files fl ON fl.id_file = lp.id_file
           WHERE lp.id_language = ?
           ORDER BY lp.id_program`,
        )
        .all(lang) as Array<{
        id_program: number;
        name: string;
        active: number;
        url_file: string | null;
      }>;
      programs = rows.map((r) => ({
        id_program: r.id_program,
        name: r.name,
        active: !!r.active,
        url_file: r.url_file || null,
      }));
    }

    const body = { categories: catalogCategories, programs };

    // Cache-friendly: ETag determinístico (APK faz 304 e economiza payload).
    const etag = `"${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32)}"`;
    if (c.req.header("If-None-Match") === etag) {
      return c.body(null, 304, { ETag: etag });
    }

    return c.json(body, 200, { ETag: etag });
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao buscar catálogo de liturgia" }, 500);
  }
});

export { liturgyRoutes };
