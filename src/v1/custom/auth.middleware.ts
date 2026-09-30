import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { getDb } from "../../db/connection.js";
import { hashToken } from "./auth.service.js";

// Variáveis de contexto injetadas pelos middlewares de auth.
// app.ts declara o Hono com essas Variables p/ c.get("user") tipar.
export type CustomAuthEnv = {
  Variables: {
    user: { id_user: number; email: string; display_name: string };
  };
};

/**
 * Middleware opcional: se houver Authorization: Bearer <token>,
 * popula c.get("user") com { id_user, email, display_name }.
 * Não bloqueia se não houver token — rotas públicas continuam funcionando.
 */
export const optionalAuth: MiddlewareHandler<CustomAuthEnv> =
  createMiddleware<CustomAuthEnv>(async (c, next) => {
    const raw = c.req.header("authorization") ?? "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
    if (!token) return next();

    const db = getDb();
    const session = db
      .prepare(
        `SELECT cu.id_user, cu.email, cu.display_name
       FROM custom_sessions cs
       INNER JOIN custom_users cu ON cu.id_user = cs.id_user
       WHERE cs.token_hash = ?`,
      )
      .get(hashToken(token)) as
      | { id_user: number; email: string; display_name: string }
      | undefined;

    if (session) {
      c.set("user", {
        id_user: session.id_user,
        email: session.email,
        display_name: session.display_name,
      });
    }
    await next();
  });

/**
 * Middleware obrigatório: exige token válido.
 * Retorna 401 se não autenticado.
 */
export const requireAuth: MiddlewareHandler<CustomAuthEnv> =
  createMiddleware<CustomAuthEnv>(async (c, next) => {
    const raw = c.req.header("authorization") ?? "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
    if (!token) return c.json({ error: "Não autenticado" }, 401);

    const db = getDb();
    const session = db
      .prepare(
        `SELECT cu.id_user, cu.email, cu.display_name
       FROM custom_sessions cs
       INNER JOIN custom_users cu ON cu.id_user = cs.id_user
       WHERE cs.token_hash = ?`,
      )
      .get(hashToken(token)) as
      | { id_user: number; email: string; display_name: string }
      | undefined;

    if (!session) return c.json({ error: "Não autenticado" }, 401);

    c.set("user", {
      id_user: session.id_user,
      email: session.email,
      display_name: session.display_name,
    });
    await next();
  });
