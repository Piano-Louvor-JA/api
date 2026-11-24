/**
 * central-tickets B1 — auth tenant-aware (SPEC frozen 2026-11-21).
 *
 * Firebase ID token → UID → memberships → contexto { uid, tenantId, role }.
 * Fail-closed: sem token/inválido = 401; sem membership = 403.
 * Tenant resolvido por ?tenant= (ou header X-Tenant), default = primeira
 * membership; membership em outro tenant não autoriza acesso.
 */
import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { getDb } from "../../db/connection.js";

export type TicketRole = "client" | "agent" | "admin";

export type TicketsEnv = {
  Variables: {
    ticketsUser: {
      uid: string;
      email: string;
      tenantId: string;
      role: TicketRole;
    };
  };
};

const ROLE_RANK: Record<TicketRole, number> = {
  client: 1,
  agent: 2,
  admin: 3,
};

export async function verifyFirebaseToken(
  token: string,
): Promise<{ uid: string; email?: string } | null> {
  const segments = token.split(".").length;
  if (segments !== 3) return null;
  const { getFirebaseApp } = await import(
    "../custom/firebase-auth.middleware.js"
  );
  const app = await getFirebaseApp();
  const { getAuth } = await import("firebase-admin/auth");
  const decoded = await getAuth(app).verifyIdToken(token, true);
  return { uid: decoded.uid, email: decoded.email };
}

export const ticketsAuth: MiddlewareHandler<TicketsEnv> =
  createMiddleware<TicketsEnv>(async (c, next) => {
    const raw = c.req.header("authorization") ?? "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
    if (!token) return c.json({ error: "Não autenticado" }, 401);

    let claims: { uid: string; email?: string } | null = null;
    try {
      claims = await verifyFirebaseToken(token);
    } catch {
      claims = null;
    }
    if (!claims) return c.json({ error: "Token inválido" }, 401);

    const db = getDb();
    const memberships = db
      .prepare(
        "SELECT tenant_id, role FROM tickets_memberships WHERE firebase_uid = ? ORDER BY tenant_id",
      )
      .all(claims.uid) as { tenant_id: string; role: TicketRole }[];

    if (memberships.length === 0) {
      return c.json({ error: "Sem acesso a nenhum tenant" }, 403);
    }

    const wanted =
      c.req.query("tenant") ?? c.req.header("x-tenant") ?? undefined;
    // SPEC-B1.1 §1.2: tenant explicitamente solicitado e não pertencente à
    // identidade → 403 (sem fallback silencioso). Default = primeira
    // membership apenas quando nenhum tenant foi informado.
    const chosen = wanted
      ? memberships.find((m) => m.tenant_id === wanted)
      : memberships[0];
    if (!chosen) return c.json({ error: "Sem acesso ao tenant" }, 403);

    c.set("ticketsUser", {
      uid: claims.uid,
      email: claims.email ?? "",
      tenantId: chosen.tenant_id,
      role: chosen.role,
    });
    await next();
  });

/** Gate de papel mínimo (client < agent < admin). */
export const requireTicketRole = (
  min: TicketRole,
): MiddlewareHandler<TicketsEnv> =>
  createMiddleware<TicketsEnv>(async (c, next) => {
    const u = c.get("ticketsUser");
    if (!u) return c.json({ error: "Não autenticado" }, 401);
    if (ROLE_RANK[u.role] < ROLE_RANK[min]) {
      return c.json({ error: "Sem permissão" }, 403);
    }
    await next();
  });
