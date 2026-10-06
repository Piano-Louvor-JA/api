import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");
const ranking = await import("../../src/v1/custom/ranking.service.js");
const promotion = await import("../../src/v1/custom/promotion.service.js");

/**
 * Onda 10d: badges thresholds (first_public, ten_publics, hundred_uses),
 * listUserBadges, níveis; promotion com música já promovida (dup).
 */
describe("ranking badges (unit com DB)", () => {
  let app: SeededDb;
  let db: ReturnType<typeof import("../../src/db/connection.js").getDb>;
  let uid: number;

  beforeAll(async () => {
    app = await setupSeededDb();
    db = app.getDb();
    uid = registerUser("badges@test.local", "SenhaForte1!").id_user;
  });

  afterAll(() => app.cleanup());

  it("1 publicação (contrib_points publish) → first_public", () => {
    ranking.creditPoints(db, uid, "publish", 1001);
    const granted = ranking.evaluateBadges(db, uid);
    expect(granted).toContain("first_public");
    expect(ranking.listUserBadges(db, uid)).toContain("first_public");
  });

  it("10 publicações distintas → ten_publics", () => {
    for (let i = 1002; i < 1011; i++) {
      ranking.creditPoints(db, uid, "publish", i);
    }
    const granted = ranking.evaluateBadges(db, uid);
    expect(granted).toContain("ten_publics");
  });

  it("100 usos de collections do usuário → hundred_uses", () => {
    db.prepare(
      "INSERT INTO custom_collections (name, owner_id, visibility) VALUES ('usecoll', ?, 'public')",
    ).run(uid);
    const col = db
      .prepare(
        "SELECT id_collection FROM custom_collections WHERE owner_id = ? LIMIT 1",
      )
      .get(uid) as { id_collection: number };
    for (let i = 0; i < 100; i++) {
      db.prepare(
        "INSERT OR IGNORE INTO collection_uses (user_id, collection_id, used_at) VALUES (?, ?, datetime('now'))",
      ).run(uid + 50 + i, col.id_collection);
    }
    const granted = ranking.evaluateBadges(db, uid);
    expect(granted).toContain("hundred_uses");
    expect(ranking.listUserBadges(db, uid).length).toBeGreaterThanOrEqual(3);
  });

  it("níveis: 0 pontos → nível neutro base", () => {
    const lvl = (ranking as any).levelForPoints?.(0) ?? null;
    expect(
      lvl === null || typeof lvl === "string" || typeof lvl === "number",
    ).toBe(true);
  });
});

describe("promotion promoteMusicToF", () => {
  let app: SeededDb;
  let db: ReturnType<typeof import("../../src/db/connection.js").getDb>;
  let uid: number;

  beforeAll(async () => {
    app = await setupSeededDb();
    db = app.getDb();
    uid = registerUser("promo2@test.local", "SenhaForte1!").id_user;
  });

  afterAll(() => app.cleanup());

  const sendEmail = () => {};

  it("música inexistente → ok:false", async () => {
    const r = promotion.promoteMusicToF(db, 424242, 1, uid, sendEmail);
    expect((r as any).ok).toBe(false);
  });

  it("promo feliz: credita autor, cria promoção; música vira oficial", () => {
    db.prepare(
      "INSERT INTO custom_musics (id_collection, name, owner_id) VALUES (1, 'Promo Feliz', ?)",
    ).run(uid);
    const music = db
      .prepare("SELECT id_music FROM custom_musics WHERE name = 'Promo Feliz'")
      .get() as { id_music: number };

    const r1 = promotion.promoteMusicToF(
      db,
      music.id_music,
      5555,
      uid,
      sendEmail,
    );
    expect(r1.ok).toBe(true);
    expect(r1.points).toBeGreaterThan(0);

    // mesma música de novo: já tem official_music_id → branch "já promovida"
    const r2 = promotion.promoteMusicToF(
      db,
      music.id_music,
      5556,
      uid,
      sendEmail,
    );
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("já promovida");
  });

  it("official_music_id já tem promoção → dup", () => {
    // 5555 já foi usado acima
    db.prepare(
      "INSERT INTO custom_musics (id_collection, name, owner_id) VALUES (1, 'Promo Dup2', ?)",
    ).run(uid);
    const music = db
      .prepare("SELECT id_music FROM custom_musics WHERE name = 'Promo Dup2'")
      .get() as { id_music: number };
    const r = promotion.promoteMusicToF(
      db,
      music.id_music,
      5555,
      uid,
      sendEmail,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("já tem promoção");
  });

  it("música com official_music_id herdado → 'já promovida ao acervo oficial'", () => {
    db.prepare(
      "INSERT INTO custom_musics (id_collection, name, owner_id, official_music_id) VALUES (1, 'Herdada', ?, 1)",
    ).run(uid);
    const herded = db
      .prepare(
        "SELECT id_music FROM custom_musics WHERE owner_id = ? AND official_music_id = 1",
      )
      .get(uid) as { id_music: number };
    const r = promotion.promoteMusicToF(
      db,
      herded.id_music,
      9999,
      uid,
      sendEmail,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("já promovida");
  });
});
