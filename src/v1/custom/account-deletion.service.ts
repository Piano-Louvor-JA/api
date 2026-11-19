import type Database from "better-sqlite3";

/**
 * Exclusão de conta (App Store 5.1.1(v) / LGPD).
 *
 * Regras:
 * - apaga a conta, as sessões e os dados pessoais (pontos, medalhas,
 *   notificações, estado do operador, sugestões de edição);
 * - apaga as coletâneas privadas com músicas e letras;
 * - as coletâneas públicas ficam na comunidade, sem nome de autor, sob o
 *   usuário-sistema "Conta excluída" (migration 034). owner_id NULL não serve:
 *   NULL é coletânea legado, editável por qualquer um;
 * - referências de moderação (denúncias, decisões, promoções) também passam
 *   para "Conta excluída", para o histórico não apontar para um id inexistente.
 *
 * Tudo numa transação: ou apaga tudo, ou nada.
 */

export const DELETED_ACCOUNT_EMAIL = "conta-excluida@sistema.invalid";

/** Conta com senha local (pbkdf2). Contas só-Firebase não têm senha aqui. */
export function hasLocalPassword(passwordHash: string): boolean {
  return passwordHash.startsWith("pbkdf2$");
}

export function getDeletedAccountUserId(db: Database.Database): number {
  const row = db
    .prepare(`SELECT id_user FROM custom_users WHERE email = ?`)
    .get(DELETED_ACCOUNT_EMAIL) as { id_user: number } | undefined;
  if (row) return row.id_user;
  // A migration 034 cria o usuário; isto cobre bancos montados sem ela.
  const r = db
    .prepare(
      `INSERT INTO custom_users (email, password_hash, display_name) VALUES (?, 'disabled$deleted-account', 'Conta excluída')`,
    )
    .run(DELETED_ACCOUNT_EMAIL);
  return Number(r.lastInsertRowid);
}

export function deleteAccount(db: Database.Database, userId: number): void {
  const run = db.transaction(() => {
    const sentinel = getDeletedAccountUserId(db);
    if (userId === sentinel) {
      throw new Error("A conta-sistema não pode ser excluída");
    }

    // Coletâneas privadas dela: somem com músicas, letras e o que aponta para elas.
    const privateCollections = `SELECT id_collection FROM custom_collections WHERE owner_id = ? AND visibility <> 'public'`;
    const musicsInPrivate = `SELECT id_music FROM custom_musics WHERE id_collection IN (${privateCollections})`;
    db.prepare(
      `DELETE FROM official_promotions WHERE custom_music_id IN (${musicsInPrivate})`,
    ).run(userId);
    db.prepare(
      `DELETE FROM custom_lyrics WHERE id_music IN (${musicsInPrivate})`,
    ).run(userId);
    db.prepare(
      `DELETE FROM custom_musics WHERE id_collection IN (${privateCollections})`,
    ).run(userId);
    db.prepare(
      `DELETE FROM collection_reports WHERE collection_id IN (${privateCollections})`,
    ).run(userId);
    db.prepare(
      `DELETE FROM collection_uses WHERE collection_id IN (${privateCollections})`,
    ).run(userId);
    db.prepare(
      `DELETE FROM custom_collections WHERE owner_id = ? AND visibility <> 'public'`,
    ).run(userId);

    // Coletâneas públicas e músicas que sobram: passam para "Conta excluída".
    db.prepare(
      `UPDATE custom_collections SET owner_id = ?, author_name = NULL WHERE owner_id = ?`,
    ).run(sentinel, userId);
    db.prepare(`UPDATE custom_musics SET owner_id = ? WHERE owner_id = ?`).run(
      sentinel,
      userId,
    );

    // Histórico de moderação: mantém o registro, sem apontar para a pessoa.
    db.prepare(
      `UPDATE OR REPLACE collection_reports SET reporter_id = ? WHERE reporter_id = ?`,
    ).run(sentinel, userId);
    db.prepare(
      `UPDATE custom_edits SET decided_by = ? WHERE decided_by = ?`,
    ).run(sentinel, userId);
    db.prepare(
      `UPDATE official_promotions SET author_user_id = ? WHERE author_user_id = ?`,
    ).run(sentinel, userId);
    db.prepare(
      `UPDATE official_promotions SET promoted_by_user_id = ? WHERE promoted_by_user_id = ?`,
    ).run(sentinel, userId);

    // Dados pessoais.
    db.prepare(
      `DELETE FROM custom_user_blocks WHERE blocker_id = ? OR blocked_id = ?`,
    ).run(userId, userId);
    for (const [table, column] of [
      ["custom_edits", "author_user_id"],
      ["collection_uses", "user_id"],
      ["contrib_points", "user_id"],
      ["point_freeze", "user_id"],
      ["user_badges", "user_id"],
      ["weekly_task_completions", "user_id"],
      ["user_notifications", "user_id"],
      ["operator_state", "id_user"],
      ["custom_sessions", "id_user"],
    ] as const) {
      db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(userId);
    }

    db.prepare(`DELETE FROM custom_users WHERE id_user = ?`).run(userId);
  });
  run();
}
