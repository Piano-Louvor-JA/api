/**
 * P0-B do reviewer (comentário #170): gate GM das rotas admin/members.
 *
 * Substitui/estende o adminAuth legado (ADMIN_EMAILS-only) pelo gate
 * especificado na SPEC comunidade-organica v1.0.0:
 * - Sem sessão Firebase → 401 (mesmo shape do adminAuth).
 * - `isGmMember(tenant, email)` — lookup (tenant,email) no Firestore,
 *   tenant-scoped; fail-closed: erro do Firestore só autoriza via fallback
 *   legado explícito (ADMIN_EMAILS), nunca pelo erro.
 * - Fora do gate → 403 uniforme.
 *
 * O tenant vem do header X-Tenant (resolvido como na rota: default
 * pianolouvorja); header inválido → 400 antes de qualquer lookup.
 */
import type { MiddlewareHandler } from "hono";
import { isGmMember } from "./members.service.js";

export type GmEnv = {
  Variables: {
    user?: { id_user: number; email: string; display_name?: string };
    tenantId: string;
  };
};

const COMMUNITY_TENANTS = ["pianolouvorja"] as const;

export const gmAuth: MiddlewareHandler<GmEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Não autenticado" }, 401);
  }

  const header = c.req.header("X-Tenant");
  const tenant =
    header === undefined || header === "" ? "pianolouvorja" : header;
  if (!(COMMUNITY_TENANTS as readonly string[]).includes(tenant)) {
    return c.json(
      { error: "Tenant inválido", valid_tenants: [...COMMUNITY_TENANTS] },
      400,
    );
  }
  c.set("tenantId", tenant);

  const allowed = await isGmMember(tenant, user.email);
  if (!allowed) {
    return c.json({ error: "Sem permissão" }, 403);
  }

  await next();
};
