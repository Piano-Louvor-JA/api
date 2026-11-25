import { createHash } from "node:crypto";
import { getFirestore } from "firebase-admin/firestore";
import { getFirebaseApp } from "./firebase-auth.middleware.js";

export const MEMBER_ROLES = [
  "dev",
  "tester",
  "conteudo",
  "curador",
  "staff",
] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const MEMBER_STATUSES = ["pendente", "aprovado", "inativo"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export type Member = {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  bio: string | null;
  github: string | null;
  since: unknown;
  roles: MemberRole[];
  status: MemberStatus;
  gm: boolean;
  created_at?: unknown;
  updated_at?: unknown;
};

export type PublicMember = Pick<
  Member,
  "id" | "name" | "avatar_url" | "bio" | "github" | "since" | "roles"
>;

let firestoreOverride: ReturnType<typeof getFirestore> | null = null;

export function setMembersFirestoreForTests(
  firestore: ReturnType<typeof getFirestore> | null,
): void {
  firestoreOverride = firestore;
}

async function getDb(): Promise<ReturnType<typeof getFirestore>> {
  if (firestoreOverride) return firestoreOverride;
  return getFirestore(await getFirebaseApp());
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Identidade opaca e determinística: nunca expõe email como ID público. */
export function memberIdFor(tenantId: string, email: string): string {
  return createHash("sha256")
    .update(`${tenantId}\0${normalizeEmail(email)}`)
    .digest("hex");
}

export function toPublicMember(member: Member): PublicMember {
  return {
    id: member.id,
    name: member.name,
    avatar_url: member.avatar_url,
    bio: member.bio,
    github: member.github,
    since: member.since,
    roles: member.roles,
  };
}

function memberFromDoc(id: string, data: unknown): Member | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  if (
    typeof row.tenant_id !== "string" ||
    typeof row.email !== "string" ||
    typeof row.name !== "string" ||
    !Array.isArray(row.roles) ||
    typeof row.status !== "string" ||
    typeof row.gm !== "boolean"
  ) {
    return null;
  }
  return { id, ...(row as Omit<Member, "id">) };
}

/**
 * Só retorna aprovados no tenant solicitado. E-mail/GM/status nunca cruzam
 * esta fronteira pública.
 */
export async function listRoster(
  tenantId: string,
  role: MemberRole,
): Promise<PublicMember[]> {
  const db = await getDb();
  const snapshot = await db
    .collection("members")
    .where("tenant_id", "==", tenantId)
    .where("status", "==", "aprovado")
    .get();

  return snapshot.docs
    .map((doc) => memberFromDoc(doc.id, doc.data()))
    .filter((member): member is Member => member !== null)
    .filter((member) => member.roles.includes(role))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map(toPublicMember);
}

/** Lookup direto por chave determinística sempre inclui tenant. */
export async function getMemberByEmail(
  tenantId: string,
  email: string,
): Promise<Member | null> {
  const db = await getDb();
  const id = memberIdFor(tenantId, email);
  const snapshot = await db.collection("members").doc(id).get();
  if (!snapshot.exists) return null;
  const member = memberFromDoc(snapshot.id, snapshot.data());
  return member?.tenant_id === tenantId ? member : null;
}

function legacyAdminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

/**
 * Gate GM: Firestore é a fonte de autorização; o fallback ADMIN_EMAILS é
 * transitório e só se aplica quando o lookup responde com certeza
 * (não encontrado / gm:false). Erro de lookup = resposta INDETERMINADA:
 * fail-closed absoluto (PLAN §2.4/§7) — retorna false mesmo com fallback
 * configurado, porque indisponibilidade do controle de autorização nunca
 * pode ser contornada pela env.
 */
export async function isGmMember(
  tenantId: string,
  email: string,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  let lookupConclusive = false;
  try {
    const member = await getMemberByEmail(tenantId, normalized);
    lookupConclusive = true;
    if (member?.gm === true) return true;
  } catch {
    // Firestore indisponível: sem resposta de autorização → fail-closed.
    return false;
  }
  return lookupConclusive && legacyAdminEmails().has(normalized);
}
