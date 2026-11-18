import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { apkPath, readManifest } from "../../lib/appUpdates.js";
import { zodErrorHook } from "../../lib/zodErrorHook.js";

/**
 * Atualização do apk Android (sem auth): o app pergunta a versão aqui e baixa
 * o apk daqui, sem depender do limite anônimo da API do GitHub.
 * iOS não usa: lá a atualização é pela App Store.
 */

const AppVersionSchema = z.object({
  version: z.string().openapi({ example: "1.0.1" }),
  apk_url: z
    .string()
    .openapi({ example: "/v1/app/apk/louvorja-piano-1.0.1.apk" }),
  size: z.number().openapi({ example: 157040991 }),
  sha256: z.string().openapi({
    example: "a61ede7b3f6323c6cd2535768a07dfafe3d29c10f29fbda5201ab1930b53af5b",
  }),
  notes: z.string(),
  published_at: z.string().nullable(),
});

const NotPublishedSchema = z.object({ error: z.string() });

const appRoutes = new OpenAPIHono({ defaultHook: zodErrorHook });

const versionRoute = createRoute({
  method: "get",
  path: "/version",
  tags: ["app"],
  summary: "Última versão do apk Android publicada",
  description:
    "Manifesto escrito na VPS pelo CLI fetch-apk. 404 quando nenhuma versão foi publicada (o app usa o caminho de reserva).",
  responses: {
    200: {
      content: { "application/json": { schema: AppVersionSchema } },
      description: "Versão publicada",
    },
    404: {
      content: { "application/json": { schema: NotPublishedSchema } },
      description: "Nenhuma versão publicada",
    },
  },
});

appRoutes.openapi(versionRoute, (c) => {
  const manifest = readManifest();
  // Sem cache longo: uma publicação nova precisa aparecer logo.
  c.header("Cache-Control", "public, max-age=300");
  if (!manifest) return c.json({ error: "No version published" }, 404);
  return c.json(
    {
      version: manifest.version,
      apk_url: `/v1/app/apk/${manifest.file}`,
      size: manifest.size,
      sha256: manifest.sha256,
      notes: manifest.notes,
      published_at: manifest.published_at,
    },
    200,
  );
});

appRoutes.get("/apk/:file", (c) => {
  const file = apkPath(c.req.param("file"));
  if (!file) return c.json({ error: "Not Found" }, 404);
  const size = statSync(file).size;
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${c.req.param("file")}"`,
      // O nome tem a versão: o conteúdo de um nome nunca muda.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

export { appRoutes };
