import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");
const { DELETED_ACCOUNT_EMAIL } = await import(
  "../../src/v1/custom/account-deletion.service.js"
);

/**
 * Exclusão de conta (App Store 5.1.1(v) / LGPD): DELETE /v1/custom/auth/me.
 * - pede a senha nas contas com senha local;
 * - apaga sessões, dados pessoais e conteúdo privado;
 * - coletâneas públicas ficam na comunidade, sem autor, sob o usuário-sistema
 *   "Conta excluída" (ninguém edita: owner_id NULL seria "editável por todos").
 */
describe("DELETE /v1/custom/auth/me — exclusão de conta", () => {
  let app: SeededDb;
  let router: any;
  const PASS = "SenhaForte1!";
  let seq = 0;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    delete process.env.SMTP_HOST;
  });

  afterAll(() => app.cleanup());

  let alice: { id_user: number; token: string };
  let bob: { id_user: number; token: string };

  beforeEach(() => {
    seq += 1;
    alice = registerUser(`alice${seq}@test.local`, PASS);
    bob = registerUser(`bob${seq}@test.local`, PASS);
  });

  function del(token: string | null, body?: unknown) {
    return router.request("/v1/custom/auth/me", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function sentinelId(): number {
    const row = app
      .getDb()
      .prepare(`SELECT id_user FROM custom_users WHERE email = ?`)
      .get(DELETED_ACCOUNT_EMAIL) as { id_user: number } | undefined;
    expect(row).toBeDefined();
    return (row as { id_user: number }).id_user;
  }

  function insertCollection(
    owner: number,
    visibility: "public" | "private",
  ): number {
    const r = app
      .getDb()
      .prepare(
        `INSERT INTO custom_collections (name, owner_id, author_name, visibility) VALUES (?, ?, ?, ?)`,
      )
      .run(`Hinos ${visibility} ${seq}`, owner, "Alice", visibility);
    return Number(r.lastInsertRowid);
  }

  function insertMusic(collection: number, owner: number): number {
    const db = app.getDb();
    const r = db
      .prepare(
        `INSERT INTO custom_musics (id_collection, name, owner_id) VALUES (?, ?, ?)`,
      )
      .run(collection, `Música ${seq}`, owner);
    const id = Number(r.lastInsertRowid);
    db.prepare(`INSERT INTO custom_lyrics (id_music, lyric) VALUES (?, ?)`).run(
      id,
      "Santo, santo, santo",
    );
    return id;
  }

  function count(sql: string, ...params: unknown[]): number {
    const row = app
      .getDb()
      .prepare(sql)
      .get(...params) as { n: number };
    return row.n;
  }

  it("sem token → 401", async () => {
    const res = await del(null, { password: PASS });
    expect(res.status).toBe(401);
  });

  it("conta com senha: sem senha → 400 e nada é apagado", async () => {
    const res = await del(alice.token, {});
    expect(res.status).toBe(400);
    expect(
      count(
        `SELECT COUNT(*) n FROM custom_users WHERE id_user = ?`,
        alice.id_user,
      ),
    ).toBe(1);
  });

  it("senha errada → 403 e nada é apagado", async () => {
    const res = await del(alice.token, { password: "Errada123!" });
    expect(res.status).toBe(403);
    expect(
      count(
        `SELECT COUNT(*) n FROM custom_users WHERE id_user = ?`,
        alice.id_user,
      ),
    ).toBe(1);
    expect(
      count(
        `SELECT COUNT(*) n FROM custom_sessions WHERE id_user = ?`,
        alice.id_user,
      ),
    ).toBe(1);
  });

  it("senha certa → 204; conta, sessões e dados pessoais somem", async () => {
    const db = app.getDb();
    const pub = insertCollection(alice.id_user, "public");
    db.prepare(
      `INSERT INTO collection_uses (user_id, collection_id) VALUES (?, ?)`,
    ).run(alice.id_user, pub);
    db.prepare(
      `INSERT INTO contrib_points (user_id, points, reason) VALUES (?, 10, 'publish')`,
    ).run(alice.id_user);
    db.prepare(
      `INSERT INTO point_freeze (user_id, reason) VALUES (?, 'teste')`,
    ).run(alice.id_user);
    db.prepare(
      `INSERT INTO user_badges (user_id, badge) VALUES (?, 'pioneiro')`,
    ).run(alice.id_user);
    db.prepare(
      `INSERT INTO weekly_task_completions (user_id, week_key, task_id, bonus) VALUES (?, '2026-W47', 't1', 5)`,
    ).run(alice.id_user);
    db.prepare(
      `INSERT INTO user_notifications (user_id, type, title, body) VALUES (?, 'badge_granted', 't', 'b')`,
    ).run(alice.id_user);
    db.prepare(
      `INSERT INTO operator_state (id_user, namespace, key, value_json, client_uuid, updated_at_ms) VALUES (?, 'ui', 'k', '{}', 'u1', 1)`,
    ).run(alice.id_user);
    db.prepare(
      `INSERT INTO custom_edits (client_uuid, music_id, author_user_id, created_at, updated_at_ms) VALUES ('e1', 1, ?, datetime('now'), 1)`,
    ).run(alice.id_user);

    const res = await del(alice.token, { password: PASS });
    expect(res.status).toBe(204);

    const id = alice.id_user;
    expect(
      count(`SELECT COUNT(*) n FROM custom_users WHERE id_user = ?`, id),
    ).toBe(0);
    for (const [table, col] of [
      ["custom_sessions", "id_user"],
      ["collection_uses", "user_id"],
      ["contrib_points", "user_id"],
      ["point_freeze", "user_id"],
      ["user_badges", "user_id"],
      ["weekly_task_completions", "user_id"],
      ["user_notifications", "user_id"],
      ["operator_state", "id_user"],
      ["custom_edits", "author_user_id"],
    ]) {
      expect(
        count(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = ?`, id),
        table,
      ).toBe(0);
    }

    // a sessão antiga não vale mais
    const me = await router.request("/v1/custom/auth/me", {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(me.status).toBe(401);

    // e o login com a senha antiga falha
    const login = await router.request("/v1/custom/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `alice${seq}@test.local`, password: PASS }),
    });
    expect(login.status).toBe(401);
  });

  it("coletânea privada é apagada com músicas e letras", async () => {
    const priv = insertCollection(alice.id_user, "private");
    const music = insertMusic(priv, alice.id_user);
    app
      .getDb()
      .prepare(
        `INSERT INTO collection_reports (collection_id, reporter_id, reason) VALUES (?, ?, 'x')`,
      )
      .run(priv, bob.id_user);

    const res = await del(alice.token, { password: PASS });
    expect(res.status).toBe(204);

    expect(
      count(
        `SELECT COUNT(*) n FROM custom_collections WHERE id_collection = ?`,
        priv,
      ),
    ).toBe(0);
    expect(
      count(`SELECT COUNT(*) n FROM custom_musics WHERE id_music = ?`, music),
    ).toBe(0);
    expect(
      count(`SELECT COUNT(*) n FROM custom_lyrics WHERE id_music = ?`, music),
    ).toBe(0);
    expect(
      count(
        `SELECT COUNT(*) n FROM collection_reports WHERE collection_id = ?`,
        priv,
      ),
    ).toBe(0);
  });

  it("coletânea pública fica, sem autor, sob 'Conta excluída' e ninguém edita", async () => {
    const pub = insertCollection(alice.id_user, "public");
    const music = insertMusic(pub, alice.id_user);

    const res = await del(alice.token, { password: PASS });
    expect(res.status).toBe(204);

    const sentinel = sentinelId();
    const row = app
      .getDb()
      .prepare(
        `SELECT owner_id, author_name FROM custom_collections WHERE id_collection = ?`,
      )
      .get(pub) as { owner_id: number; author_name: string | null };
    expect(row.owner_id).toBe(sentinel);
    expect(row.author_name).toBeNull();
    expect(
      count(
        `SELECT COUNT(*) n FROM custom_musics WHERE id_music = ? AND owner_id = ?`,
        music,
        sentinel,
      ),
    ).toBe(1);

    const edit = await router.request(`/v1/custom/collections/${pub}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(edit.status).toBe(403);
  });

  it("música dela em coletânea pública de outro passa para 'Conta excluída'", async () => {
    const bobs = insertCollection(bob.id_user, "public");
    const music = insertMusic(bobs, alice.id_user);

    const res = await del(alice.token, { password: PASS });
    expect(res.status).toBe(204);

    expect(
      count(
        `SELECT COUNT(*) n FROM custom_musics WHERE id_music = ? AND owner_id = ?`,
        music,
        sentinelId(),
      ),
    ).toBe(1);
  });

  it("referências de moderação passam para 'Conta excluída'", async () => {
    const db = app.getDb();
    const bobs = insertCollection(bob.id_user, "public");
    db.prepare(
      `INSERT INTO collection_reports (collection_id, reporter_id, reason) VALUES (?, ?, 'x')`,
    ).run(bobs, alice.id_user);
    const edit = db
      .prepare(
        `INSERT INTO custom_edits (client_uuid, music_id, author_user_id, decided_by, created_at, updated_at_ms) VALUES ('e2', 2, ?, ?, datetime('now'), 1)`,
      )
      .run(bob.id_user, alice.id_user);

    const res = await del(alice.token, { password: PASS });
    expect(res.status).toBe(204);

    const sentinel = sentinelId();
    expect(
      count(
        `SELECT COUNT(*) n FROM collection_reports WHERE collection_id = ? AND reporter_id = ?`,
        bobs,
        sentinel,
      ),
    ).toBe(1);
    expect(
      count(
        `SELECT COUNT(*) n FROM custom_edits WHERE id = ? AND decided_by = ?`,
        Number(edit.lastInsertRowid),
        sentinel,
      ),
    ).toBe(1);
  });

  it("conta só com Firebase (sem senha local) exclui sem senha", async () => {
    const db = app.getDb();
    db.prepare(
      `UPDATE custom_users SET password_hash = 'firebase$no-local-password', firebase_uid = ? WHERE id_user = ?`,
    ).run(`uid-${seq}`, alice.id_user);

    const res = await del(alice.token, {});
    expect(res.status).toBe(204);
    expect(
      count(
        `SELECT COUNT(*) n FROM custom_users WHERE id_user = ?`,
        alice.id_user,
      ),
    ).toBe(0);
  });

  it("o usuário-sistema 'Conta excluída' não faz login", async () => {
    sentinelId();
    const res = await router.request("/v1/custom/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: DELETED_ACCOUNT_EMAIL, password: PASS }),
    });
    expect(res.status).toBe(401);
  });

  it("com foreign_keys ON (produção) não deixa referência quebrada", async () => {
    const db = app.getDb();
    db.pragma("foreign_keys = ON");
    try {
      const priv = insertCollection(alice.id_user, "private");
      const pub = insertCollection(alice.id_user, "public");
      const bobs = insertCollection(bob.id_user, "public");
      const privMusic = insertMusic(priv, alice.id_user);
      insertMusic(pub, alice.id_user);
      insertMusic(bobs, alice.id_user);
      db.prepare(
        `INSERT INTO collection_uses (user_id, collection_id) VALUES (?, ?)`,
      ).run(bob.id_user, priv);
      db.prepare(
        `INSERT INTO collection_reports (collection_id, reporter_id, reason) VALUES (?, ?, 'x')`,
      ).run(bobs, alice.id_user);
      db.prepare(
        `INSERT INTO official_promotions (custom_music_id, official_music_id, author_user_id) VALUES (?, ?, ?)`,
      ).run(privMusic, 900000 + seq, alice.id_user);
      db.prepare(
        `INSERT INTO contrib_points (user_id, points, reason) VALUES (?, 10, 'publish')`,
      ).run(alice.id_user);

      const res = await del(alice.token, { password: PASS });
      expect(res.status).toBe(204);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.pragma("foreign_keys = OFF");
    }
  });

  it("não mexe nos dados de outro usuário", async () => {
    const bobs = insertCollection(bob.id_user, "private");
    const res = await del(alice.token, { password: PASS });
    expect(res.status).toBe(204);
    expect(
      count(
        `SELECT COUNT(*) n FROM custom_collections WHERE id_collection = ? AND owner_id = ?`,
        bobs,
        bob.id_user,
      ),
    ).toBe(1);
    expect(
      count(
        `SELECT COUNT(*) n FROM custom_sessions WHERE id_user = ?`,
        bob.id_user,
      ),
    ).toBe(1);
  });
});
