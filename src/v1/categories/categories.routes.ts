import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getDb } from "../../db/connection.js";
import { zodErrorHook } from "../../lib/zodErrorHook.js";
import {
  CategoriesListResponseSchema,
  CategorySchema,
} from "./categories.schemas.js";

const categoriesRoutes = new OpenAPIHono({ defaultHook: zodErrorHook });

// ============================================
// GET /v1/categories — paridade com /json_db/pt_categories
// Retorna ARRAY DIRETO (sem wrapper de paginacao)
// ============================================
const listCategoriesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["categories"],
  description:
    "Lista categorias com coletâneas aninhadas (paridade: pt_categories)",
  request: {
    query: z.object({
      lang: z
        .string()
        .openapi({ description: "Idioma (ex: pt, es)", example: "pt" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: CategoriesListResponseSchema } },
      description: "Lista de categorias com coletâneas",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

categoriesRoutes.openapi(listCategoriesRoute, (c) => {
  const { lang } = c.req.valid("query");

  try {
    const db = getDb();

    // Query de categorias — traduzida do PHP
    // type='collection', ordenado por order
    const categories = db
      .prepare(
        `SELECT
          ct.id_category,
          ct.name,
          ct.slug,
          ct."order"
        FROM categories ct
        WHERE ct.type = 'collection'
          AND ct.id_language = ?
        ORDER BY ct."order"`,
      )
      .all(lang) as Array<{
      id_category: number;
      name: string;
      slug: string;
      order: number;
    }>;

    // Para cada categoria, buscar os albums aninhados
    // Traduzido do PHP: com pivot categories_albums (subtitle, order)
    // url_image = concat(files_image.dir, '/', files_image.file_name)
    const result = categories.map((cat) => {
      const albums = db
        .prepare(
          `SELECT
            al.id_album,
            al.name,
            al.color,
            fi.url as url_image,
            ca.name as subtitle,
            ca."order"
          FROM albums al
          INNER JOIN categories_albums ca ON ca.id_album = al.id_album
          LEFT JOIN files fi ON al.id_file_image = fi.id_file
          WHERE ca.id_category = ?
            AND al.id_language = ?
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
        albums: albums.map((a) => ({
          id_album: a.id_album,
          name: a.name,
          color: a.color || null,
          url_image: a.url_image || null,
          subtitle: a.subtitle || null,
          order: a.order,
        })),
      };
    });

    // Sem wrapper — array direto como o upstream
    return c.json(result, 200);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao buscar categorias" }, 500);
  }
});

// ============================================
// GET /v1/categories/:id — detalhe individual
// ============================================
const getCategoryRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["categories"],
  description: "Detalhe de uma categoria com coletâneas aninhadas",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da Categoria", example: "6" }),
    }),
    query: z.object({
      lang: z
        .string()
        .openapi({ description: "Idioma (ex: pt, es)", example: "pt" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: CategorySchema } },
      description: "Detalhes da categoria",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Categoria não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

categoriesRoutes.openapi(getCategoryRoute, (c) => {
  const { id } = c.req.valid("param");
  const { lang } = c.req.valid("query");
  const idCategory = parseInt(id, 10);

  try {
    const db = getDb();

    const category = db
      .prepare(
        `SELECT
          ct.id_category,
          ct.name,
          ct.slug,
          ct."order"
        FROM categories ct
        WHERE ct.id_category = ?
          AND ct.id_language = ?`,
      )
      .get(idCategory, lang) as
      | { id_category: number; name: string; slug: string; order: number }
      | undefined;

    if (!category) {
      return c.json({ error: "Categoria não encontrada" }, 404);
    }

    const albums = db
      .prepare(
        `SELECT
          al.id_album,
          al.name,
          al.color,
          fi.url as url_image,
          ca.name as subtitle,
          ca."order"
        FROM albums al
        INNER JOIN categories_albums ca ON ca.id_album = al.id_album
        LEFT JOIN files fi ON al.id_file_image = fi.id_file
        WHERE ca.id_category = ?
          AND al.id_language = ?
        ORDER BY ca."order"`,
      )
      .all(idCategory, lang) as Array<{
      id_album: number;
      name: string;
      color: string | null;
      url_image: string | null;
      subtitle: string | null;
      order: number;
    }>;

    return c.json(
      {
        id_category: category.id_category,
        name: category.name,
        slug: category.slug,
        order: category.order,
        albums: albums.map((a) => ({
          id_album: a.id_album,
          name: a.name,
          color: a.color || null,
          url_image: a.url_image || null,
          subtitle: a.subtitle || null,
          order: a.order,
        })),
      },
      200,
    );
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao buscar categoria" }, 500);
  }
});

export { categoriesRoutes };
