/**
 * Editas da Comunidade — service (SPEC piano-community-edits v1.0).
 * Fila de correções de letra/timing sobre músicas oficiais.
 * GM role v1: coluna is_gm em custom_users (concessão SQL manual);
 * isolado aqui para trocar a fonte em fase 2 sem tocar endpoints (RF-07).
 */
import type { Database } from "better-sqlite3";

export type EditStatus = "published" | "approved" | "rejected";

export function isConcilioMember(db: Database, userId: number): boolean {
  const row = db
    .prepare(`SELECT is_gm FROM custom_users WHERE id_user = ?`)
    .get(userId) as { is_gm: number } | undefined;
  return !!row && row.is_gm === 1;
}

export interface EditRow {
  id: number;
  client_uuid: string;
  music_id: number;
  author_user_id: number;
  status: EditStatus;
  lyrics: string | null;
  timing: string | null;
  reason: string | null;
  decided_by: number | null;
  decided_at: string | null;
  created_at: string;
  updated_at_ms: number;
}

export function publishEdit(
  db: Database,
  params: {
    clientUuid: string;
    musicId: number;
    authorId: number;
    tenantId: string;
    lyrics?: string | null;
    timing?: string | null;
  },
): { id: number; status: EditStatus } {
  const now = Date.now();
  const nowIso = new Date().toISOString();
  const existing = db
    .prepare(
      `SELECT id, client_uuid FROM custom_edits WHERE music_id = ? AND author_user_id = ? AND tenant_id = ? AND status = 'published'`,
    )
    .get(params.musicId, params.authorId, params.tenantId) as
    | { id: number; client_uuid: string }
    | undefined;

  // O hash de conteúdo pode ser igual para autores distintos. Só o retry do
  // mesmo autor no mesmo tenant reutiliza a contribuição já publicada.
  const byUuid = db
    .prepare(
      `SELECT id, status FROM custom_edits WHERE client_uuid = ? AND tenant_id = ? AND author_user_id = ?`,
    )
    .get(params.clientUuid, params.tenantId, params.authorId) as
    | { id: number; status: EditStatus }
    | undefined;
  if (byUuid) return { id: byUuid.id, status: byUuid.status };

  if (existing) {
    // RF-04: novo publish do mesmo autor/música substitui o pending anterior.
    db.prepare(
      `UPDATE custom_edits SET client_uuid = ?, lyrics = ?, timing = ?, updated_at_ms = ? WHERE id = ?`,
    ).run(
      params.clientUuid,
      params.lyrics ?? null,
      params.timing ?? null,
      now,
      existing.id,
    );
    return { id: existing.id, status: "published" };
  }

  const res = db
    .prepare(
      `INSERT INTO custom_edits (client_uuid, music_id, author_user_id, tenant_id, status, lyrics, timing, created_at, updated_at_ms)
       VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?)`,
    )
    .run(
      params.clientUuid,
      params.musicId,
      params.authorId,
      params.tenantId,
      params.lyrics ?? null,
      params.timing ?? null,
      nowIso,
      now,
    );
  return { id: Number(res.lastInsertRowid), status: "published" };
}

export function decideEdit(
  db: Database,
  params: {
    editId: number;
    gmId: number;
    tenantId: string;
    decision: "approved" | "rejected";
    reason?: string;
  },
): EditRow | null {
  if (params.decision === "rejected" && !params.reason?.trim()) {
    throw new Error("reject requires a public reason");
  }
  const nowIso = new Date().toISOString();
  const res = db
    .prepare(
      `UPDATE custom_edits SET status = ?, reason = ?, decided_by = ?, decided_at = ?, updated_at_ms = ?
       WHERE id = ? AND tenant_id = ? AND status = 'published'`,
    )
    .run(
      params.decision,
      params.reason ?? null,
      params.gmId,
      nowIso,
      Date.now(),
      params.editId,
      params.tenantId,
    );
  if (!res.changes) return null;
  return db
    .prepare(`SELECT * FROM custom_edits WHERE id = ?`)
    .get(params.editId) as EditRow;
}

/** RF-05: histórico auditável — registra decisão numa linha append-only derivada do próprio registro. */
export function editHistory(
  db: Database,
  editId: number,
): { status: string; at: string; by: number | null }[] {
  const row = db
    .prepare(`SELECT * FROM custom_edits WHERE id = ?`)
    .get(editId) as EditRow | undefined;
  if (!row) return [];
  const history: { status: string; at: string; by: number | null }[] = [
    { status: "published", at: row.created_at, by: row.author_user_id },
  ];
  if (row.status !== "published" && row.decided_at) {
    history.push({
      status: row.status,
      at: row.decided_at,
      by: row.decided_by,
    });
  }
  return history;
}

/** RF-08: edits aprovados aplicáveis por cima do catálogo oficial. */
export function appliedEdits(
  db: Database,
  tenantId: string,
  musicIds: number[],
): { musicId: number; lyrics: string | null; timing: string | null }[] {
  if (musicIds.length === 0) return [];
  const placeholders = musicIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT music_id, lyrics, timing FROM custom_edits
       WHERE tenant_id = ? AND status = 'approved' AND music_id IN (${placeholders})
       ORDER BY updated_at_ms DESC`,
    )
    .all(tenantId, ...musicIds) as {
    music_id: number;
    lyrics: string | null;
    timing: string | null;
  }[];
  // Um edit aplicado por música (o mais recente aprovado vence).
  const seen = new Set<number>();
  return rows
    .filter((r) =>
      seen.has(r.music_id) ? false : (seen.add(r.music_id), true),
    )
    .map((r) => ({ musicId: r.music_id, lyrics: r.lyrics, timing: r.timing }));
}
