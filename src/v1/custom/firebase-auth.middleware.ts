import type { Env, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { getDb } from "../../db/connection.js";
import type { CustomAuthEnv } from "./auth.middleware.js";

/**
 * RF-003/RF-004 — Login unificado: aceita Firebase ID token como credencial.
 *
 * Middleware opcional: se houver Authorization: Bearer <firebase-id-token>,
 * valida via Firebase Admin SDK, faz upsert do usuário em custom_users
 * (chave firebase_uid) e popula c.get("user") com o mesmo shape do
 * optionalAuth (email/senha). Rotas públicas continuam funcionando.
 *
 * Ordem de uso: aplicar DEPOIS do optionalAuth — se aquele já resolveu
 * (token opaco legacy), este é no-op.
 */

let firebaseApp: import("firebase-admin/app").App | null = null;

async function getFirebaseApp(): Promise<import("firebase-admin/app").App> {
  if (!firebaseApp) {
    const { initializeApp, cert } = await import("firebase-admin/app");
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT ??
        (() => {
          throw new Error("FIREBASE_SERVICE_ACCOUNT não configurado");
        })(),
    );
    firebaseApp = initializeApp({ credential: cert(serviceAccount) });
  }
  return firebaseApp;
}

export const firebaseAuth: MiddlewareHandler<CustomAuthEnv> =
  createMiddleware<CustomAuthEnv>(async (c, next) => {
    // optionalAuth já populou user com token opaco legacy → respeitar
    if (c.get("user")) return next();

    const raw = c.req.header("authorization") ?? "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
    // Firebase ID tokens são JWTs (3 segmentos). Token opaco legacy tem 1.
    if (!token || token.split(".").length !== 3) return next();

    try {
      const app = await getFirebaseApp();
      const { getAuth } = await import("firebase-admin/auth");
      const decoded = await getAuth(app).verifyIdToken(token, true);
      console.log(
        "[firebaseAuth] token válido project_id:",
        decoded.firebase?.project_id ?? decoded.aud,
        "| uid:",
        decoded.uid,
      );

      const db = getDb();
      let user = db
        .prepare(
          `SELECT id_user, email, display_name FROM custom_users WHERE firebase_uid = ?`,
        )
        .get(decoded.uid) as
        | { id_user: number; email: string; display_name: string }
        | undefined;

      if (!user) {
        // Upsert: vincula por email se o usuário legacy já existir
        // (evita UNIQUE violation e preserva owner_id de coleções antigas)
        const email = decoded.email ?? `${decoded.uid}@firebase.local`;
        const displayName = decoded.name ?? email.split("@")[0];
        type DbUser = { id_user: number; email: string; display_name: string };
        const existing = db
          .prepare(
            `SELECT id_user, email, display_name FROM custom_users WHERE email = ?`,
          )
          .get(email) as DbUser | undefined;

        if (existing) {
          db.prepare(
            `UPDATE custom_users SET firebase_uid = ? WHERE id_user = ?`,
          ).run(decoded.uid, existing.id_user);
          user = {
            id_user: existing.id_user,
            email: existing.email,
            display_name: existing.display_name,
          };
        } else {
          const result = db
            .prepare(
              `INSERT INTO custom_users (email, password_hash, display_name, firebase_uid)
               VALUES (?, ?, ?, ?)`,
            )
            .run(email, "firebase$no-local-password", displayName, decoded.uid);
          user = {
            id_user: Number(result.lastInsertRowid),
            email,
            display_name: displayName,
          };
        }
      }

      if (user) {
        c.set("user", {
          id_user: user.id_user,
          email: user.email,
          display_name: user.display_name,
        });
      }
    } catch (e) {
      // Token Firebase inválido/expirado → segue anônimo (mesma semântica do optionalAuth)
      console.warn(
        "[firebaseAuth] verifyIdToken FALHOU:",
        e instanceof Error ? e.message : String(e),
      );
    }
    await next();
  });
