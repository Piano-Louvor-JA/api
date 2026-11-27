import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getDb } from "../../db/connection.js";

const app = new OpenAPIHono();

// SPEC locale-convite v1.1: catálogo vazio para um locale deve retornar uma
// flag de convite (200), nunca um erro — a app exibe o convite à comunidade.
const CatalogStatusResponseSchema = z.object({
  lang: z.string(),
  has_albums: z.boolean(),
  has_musics: z.boolean(),
  has_bible: z.boolean(),
  invite_catalogo: z.boolean(),
});

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["catalog"],
  summary: "Verificação de catálogo por locale",
  description:
    "Indica se existe catálogo (álbuns, músicas, Bíblia) para o idioma. " +
    "Quando vazio, retorna invite_catalogo=true para a app exibir o convite " +
    "à comunidade em vez de mensagem de erro.",
  request: {
    query: z.object({
      lang: z
        .string()
        .default("pt")
        .openapi({ description: "Idioma (pt, es, en)", example: "pt" }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: CatalogStatusResponseSchema },
      },
      description: "Status do catálogo para o locale",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

app.openapi(statusRoute, (c) => {
  const { lang } = c.req.valid("query");
  const db = getDb();

  try {
    const count = (sql: string): number => {
      const row = db.prepare(sql).get(lang) as { count: number };
      return Number(row.count);
    };

    const hasAlbums =
      count(`SELECT COUNT(*) as count FROM albums WHERE id_language = ?`) > 0;
    const hasMusics =
      count(`SELECT COUNT(*) as count FROM musics WHERE id_language = ?`) > 0;
    const hasBible =
      count(`SELECT COUNT(*) as count FROM bible_books WHERE id_language = ?`) >
      0;

    const hasCatalog = hasAlbums || hasMusics || hasBible;

    return c.json(
      {
        lang,
        has_albums: hasAlbums,
        has_musics: hasMusics,
        has_bible: hasBible,
        // Chave alinhada com a SPEC: `convite_catalogo` nos locales.
        invite_catalogo: !hasCatalog,
      },
      200,
    );
  } catch (error) {
    console.error("Error checking catalog status:", error);
    return c.json({ error: "Erro ao verificar catalogo" }, 500);
  }
});

export const catalogRoutes = app;
