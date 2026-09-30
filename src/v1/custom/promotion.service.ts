/**
 * F6 — Promoção ao acervo oficial + créditos + eventos sazonais + notificações.
 *
 * - Promoção: curador promove faixa custom → oficial (+50, badge "Autor
 *   Oficial", crédito permanente em official_promotions).
 * - Eventos sazonais: multiplicador aplicado no creditPoints (ex. SDA Hymnal 2x).
 * - Notificações: gravadas em user_notifications + e-mail (mail.service).
 */

import type { DbLike } from "./ranking.service.js";
import { creditPoints, grantBadge } from "./ranking.service.js";

export const PROMOTION_POINTS = 50;
export const PROMOTION_BADGE = "autor_oficial";

export type SeasonalEvent = {
  id: number;
  name: string;
  description: string | null;
  multiplier: number;
  starts_at: string;
  ends_at: string;
};

/** Evento sazonal ativo agora (multiplicador 1 = sem evento). */
export function getActiveSeasonalMultiplier(db: DbLike): number {
  const row = db
    .prepare(
      `SELECT multiplier FROM seasonal_events
       WHERE active = 1 AND datetime('now') BETWEEN starts_at AND ends_at
       ORDER BY multiplier DESC LIMIT 1`,
    )
    .get() as { multiplier: number } | undefined;
  return row?.multiplier ?? 1;
}

/**
 * Credita pontos com multiplicador sazonal aplicado (arredondado p/ cima).
 */
export function creditPointsSeasonal(
  db: DbLike,
  userId: number,
  reason: Parameters<typeof creditPoints>[2],
  refId?: number,
): boolean {
  const multiplier = getActiveSeasonalMultiplier(db);
  return creditPoints(db, userId, reason, refId, multiplier);
}

/**
 * Promove faixa custom ao acervo oficial (ação do curador).
 * - registra em official_promotions (UNIQUE official_music_id = 1 promoção por hino)
 * - credita +50 (com multiplicador sazonal) ao autor, se identificado
 * - concede badge "Autor Oficial"
 * - grava notificação + dispara e-mail
 */
export function promoteMusicToF(
  db: DbLike,
  customMusicId: number,
  officialMusicId: number,
  promotedByUserId: number,
  sendEmail: (to: string, subject: string, body: string) => void,
): { ok: boolean; error?: string; awardedTo?: number; points?: number } {
  const music = db
    .prepare(
      `SELECT id_music, name, owner_id, official_music_id FROM custom_musics WHERE id_music = ?`,
    )
    .get(customMusicId) as
    | {
        id_music: number;
        name: string;
        owner_id: number | null;
        official_music_id: number | null;
      }
    | undefined;

  if (!music) return { ok: false, error: "Faixa custom não encontrada" };
  if (music.official_music_id != null) {
    return { ok: false, error: "Faixa já promovida ao acervo oficial" };
  }

  const dup = db
    .prepare(`SELECT 1 FROM official_promotions WHERE official_music_id = ?`)
    .get(officialMusicId);
  if (dup)
    return { ok: false, error: "Hino oficial já tem promoção registrada" };

  const multiplier = getActiveSeasonalMultiplier(db);
  const points = Math.ceil(PROMOTION_POINTS * multiplier);
  const author = music.owner_id;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE custom_musics SET official_music_id = ? WHERE id_music = ?`,
    ).run(officialMusicId, customMusicId);
    db.prepare(
      `INSERT INTO official_promotions
         (custom_music_id, official_music_id, author_user_id, promoted_by_user_id, points_awarded)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      customMusicId,
      officialMusicId,
      author ?? null,
      promotedByUserId,
      author != null ? points : 0,
    );

    if (author != null) {
      creditPoints(
        db,
        author,
        "weekly_task",
        officialMusicId,
        multiplier,
        points,
      );
      grantBadge(db, author, PROMOTION_BADGE);
    }
  });
  tx();

  if (author != null) {
    const email = db
      .prepare(`SELECT email FROM custom_users WHERE id_user = ?`)
      .get(author) as { email: string } | undefined;
    const emailTo = email?.email ?? null;
    notify(
      db,
      author,
      "music_promoted",
      "Sua música foi promovida ao acervo oficial!",
      `"${music.name}" agora faz parte do acervo oficial do PIANO. Você recebeu ${points} pontos e o crédito de autoria é permanente.`,
      emailTo,
      sendEmail,
    );
  }

  return { ok: true, awardedTo: author ?? undefined, points };
}

/** Grava notificação + envia e-mail (best-effort; e-mail falha = log, não lança). */
export function notify(
  db: DbLike,
  userId: number,
  type:
    | "collection_published"
    | "curation_approved"
    | "curation_rejected"
    | "music_promoted"
    | "badge_granted",
  title: string,
  body: string,
  emailTo: string | null,
  sendEmail: (to: string, subject: string, body: string) => void,
): void {
  db.prepare(
    `INSERT INTO user_notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)`,
  ).run(userId, type, title, body);

  if (emailTo) {
    try {
      sendEmail(emailTo, `[PIANO] ${title}`, body);
      db.prepare(
        `UPDATE user_notifications SET email_sent = 1
         WHERE id = (SELECT id FROM user_notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1)`,
      ).run(userId);
    } catch {
      // e-mail é best-effort: notificação in-app já registrada
    }
  }
}

/** Notificações não lidas do usuário. */
export function listUnreadNotifications(
  db: DbLike,
  userId: number,
): Array<{
  id: number;
  type: string;
  title: string;
  body: string;
  created_at: string;
}> {
  return db
    .prepare(
      `SELECT id, type, title, body, created_at FROM user_notifications
       WHERE user_id = ? AND read_at IS NULL ORDER BY id DESC LIMIT 50`,
    )
    .all(userId) as Array<{
    id: number;
    type: string;
    title: string;
    body: string;
    created_at: string;
  }>;
}

/** Marca todas as notificações como lidas. */
export function markAllRead(db: DbLike, userId: number): void {
  db.prepare(
    `UPDATE user_notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL`,
  ).run(userId);
}
