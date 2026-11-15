/**
 * SPEC piano-admin-panel v1.1.0 (RF-01): gate de admin para rotas de gestão.
 *
 * Fail-closed por design:
 * - Sem sessão (c.get("user") ausente) → 401.
 * - ADMIN_EMAILS vazio/não configurado → NINGUÉM é admin (403 mesmo com
 *   sessão válida) — loga warn no boot para lembrar o operador.
 * - E-mail na allowlist (case-insensitive) → passa.
 * - Fora da allowlist → 403 uniforme (não revela se o recurso existe).
 */
import type { MiddlewareHandler } from "hono";

import { getDb } from "../../db/connection.js";

export type AdminEnv = {
  Variables: {
    user?: { id_user: number; email: string; display_name?: string };
    tenantId: string;
  };
};

function adminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((e: string) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const adminAuth: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Não autenticado" }, 401);
  }

  const allow = adminEmails();
  if (allow.size === 0) {
    console.warn(
      "[adminAuth] ADMIN_EMAILS vazio — painel admin desativado (fail-closed)",
    );
  }

  if (!allow.has(user.email.toLowerCase())) {
    return c.json({ error: "Sem permissão" }, 403);
  }

  await next();
};
