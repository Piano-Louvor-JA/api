import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getDb } from "../../db/connection.js";
import { zodErrorHook } from "../../lib/zodErrorHook.js";
import { BibleBookSchema, BibleChapterSchema } from "./bible.schemas.js";

const app = new OpenAPIHono({ defaultHook: zodErrorHook });
const ErrorResponseSchema = z.object({ error: z.string() });

// GET /v1/bible
const listRoute = createRoute({
  method: "get",
  path: "",
  tags: ["bible"],
  summary: "Lista de livros da Biblia",
  description: "Lista completa dos livros da Biblia de acordo com o idioma.",
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
        "application/json": {
          schema: z.object({ data: z.array(BibleBookSchema) }),
        },
      },
      description: "Sucesso",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Erro interno",
    },
  },
});

app.openapi(listRoute, (c) => {
  const { lang } = c.req.valid("query");
  const db = getDb();

  try {
    const books = db
      .prepare(
        `SELECT *, id_book AS id_bible_book FROM bible_books WHERE id_language = ?`,
      )
      .all(lang) as any[];

    const response = {
      data: books.map((b) => ({
        id_bible_book: b.id_bible_book,
        name: b.name,
        chapters: b.chapters,
      })),
    };

    return c.json(response, 200);
  } catch (error) {
    console.error("Error fetching bible books:", error);
    return c.json({ error: "Erro ao buscar livros da biblia" }, 500);
  }
});

// GET /v1/bible/{bookId}/{chapter}
const chapterRoute = createRoute({
  method: "get",
  path: "/{bookId}/{chapter}",
  tags: ["bible"],
  summary: "Obtem um capitulo da Biblia",
  description:
    "Retorna todos os versiculos de um capitulo especifico de um livro.",
  request: {
    query: z.object({
      lang: z
        .string()
        .default("pt")
        .openapi({ description: "Idioma (pt, es, en)", example: "pt" }),
    }),
    params: z.object({
      bookId: z.string().openapi({ description: "ID do Livro", example: "1" }),
      chapter: z
        .string()
        .openapi({ description: "Numero do capitulo", example: "1" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: BibleChapterSchema } },
      description: "Sucesso",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Nao encontrado",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Erro interno",
    },
  },
});

app.openapi(chapterRoute, (c) => {
  const { lang } = c.req.valid("query");
  const { bookId, chapter } = c.req.valid("param");

  const db = getDb();

  try {
    const parsedBookId = parseInt(bookId, 10);
    const parsedChapter = parseInt(chapter, 10);

    const bibleChapter = db
      .prepare(
        `SELECT * FROM bible_chapters WHERE id_bible_book = ? AND id_language = ? AND chapter = ?`,
      )
      .get(parsedBookId, lang, parsedChapter) as any;

    if (!bibleChapter) return c.json({ error: "Capitulo nao encontrado" }, 404);

    const verses = db
      .prepare(
        `SELECT verse, text FROM bible_verses WHERE id_bible_chapter = ? ORDER BY verse ASC`,
      )
      .all(bibleChapter.id_bible_chapter) as any[];

    return c.json(
      {
        id_bible_chapter: bibleChapter.id_bible_chapter,
        id_bible_book: bibleChapter.id_bible_book,
        chapter: bibleChapter.chapter,
        verses: verses.map((v) => ({ verse: v.verse, text: v.text })),
      },
      200,
    );
  } catch (error) {
    console.error("Error fetching bible chapter:", error);
    return c.json({ error: "Erro ao buscar capitulo da biblia" }, 500);
  }
});

export { app as bibleRoutes };
