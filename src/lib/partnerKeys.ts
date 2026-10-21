/**
 * Token de parceiro (.planning/partner-keys/SPEC.md).
 *
 * O token vai embutido no app do parceiro, então é um identificador
 * revogável, não um segredo forte: identifica o parceiro e permite cortar o
 * acesso dele. Só o SHA-256 fica no banco.
 */

import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/connection.js";

export interface Partner {
  id: number;
  name: string;
}

export interface PartnerInfo extends Partner {
  key_prefix: string;
  active: boolean;
  created_at: string;
  revoked_at: string | null;
}

const KEY_PREFIX = "plj_";

export function generatePartnerKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

export function hashPartnerKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Cria o parceiro e devolve o token em claro — única vez que ele existe. */
export function createPartner(name: string): Partner & { key: string } {
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Nome do parceiro é obrigatório");
  const key = generatePartnerKey();
  const result = getDb()
    .prepare(
      "INSERT INTO partner_keys (name, key_prefix, key_hash) VALUES (?, ?, ?)",
    )
    .run(cleanName, key.slice(0, 8), hashPartnerKey(key));
  return { id: Number(result.lastInsertRowid), name: cleanName, key };
}

export function findPartnerByKey(key: string): Partner | null {
  if (!key) return null;
  const row = getDb()
    .prepare(
      "SELECT id_partner, name FROM partner_keys WHERE key_hash = ? AND active = 1",
    )
    .get(hashPartnerKey(key)) as
    | { id_partner: number; name: string }
    | undefined;
  return row ? { id: row.id_partner, name: row.name } : null;
}

/** true se revogou agora; false se não existe ou já estava revogado. */
export function revokePartner(id: number): boolean {
  const result = getDb()
    .prepare(
      "UPDATE partner_keys SET active = 0, revoked_at = CURRENT_TIMESTAMP WHERE id_partner = ? AND active = 1",
    )
    .run(id);
  return result.changes > 0;
}

export function listPartners(): PartnerInfo[] {
  const rows = getDb()
    .prepare(
      "SELECT id_partner, name, key_prefix, active, created_at, revoked_at FROM partner_keys ORDER BY id_partner",
    )
    .all() as Array<{
    id_partner: number;
    name: string;
    key_prefix: string;
    active: number;
    created_at: string;
    revoked_at: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id_partner,
    name: r.name,
    key_prefix: r.key_prefix,
    active: r.active === 1,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
  }));
}
