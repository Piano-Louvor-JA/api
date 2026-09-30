import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, getDb, initDb } from "../../src/db/connection.js";
import {
  getActiveSeasonalMultiplier,
  listUnreadNotifications,
  PROMOTION_BADGE,
  PROMOTION_POINTS,
  promoteMusicToF,
} from "../../src/v1/custom/promotion.service.js";
import { getLevel } from "../../src/v1/custom/ranking.service.js";

describe("promotion.service (F6)", () => {
  let db: ReturnType<typeof getDb>;
  let author: number;
  let curator: number;
  let customMusicId: number;
  let officialMusicId: number;
  const emails: Array<{ to: string; subject: string }> = [];

  beforeAll(async () => {
    process.env.DB_PATH = ":memory:";
    await initDb();
    db = getDb();

    author = Number(
      db
        .prepare(
          `INSERT INTO custom_users (email, password_hash, display_name) VALUES ('autor@f6.local', 'x', 'Autor')`,
        )
        .run().lastInsertRowid,
    );
    curator = Number(
      db
        .prepare(
          `INSERT INTO custom_users (email, password_hash, display_name) VALUES ('curador@f6.local', 'x', 'Curador')`,
        )
        .run().lastInsertRowid,
    );

    const col = db.prepare(
      `INSERT INTO custom_collections (name, owner_id, visibility) VALUES ('Coletânea F6', ?, 'public')`,
    );
    const collectionId = Number(col.run(author).lastInsertRowid);
    customMusicId = Number(
      db
        .prepare(
          `INSERT INTO custom_musics (id_collection, name, owner_id) VALUES (?, 'Minha Música', ?)`,
        )
        .run(collectionId, author).lastInsertRowid,
    );
    officialMusicId = 7777;
  });
  afterAll(() => closeDb());

  it("sem evento sazonal ativo: multiplicador = 1", () => {
    expect(getActiveSeasonalMultiplier(db)).toBe(1);
  });

  it("promoção registra crédito, credita +50, concede badge e notifica", () => {
    const result = promoteMusicToF(
      db,
      customMusicId,
      officialMusicId,
      curator,
      (to, subject) => emails.push({ to, subject }),
    );

    expect(result.ok).toBe(true);
    expect(result.awardedTo).toBe(author);
    expect(result.points).toBe(PROMOTION_POINTS);

    // crédito permanente registrado
    const promo = db
      .prepare(
        `SELECT author_user_id, official_music_id, points_awarded FROM official_promotions`,
      )
      .get() as any;
    expect(promo.author_user_id).toBe(author);
    expect(promo.official_music_id).toBe(officialMusicId);
    expect(promo.points_awarded).toBe(PROMOTION_POINTS);

    // faixa linkada ao hino oficial
    const linked = db
      .prepare(`SELECT official_music_id FROM custom_musics WHERE id_music = ?`)
      .get(customMusicId) as any;
    expect(linked.official_music_id).toBe(officialMusicId);

    // badge concedida
    expect(
      db
        .prepare(`SELECT 1 FROM user_badges WHERE user_id = ? AND badge = ?`)
        .get(author, PROMOTION_BADGE),
    ).toBeTruthy();

    // notificação gravada com e-mail marcado como enviado
    const notif = listUnreadNotifications(db, author);
    expect(notif.some((n) => n.type === "music_promoted")).toBe(true);
    expect(emails.some((e) => e.to === "autor@f6.local")).toBe(true);
  });

  it("re-promover a mesma faixa falha; hino oficial duplicado falha", () => {
    const again = promoteMusicToF(db, customMusicId, 8888, curator, () => {});
    expect(again.ok).toBe(false);
    expect(again.error).toContain("já promovida");

    const dup = promoteMusicToF(db, 999999, officialMusicId, curator, () => {});
    expect(dup.ok).toBe(false);
  });

  it("evento sazonal 2x dobra os pontos da promoção", () => {
    // cria evento ativo 2x
    db.prepare(
      `INSERT INTO seasonal_events (name, multiplier, starts_at, ends_at, active)
       VALUES ('SDA Hymnal Season', 2.0, datetime('now', '-1 day'), datetime('now', '+1 day'), 1)`,
    ).run();
    expect(getActiveSeasonalMultiplier(db)).toBe(2);

    // nova faixa + promoção
    const col = db
      .prepare(
        `INSERT INTO custom_collections (name, owner_id, visibility) VALUES ('F6 Sazonal', ?, 'public')`,
      )
      .run(author);
    const colId = Number(col.lastInsertRowid);
    const music2 = Number(
      db
        .prepare(
          `INSERT INTO custom_musics (id_collection, name, owner_id) VALUES (?, 'Música 2', ?)`,
        )
        .run(colId, author).lastInsertRowid,
    );

    const result = promoteMusicToF(db, music2, 7778, curator, () => {});
    expect(result.ok).toBe(true);
    expect(result.points).toBe(PROMOTION_POINTS * 2); // 100
  });

  it("níveis F3 disponíveis (import compartilhado)", () => {
    expect(getLevel(0).name).toBe("Iniciante");
  });
});
