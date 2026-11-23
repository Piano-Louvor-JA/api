// B1 — Central de Tickets: resolução de identidade (BD-01) e RBAC por membership.
//
// Token aceito: Firebase ID token (verificado via firebase-admin quando
// FIREBASE_SERVICE_ACCOUNT está configurado). Em ambiente de teste
// (TICKETS_AUTH_TEST_MODE=1), aceita o formato "uid:<uid>" para permitir
// exercitar membership/RBAC sem credenciais Firebase.
import type { MiddlewareHandler } from "hono";
import { getDb } from "../../db/connection.js";

export type TicketsRole = "member" | "agent" | "admin" | "global_operator";

export interface TicketsAuth {
  uid: string;
  tenantId: string | null;
  role: TicketsRole;
  globalOperator: boolean;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let firebaseApp: import("firebase-admin/app").App | null = null;

async function getFirebaseApp(): Promise<import("firebase-admin/app").App> {
  if (!firebaseApp) {
    const { initializeApp, cert } = await import("firebase-admin/app");
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT ??
        (() => {
          throw new HttpError(503, "auth indisponível");
        })(),
    );
    firebaseApp = initializeApp({ credential: cert(serviceAccount) });
  }
  return firebaseApp;
}

/** Extrai o UID de um Bearer token. Firebase ID token em produção;
 *  "uid:<uid>" somente em TICKETS_AUTH_TEST_MODE=1 (testes). */
export async function verifyToken(token: string): Promise<string> {
  if (process.env.TICKETS_AUTH_TEST_MODE === "1") {
    if (token.startsWith("uid:")) return token.slice(4);
    throw new HttpError(401, "não autenticado");
  }
  try {
    const app = await getFirebaseApp();
    const { getAuth } = await import("firebase-admin/auth");
    const decoded = await getAuth(app).verifyIdToken(token, true);
    return decoded.uid;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // token inválido/expirado/revogado — 401 genérico, sem detalhes internos
    throw new HttpError(401, "não autenticado");
  }
}

/** Resolve UID → membership ativa + tenant ativo. Sem membership visível:
 *  403 sem revelar existência de tenants. */
export async function resolveTicketsAuth(token: string): Promise<TicketsAuth> {
  const uid = await verifyToken(token);
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT m.tenant_id, m.role, m.status AS member_status, t.status AS tenant_status
       FROM tenant_memberships m
       JOIN tenants t ON t.id = m.tenant_id
       WHERE m.principal_id = ?`,
    )
    .all(uid) as {
    tenant_id: string;
    role: TicketsRole;
    member_status: string;
    tenant_status: string;
  }[];

  const active = rows.filter(
    (r) => r.member_status === "active" && r.tenant_status === "active",
  );
  if (active.length === 0) {
    // membership suspensa ou tenant suspenso → mesmo 403 genérico
    throw new HttpError(403, "sem acesso");
  }

  const global = active.find((r) => r.role === "global_operator");
  if (global) {
    return {
      uid,
      tenantId: null,
      role: "global_operator",
      globalOperator: true,
    };
  }
  // v1: uma membership ativa por UID define o escopo do tenant
  const first = active[0];
  return {
    uid,
    tenantId: first.tenant_id,
    role: first.role,
    globalOperator: false,
  };
}

export interface TicketsEnv {
  Variables: { ticketsAuth: TicketsAuth };
}

/** Middleware Hono: popula c.get("ticketsAuth") ou lança 401/403. */
export const ticketsAuthMiddleware: MiddlewareHandler<TicketsEnv> = async (
  c,
  next,
) => {
  const raw = c.req.header("authorization") ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  if (!token) throw new HttpError(401, "não autenticado");
  const auth = await resolveTicketsAuth(token);
  c.set("ticketsAuth", auth);
  await next();
};

/** Garante que a identidade pode operar o tenant solicitado (RF-01):
 *  membership no tenant, ou global_operator. Caso contrário 403 genérico. */
export function assertTenantScope(auth: TicketsAuth, tenantId: string): void {
  if (auth.globalOperator) return;
  if (auth.tenantId !== tenantId) {
    // não revela existência/conteúdo de outro tenant
    throw new HttpError(403, "sem acesso");
  }
}

/** Papéis com permissão de administração (triagem/conversão/kill switch). */
export function assertAdmin(auth: TicketsAuth): void {
  if (auth.role !== "admin" && !auth.globalOperator) {
    throw new HttpError(403, "sem acesso");
  }
}
