import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, getDb, initDb } from "../../src/db/connection.js";
import {
  ANOMALY_MAX_PUBLISHES,
  checkAnomalyAndFreeze,
  creditPoints,
  evaluateBadges,
  getLevel,
  getRanking,
  getUserPosition,
  grantBadge,
  isFrozen,
  LEVELS,
  recordCollectionUse,
  unfreeze,
} from "../../src/v1/custom/ranking.service.js";

describe("ranking.service (F1..F3)", () => {
  let db: ReturnType<typeof getDb>;
  let userA: number; // dono da coletânea
  let userB: number; // quem usa
  let collectionA: number;

  beforeAll(async () => {
    process.env.DB_PATH = ":memory:";
    await initDb();
    db = getDb();

    const ins = db.prepare(
      `INSERT INTO custom_users (email, password_hash, display_name) VALUES (?, ?, ?)`,
    );
    userA = Number(ins.run("a@test.local", "x", "Alice").lastInsertRowid);
    userB = Number(ins.run("b@test.local", "x", "Bob").lastInsertRowid);
    // usuário SEM email no ranking (B8: nunca email, display name só)
    const col = db.prepare(
      `INSERT INTO custom_collections (name, owner_id, author_name, visibility) VALUES (?, ?, ?, 'public')`,
    );
    collectionA = Number(
      col.run("Coletânea da Alice", userA, "Alice").lastInsertRowid,
    );
  });
  afterAll(() => closeDb());

  describe("F1 — recordCollectionUse", () => {
    it("primeiro uso retorna true e credita use_received ao DONO (+5)", () => {
      const isNew = recordCollectionUse(db, userB, collectionA);
      expect(isNew).toBe(true);
      const pts = db
        .prepare(`SELECT user_id, points, reason FROM contrib_points`)
        .all();
      expect(pts).toEqual([
        { user_id: userA, points: 5, reason: "use_received" },
      ]);
    });

    it("segundo uso do mesmo user → false, sem ponto duplicado (anti-spam 1x)", () => {
      expect(recordCollectionUse(db, userB, collectionA)).toBe(false);
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM contrib_points`).get().n,
      ).toBe(1);
    });

    it("uso da própria coletânea não pontua", () => {
      const mine = Number(
        db
          .prepare(
            `INSERT INTO custom_collections (name, owner_id, visibility) VALUES ('Minha', ?, 'public')`,
          )
          .run(userB).lastInsertRowid,
      );
      expect(recordCollectionUse(db, userB, mine)).toBe(false);
    });

    it("coletânea privada não gera uso", () => {
      const priv = Number(
        db
          .prepare(
            `INSERT INTO custom_collections (name, owner_id, visibility) VALUES ('Privada', ?, 'private')`,
          )
          .run(userA).lastInsertRowid,
      );
      expect(recordCollectionUse(db, userB, priv)).toBe(false);
    });

    it("coletânea órfã (owner NULL = legado/oficial) não pontua (decisão #4)", () => {
      const orphan = Number(
        db
          .prepare(
            `INSERT INTO custom_collections (name, owner_id, visibility) VALUES ('Oficial', NULL, 'public')`,
          )
          .run().lastInsertRowid,
      );
      expect(recordCollectionUse(db, userB, orphan)).toBe(false);
    });
  });

  describe("F2 — creditPoints e freeze", () => {
    it("publish credita +10", () => {
      expect(creditPoints(db, userA, "publish", collectionA)).toBe(true);
      const last = db
        .prepare(`SELECT points FROM contrib_points ORDER BY id DESC LIMIT 1`)
        .get();
      expect(last.points).toBe(10);
    });

    it("usuário congelado não credita; unfreeze libera", () => {
      db.prepare(
        `INSERT INTO point_freeze (user_id, reason) VALUES (?, 'teste')`,
      ).run(userB);
      expect(isFrozen(db, userB)).toBe(true);
      expect(creditPoints(db, userB, "publish")).toBe(false);
      unfreeze(db, userB);
      expect(creditPoints(db, userB, "publish")).toBe(true);
    });

    it("rajada de publicações congela (anti-spam)", () => {
      const spamer = Number(ins().lastInsertRowid);
      function ins(): any {
        return db
          .prepare(
            `INSERT INTO custom_users (email, password_hash, display_name) VALUES ('s@test.local', 'x', 'Spammer')`,
          )
          .run();
      }
      void spamer;
      const spammer = Number(
        db
          .prepare(
            `INSERT INTO custom_users (email, password_hash, display_name) VALUES ('s2@test.local', 'x', 'Spammer2')`,
          )
          .run().lastInsertRowid,
      );
      for (let i = 0; i <= ANOMALY_MAX_PUBLISHES; i++) {
        creditPoints(db, spammer, "publish", i);
      }
      expect(checkAnomalyAndFreeze(db, spammer)).toBe(true);
      expect(isFrozen(db, spammer)).toBe(true);
      // pontuar mais não adiciona nada
      const before = db
        .prepare(`SELECT COUNT(*) AS n FROM contrib_points WHERE user_id = ?`)
        .get(spammer).n;
      expect(creditPoints(db, spammer, "publish")).toBe(false);
      const after = db
        .prepare(`SELECT COUNT(*) AS n FROM contrib_points WHERE user_id = ?`)
        .get(spammer).n;
      expect(after).toBe(before);
    });
  });

  describe("F2 — getRanking", () => {
    it("ranking global ordena por total DESC, desempate por ponto mais antigo", () => {
      const ranking = getRanking(db, "all");
      // Alice: 5 (use_received) + 10 (publish) = 15; Bob: 10 (publish pós-unfreeze)
      expect(ranking.length).toBeGreaterThanOrEqual(2);
      expect(ranking[0].display_name).toBe("Alice");
      expect(ranking[0].total).toBe(15);
      // display_name nunca email (B8)
      for (const row of ranking) {
        expect(row.display_name).not.toContain("@");
      }
    });

    it("congelados não aparecem no ranking", () => {
      const frozenUser = Number(
        db
          .prepare(
            `INSERT INTO custom_users (email, password_hash, display_name) VALUES ('f@test.local', 'x', 'Frozen')`,
          )
          .run().lastInsertRowid,
      );
      creditPoints(db, frozenUser, "publish");
      db.prepare(
        `INSERT INTO point_freeze (user_id, reason) VALUES (?, 'mod')`,
      ).run(frozenUser);
      const ranking = getRanking(db, "all");
      expect(ranking.find((r) => r.user_id === frozenUser)).toBeUndefined();
    });

    it("getUserPosition retorna posição e total do usuário", () => {
      const pos = getUserPosition(db, userA, "all");
      expect(pos).not.toBeNull();
      expect(pos?.total).toBe(15);
      expect(pos?.position).toBe(1);
      expect(getUserPosition(db, 999999, "all")).toBeNull();
    });
  });

  describe("F3 — badges e níveis", () => {
    it("evaluateBadges: 1a publica concede first_public (idempotente)", () => {
      const granted = evaluateBadges(db, userA);
      expect(granted).toContain("first_public");
      expect(evaluateBadges(db, userA)).not.toContain("first_public");
    });

    it("badge concedida 1x (idempotente)", () => {
      expect(grantBadge(db, userB, "first_public")).toBe(true);
      expect(grantBadge(db, userB, "first_public")).toBe(false);
    });

    it("níveis: nomes neutros e thresholds 0/50/150/400/1000", () => {
      expect(getLevel(0)).toEqual({
        level: 1,
        name: "Iniciante",
        min: 0,
        next: 50,
      });
      expect(getLevel(50).name).toBe("Colaborador");
      expect(getLevel(150).name).toBe("Veterano");
      expect(getLevel(400).name).toBe("Mestre");
      expect(getLevel(1000)).toEqual({
        level: 5,
        name: "Lenda",
        min: 1000,
        next: null,
      });
      expect(LEVELS).toHaveLength(5);
    });
  });
});
