// SEC-4 (api#125): ZodError não pode vazar na resposta (info leak).
// defaultHook do @hono/zod-openapi: validação falhou -> resposta genérica
// "Parâmetros inválidos" (400); detalhe completo só em console.error server-side.
import type { ContentfulStatusCode } from "hono/utils/http-status";

type ZodErrorHookResult = {
  success: boolean;
  error?: { issues: unknown[] };
};

type MinimalContext = {
  json: (body: unknown, status: ContentfulStatusCode) => unknown;
};

export const zodErrorHook = (
  result: ZodErrorHookResult,
  c: MinimalContext,
): unknown => {
  if (result.success) return undefined;
  console.error(
    "ZodError:",
    JSON.stringify(result.error?.issues ?? [], null, 2),
  );
  return c.json(
    { success: false, error: "Parâmetros inválidos" },
    400 as ContentfulStatusCode,
  );
};
