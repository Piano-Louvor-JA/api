import { gunzipSync } from "node:zlib";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getDb } from "../../db/connection.js";
import { zodErrorHook } from "../../lib/zodErrorHook.js";
import {
  BibleBookSchema,
  BibleBundleIncompleteSchema,
  BibleBundleManifestSchema,
  BibleBundleSchema,
  BibleChapterSchema,
} from "./bible.schemas.js";
import { getBibleBundle, getBibleBundleManifest } from "./bundle.service.js";

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
      .all(lang) as Array<{
      id_bible_book: number;
      name: string;
      chapters: number;
    }>;

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

// GET /v1/bible/bundles — registrado ANTES de /{bookId}/{chapter}, senão
// "bundles" casaria como bookId.
const bundleManifestRoute = createRoute({
  method: "get",
  path: "/bundles",
  tags: ["bible"],
  summary: "Manifesto dos bundles da Biblia",
  description:
    "Lista as versoes com sha256/tamanho do bundle completo. O cliente compara o sha256 com o que tem no disco para decidir se baixa de novo.",
  responses: {
    200: {
      content: { "application/json": { schema: BibleBundleManifestSchema } },
      description: "Sucesso",
    },
  },
});

app.openapi(bundleManifestRoute, (c) => {
  const versions = getBibleBundleManifest(getDb());
  c.header("Cache-Control", "public, max-age=300");
  return c.json({ schema: 1 as const, versions }, 200);
});

// GET /v1/bible/bundles/{versionId}
const bundleRoute = createRoute({
  method: "get",
  path: "/bundles/{versionId}",
  tags: ["bible"],
  summary: "Versao inteira da Biblia (bundle)",
  description:
    "Todos os capitulos de uma versao num unico JSON, compactado com gzip quando o cliente aceita. ETag = sha256 dos bytes descompactados; If-None-Match igual responde 304.",
  request: {
    params: z.object({
      versionId: z
        .string()
        .regex(/^\d+$/)
        .openapi({ description: "ID da versao", example: "2" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: BibleBundleSchema } },
      description: "Sucesso",
    },
    304: { description: "Bundle igual ao do cliente (If-None-Match)" },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Versao nao encontrada",
    },
    409: {
      content: { "application/json": { schema: BibleBundleIncompleteSchema } },
      description: "Cache da versao incompleto",
    },
  },
});

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .some((value) => value === etag || value === "*");
}

app.openapi(bundleRoute, (c) => {
  const versionId = Number(c.req.valid("param").versionId);
  const result = getBibleBundle(getDb(), versionId);

  if (result.status === "not_found") {
    return c.json({ error: "Versao nao encontrada" }, 404);
  }
  if (result.status === "incomplete") {
    return c.json(
      {
        error: "bundle_incompleto" as const,
        missing: result.missing,
        sample: result.sample,
      },
      409,
    );
  }

  const etag = `"${result.sha256}"`;
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "public, max-age=300",
    Vary: "Accept-Encoding",
  };
  if (etagMatches(c.req.header("If-None-Match"), etag)) {
    return c.body(null, 304, headers);
  }

  const acceptsGzip = /\bgzip\b/i.test(c.req.header("Accept-Encoding") ?? "");
  const body = acceptsGzip ? result.gzip : gunzipSync(result.gzip);
  headers["Content-Type"] = "application/json; charset=utf-8";
  headers["Content-Length"] = String(body.length);
  if (acceptsGzip) headers["Content-Encoding"] = "gzip";
  return c.body(new Uint8Array(body), 200, headers);
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
      .get(parsedBookId, lang, parsedChapter) as
      | { id_bible_chapter: number; id_bible_book: number; chapter: number }
      | undefined;

    if (!bibleChapter) return c.json({ error: "Capitulo nao encontrado" }, 404);

    const verses = db
      .prepare(
        `SELECT verse, text FROM bible_verses WHERE id_bible_chapter = ? ORDER BY verse ASC`,
      )
      .all(bibleChapter.id_bible_chapter) as Array<{
      verse: number;
      text: string;
    }>;

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
