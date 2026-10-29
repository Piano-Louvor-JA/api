import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashToken } from "../../src/v1/custom/auth.service.js";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

describe("community multitenant read scope", () => {
  let app: SeededDb;

  beforeAll(async () => {
    app = await setupSeededDb();
    const db = app.getDb();
    db.prepare(
      `INSERT INTO custom_users (email, password_hash, display_name, tenant_id)
       VALUES (?, ?, ?, ?)`,
    ).run("piano@tenant.local", "x", "Piano User", "piano");
    db.prepare(
      `INSERT INTO custom_users (email, password_hash, display_name, tenant_id)
       VALUES (?, ?, ?, ?)`,
    ).run("violin@tenant.local", "x", "Violin User", "violin");
    db.prepare(
      `INSERT INTO custom_users (email, password_hash, display_name, tenant_id)
       VALUES (?, ?, ?, ?)`,
    ).run("piano-reader@tenant.local", "x", "Piano Reader", "piano");

    const pianoUser = db
      .prepare(`SELECT id_user FROM custom_users WHERE email = ?`)
      .get("piano@tenant.local") as { id_user: number };
    const violinUser = db
      .prepare(`SELECT id_user FROM custom_users WHERE email = ?`)
      .get("violin@tenant.local") as { id_user: number };

    db.prepare(
      `INSERT INTO custom_collections (name, owner_id, visibility, tenant_id)
       VALUES (?, ?, 'public', ?)`,
    ).run("Piano Collection", pianoUser.id_user, "piano");
    db.prepare(
      `INSERT INTO custom_collections (name, owner_id, visibility, tenant_id)
       VALUES (?, ?, 'public', ?)`,
    ).run("Violin Collection", violinUser.id_user, "violin");
    db.prepare(
      `INSERT INTO contrib_points (user_id, points, reason) VALUES (?, 10, 'publish')`,
    ).run(pianoUser.id_user);
    db.prepare(
      `INSERT INTO contrib_points (user_id, points, reason) VALUES (?, 20, 'publish')`,
    ).run(violinUser.id_user);
    db.prepare(
      `INSERT INTO seasonal_events (name, multiplier, starts_at, ends_at, active, tenant_id)
       VALUES (?, 2, datetime('now', '-1 day'), datetime('now', '+1 day'), 1, ?)`,
    ).run("Violin season", "violin");
  });

  afterAll(() => app.cleanup());

  it("AC-1: Piano cannot read Violin catalog data", async () => {
    const response = await app.router.request("/v1/custom/collections");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.data.map((collection: { name: string }) => collection.name),
    ).toContain("Piano Collection");
    expect(
      body.data.map((collection: { name: string }) => collection.name),
    ).not.toContain("Violin Collection");
  });

  it("returns 404 when another tenant requests a collection's musics", async () => {
    const violinCollection = app
      .getDb()
      .prepare(`SELECT id_collection FROM custom_collections WHERE name = ?`)
      .get("Violin Collection") as { id_collection: number };

    const response = await app.router.request(
      `/v1/custom/collections/${violinCollection.id_collection}/musics`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Coletânea não encontrada" });
  });

  it("returns indistinguishable 404s for another tenant's music and lyrics", async () => {
    const db = app.getDb();
    const violinCollection = db
      .prepare(`SELECT id_collection FROM custom_collections WHERE name = ?`)
      .get("Violin Collection") as { id_collection: number };
    const musicId = Number(
      db
        .prepare(
          `INSERT INTO custom_musics (id_collection, name) VALUES (?, ?)`,
        )
        .run(violinCollection.id_collection, "Violin Music").lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO custom_lyrics (id_music, lyric, "order") VALUES (?, ?, 1)`,
    ).run(musicId, "Violin lyric");

    const music = await app.router.request(`/v1/custom/musics/${musicId}`);
    const lyrics = await app.router.request(`/v1/custom/musics/${musicId}/lyrics`);
    const missingMusic = await app.router.request("/v1/custom/musics/999999");
    const missingLyrics = await app.router.request(
      "/v1/custom/musics/999999/lyrics",
    );

    expect(music.status).toBe(404);
    expect(lyrics.status).toBe(404);
    expect(await music.json()).toEqual(await missingMusic.json());
    expect(await lyrics.json()).toEqual(await missingLyrics.json());
  });

  it("returns 404 when another tenant uses a collection and keeps piano ranking intact", async () => {
    const db = app.getDb();
    const violinCollection = db
      .prepare(`SELECT id_collection FROM custom_collections WHERE name = ?`)
      .get("Violin Collection") as { id_collection: number };
    const pianoReader = db
      .prepare(`SELECT id_user FROM custom_users WHERE email = ?`)
      .get("piano-reader@tenant.local") as { id_user: number };
    const token = "piano-reader-token";
    db.prepare(`INSERT INTO custom_sessions (token_hash, id_user) VALUES (?, ?)`)
      .run(hashToken(token), pianoReader.id_user);

    const response = await app.router.request(
      `/v1/custom/collections/${violinCollection.id_collection}/use`,
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(404);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM contrib_points WHERE reason = 'use_received'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM collection_uses WHERE collection_id = ?`,
        )
        .get(violinCollection.id_collection),
    ).toEqual({ count: 0 });
  });

  it("AC-2: ranking is separated by tenant", async () => {
    const piano = await app.router.request("/v1/custom/ranking");
    const violin = await app.router.request("/v1/custom/ranking", {
      headers: { "X-Tenant": "violin" },
    });
    expect((await piano.json()).data).toEqual([
      expect.objectContaining({ display_name: "Piano User", total: 10 }),
    ]);
    expect((await violin.json()).data).toEqual([
      expect.objectContaining({ display_name: "Violin User", total: 20 }),
    ]);
  });

  it("AC-3: default Piano catalog response shape remains stable", async () => {
    const implicit = await app.router.request("/v1/custom/collections");
    const explicit = await app.router.request("/v1/custom/collections", {
      headers: { "X-Tenant": "piano" },
    });
    expect(await implicit.json()).toEqual(await explicit.json());
  });

  it("scopes active seasonal event to tenant", async () => {
    const piano = await app.router.request("/v1/custom/seasonal-event");
    const violin = await app.router.request("/v1/custom/seasonal-event", {
      headers: { "X-Tenant": "violin" },
    });
    expect(await piano.json()).toEqual({ active: false });
    expect(await violin.json()).toMatchObject({
      active: true,
      name: "Violin season",
      multiplier: 2,
    });
  });
});
