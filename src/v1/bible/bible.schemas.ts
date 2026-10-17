import { z } from "@hono/zod-openapi";

export const BibleBookSchema = z.object({
  id_bible_book: z.number().openapi({ example: 1 }),
  name: z.string().openapi({ example: "Gênesis" }),
  chapters: z.number().openapi({ example: 50 }),
});

export const BibleChapterSchema = z.object({
  id_bible_chapter: z.number().openapi({ example: 1 }),
  id_bible_book: z.number().openapi({ example: 1 }),
  chapter: z.number().openapi({ example: 1 }),
  verses: z.array(
    z.object({
      verse: z.number().openapi({ example: 1 }),
      text: z
        .string()
        .openapi({ example: "No princípio, criou Deus os céus e a terra." }),
    }),
  ),
});

export const BibleBundleManifestSchema = z.object({
  schema: z.literal(1),
  versions: z.array(
    z.object({
      versionId: z.number().openapi({ example: 2 }),
      language: z.string().openapi({ example: "pt" }),
      name: z.string().openapi({ example: "Almeida Revista e Atualizada" }),
      abbreviation: z.string().openapi({ example: "ARA" }),
      books: z.number().openapi({ example: 66 }),
      chapters: z.number().openapi({ example: 1189 }),
      complete: z.boolean().openapi({
        description: "false = falta capítulo no cache; bundle indisponível",
      }),
      missing: z.number().openapi({ example: 0 }),
      sha256: z.string().nullable().openapi({
        description:
          "sha256 dos bytes do JSON descompactado do bundle (igual ao ETag)",
      }),
      bytes: z.number().nullable(),
      gzipBytes: z.number().nullable(),
      updatedAt: z.string().nullable().openapi({
        description: "Data do capítulo mais recente no cache (ISO 8601)",
      }),
    }),
  ),
});

export const BibleBundleSchema = z.object({
  schema: z.literal(1),
  versionId: z.number().openapi({ example: 2 }),
  language: z.string().openapi({ example: "pt" }),
  name: z.string(),
  abbreviation: z.string(),
  chapters: z
    .record(z.string(), z.record(z.string(), z.record(z.string(), z.string())))
    .openapi({
      description:
        "{ idLivro: { capítulo: { versículo: texto } } } — mesmos textos de /json_db/bible_{v}_{b}_{c}",
      example: {
        "1": { "1": { "1": "No princípio, criou Deus os céus e a terra." } },
      },
    }),
});

export const BibleBundleIncompleteSchema = z.object({
  error: z.literal("bundle_incompleto"),
  missing: z.number(),
  sample: z.array(z.string()),
});
