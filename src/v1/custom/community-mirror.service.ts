import { getFirestore } from "firebase-admin/firestore";
import { getFirebaseApp } from "./firebase-auth.middleware.js";

/**
 * SPEC admin-membros v1.0.0 — espelho Firebase Auth → Firestore
 * `community_members` (read-model do painel /admin/membros).
 *
 * - Fonte da verdade de usuários: Firebase Auth; isto é espelho best-effort.
 * - NEVER-write role/status: upsert de login escreve apenas
 *   {uid, email, name, createdAt?, lastLoginAt} — role/status são
 *   admin-only via PATCH (never-downgrade por nunca-escrever, decisão 4).
 * - Fail-open: erros não lançam (login nunca quebra por causa do espelho).
 */

const COLLECTION = "community_members";

export type CommunityMemberInput = {
  uid: string;
  email: string;
  name: string;
};

type Firestore = ReturnType<typeof getFirestore>;

let firestoreOverride: Firestore | null = null;

export function setCommunityMemberFirestoreForTests(
  firestore: Firestore | null,
): void {
  firestoreOverride = firestore;
}

async function getDb(): Promise<Firestore> {
  if (firestoreOverride) return firestoreOverride;
  return getFirestore(await getFirebaseApp());
}

export type UpsertResult = "created" | "updated" | "unchanged";

/**
 * Upsert de login: cria doc com role='member'/status='active' (merge) ou,
 * se existe, atualiza APENAS lastLoginAt/email/name. Erros são engolidos
 * (fail-open — AC8) para nunca quebrar o login. Retorna o resultado
 * (para report de idempotência do CLI: unchanged = perfil igual).
 */
export async function upsertCommunityMember(
  member: CommunityMemberInput,
): Promise<UpsertResult> {
  try {
    const db = await getDb();
    const doc = db.collection(COLLECTION).doc(member.uid);
    const snap = await doc.get();
    const now = new Date();
    const existing = snap.exists
      ? (snap.data() as Record<string, unknown> | undefined)
      : undefined;
    if (existing) {
      const profileChanged =
        existing.email !== member.email || existing.name !== member.name;
      await doc.set(
        { lastLoginAt: now, email: member.email, name: member.name },
        { merge: true },
      );
      return profileChanged ? "updated" : "unchanged";
    }
    // create() fails atomically when another login/admin created the document
    // after our read; never overwrite their role/status with initial defaults.
    try {
      await doc.create({
        uid: member.uid,
        email: member.email,
        name: member.name,
        role: "member",
        status: "active",
        createdAt: now,
        lastLoginAt: now,
      });
      return "created";
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== 6
      ) {
        throw error;
      }
      await doc.set(
        { lastLoginAt: now, email: member.email, name: member.name },
        { merge: true },
      );
      return "updated";
    }
  } catch (e) {
    console.warn(
      "[communityMirror] upsert falhou (fail-open):",
      e instanceof Error ? e.message : String(e),
    );
    return "unchanged";
  }
}
