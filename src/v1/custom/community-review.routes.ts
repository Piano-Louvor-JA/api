/**
 * SPEC piano-admin-comunidade-moderacao v2.0.0 (RF-A1..A6) + ADR-001/002.
 *
 * POST /v1/custom/admin/community/review — moderação de cadastros da
 * comunidade (testadores/devs/relatos) gravando a célula de status na sheet
 * REAL (Sheets API v4), linha FÍSICA 1-based (header=1, dados ≥2; nunca
 * índice pós-filtro — mata o off-by-one que gerava 400 no painel).
 *
 * Camadas:
 * - Gate fail-closed communityReviewerAuth (allowlist COMMUNITY_REVIEWER_EMAILS,
 *   padrão adminAuth); email vem de c.get("user"), NUNCA do body.
 * - Fluxo de escrita delegado a community-review.service.ts.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import type { AdminEnv } from "./admin.middleware.js";
import {
  resetCommunityReviewStateForTests,
  reviewCommunityEntry,
} from "./community-review.service.js";

export type CommunityReviewEnv = AdminEnv;

// Header X-Tenant documentado no OpenAPI (paridade com custom.routes.ts;
// tenant real é resolvido pelo tenantMiddleware global em /v1/custom/*).
const tenantHeader = z.string().default("piano").openapi("X-Tenant", {
  description: "Tenant do ecossistema PIANO",
  example: "piano",
});

function reviewerEmails(): Set<string> {
  const raw = process.env.COMMUNITY_REVIEWER_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((e: string) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Gate fail-closed: sem env → 403 para todos (padrão adminAuth). */
export const communityReviewerAuth: MiddlewareHandler<
  CommunityReviewEnv
> = async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Não autenticado" }, 401);

  const allow = reviewerEmails();
  if (allow.size === 0) {
    console.warn(
      "[communityReview] COMMUNITY_REVIEWER_EMAILS vazio — moderação desativada (fail-closed)",
    );
  }
  if (!allow.has(user.email.toLowerCase())) {
    return c.json({ error: "Sem permissão" }, 403);
  }
  await next();
};

export const communityReviewRoutes = new OpenAPIHono<CommunityReviewEnv>();

const reviewSchema = z.object({
  tab: z.string().min(1),
  row: z.number().int().min(2),
  acao: z.string().min(1),
});

const reviewRoute = createRoute({
  method: "post",
  path: "/admin/community/review",
  tags: ["custom"],
  description:
    "Aprova/rejeita cadastro da comunidade na sheet real (linha física ≥2). Gate COMMUNITY_REVIEWER_EMAILS fail-closed.",
  request: {
    headers: z.object({ "X-Tenant": tenantHeader }),
    body: { content: { "application/json": { schema: reviewSchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
      description: "Moderação persistida",
    },
    400: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Body/ação inválida",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Não autenticado",
    },
    403: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Sem papel",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Linha não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Sheet/OAuth não configurado ou falha",
    },
  },
});

communityReviewRoutes.use("/admin/community/review", communityReviewerAuth);

communityReviewRoutes.openapi(reviewRoute, async (c) => {
  const body = c.req.valid("json");
  const result = await reviewCommunityEntry(body);
  if (!result.ok) {
    // validação de negócio (tab/row/ação/env) → 400; falhas de sheet/oauth → mapeado.
    const isValidation =
      !result.error.startsWith("sheet-") &&
      result.error !== "Linha não encontrada" &&
      !result.error.includes("não configurado") &&
      !result.error.startsWith("oauth-");
    const status = isValidation
      ? 400
      : result.error === "Linha não encontrada"
        ? 404
        : 500;
    return c.json({ error: result.error }, status as 400) as never;
  }
  return c.json(result as Record<string, unknown>, 200) as never;
});

export { resetCommunityReviewStateForTests };
