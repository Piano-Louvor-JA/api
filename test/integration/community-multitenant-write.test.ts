import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashToken } from "../../src/v1/custom/auth.service.js";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

describe("community multitenant write scope", () => {
  let app: SeededDb;
  let pianoToken: string;

  beforeAll(async () => {
    app = await setupSeededDb();
    const db = app.getDb();
    const pianoUser = Number(
      db
        .prepare(
          `INSERT INTO custom_users (email, password_hash, display_name, tenant_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run("write-piano@tenant.local", "x", "Piano Writer", "piano")
        .lastInsertRowid,
    );
    const violinUser = Number(
      db
        .prepare(
          `INSERT INTO custom_users (email, password_hash, display_name, tenant_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run("write-violin@tenant.local", "x", "Violin Writer", "violin")
        .lastInsertRowid,
    );
    pianoToken = "write-piano-token";
    db.prepare(`INSERT INTO custom_sessions (token_hash, id_user) VALUES (?, ?)`)
      .run(hashToken(pianoToken), pianoUser);
    db.prepare(
      `INSERT INTO custom_collections (name, owner_id, visibility, tenant_id)
       VALUES (?, ?, 'public', ?)`,
    ).run("Violin Write Collection", violinUser, "violin");
  });

  afterAll(() => app.cleanup());

  const auth = () => ({ authorization: `Bearer ${pianoToken}` });

  it("persists collection tenant from request context", async () => {
    const response = await app.router.request("/v1/custom/collections", {
      method: "POST",
      headers: {
        ...auth(),
        "content-type": "application/json",
        "X-Tenant": "violin",
      },
      body: JSON.stringify({ name: "Context tenant collection" }),
    });

    expect(response.status).toBe(201);
    const collection = (await response.json()) as { id_collection: number };
    expect(
      app
        .getDb()
        .prepare(`SELECT tenant_id FROM custom_collections WHERE id_collection = ?`)
        .get(collection.id_collection),
    ).toEqual({ tenant_id: "violin" });
  });

  it("returns the same 403 for cross-tenant collection write operations", async () => {
    const violinCollection = app
      .getDb()
      .prepare(`SELECT id_collection FROM custom_collections WHERE name = ?`)
      .get("Violin Write Collection") as { id_collection: number };

    const update = await app.router.request(
      `/v1/custom/collections/${violinCollection.id_collection}`,
      {
        method: "PUT",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ name: "blocked" }),
      },
    );
    const remove = await app.router.request(
      `/v1/custom/collections/${violinCollection.id_collection}`,
      { method: "DELETE", headers: auth() },
    );
    const createMusic = await app.router.request(
      `/v1/custom/collections/${violinCollection.id_collection}/musics`,
      {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ name: "blocked" }),
      },
    );

    expect(update.status).toBe(403);
    expect(await update.json()).toEqual({ error: "Sem permissão" });
    expect(remove.status).toBe(403);
    expect(await remove.json()).toEqual({ error: "Sem permissão" });
    expect(createMusic.status).toBe(403);
    expect(await createMusic.json()).toEqual({ error: "Sem permissão" });
  });

  it("returns 403 for every cross-tenant write while real missing resources remain 404", async () => {
    const db = app.getDb();
    const violinCollection = db
      .prepare(`SELECT id_collection FROM custom_collections WHERE name = ?`)
      .get("Violin Write Collection") as { id_collection: number };
    const violinMusic = Number(
      db
        .prepare(
          `INSERT INTO custom_musics (id_collection, name, owner_id) VALUES (?, ?, ?)`,
        )
        .run(violinCollection.id_collection, "Violin Write Music", 2).lastInsertRowid,
    );
    const violinLyric = Number(
      db
        .prepare(`INSERT INTO custom_lyrics (id_music, lyric) VALUES (?, ?)`)
        .run(violinMusic, "Violin lyric").lastInsertRowid,
    );

    const requests = [
      app.router.request(
        `/v1/custom/collections/${violinCollection.id_collection}/musics/${violinMusic}/copy`,
        { method: "POST", headers: auth() },
      ),
      app.router.request(`/v1/custom/musics/${violinMusic}`, {
        method: "PUT",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ name: "blocked" }),
      }),
      app.router.request(`/v1/custom/musics/${violinMusic}`, {
        method: "DELETE",
        headers: auth(),
      }),
      app.router.request(`/v1/custom/musics/${violinMusic}/lyrics`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ lyric: "blocked" }),
      }),
      app.router.request(`/v1/custom/lyrics/${violinLyric}`, {
        method: "PUT",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ lyric: "blocked" }),
      }),
      app.router.request(`/v1/custom/lyrics/${violinLyric}`, {
        method: "DELETE",
        headers: auth(),
      }),
      app.router.request(
        `/v1/custom/collections/${violinCollection.id_collection}/report`,
        {
          method: "POST",
          headers: { ...auth(), "content-type": "application/json" },
          body: JSON.stringify({ reason: "bad" }),
        },
      ),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Sem permissão" });
    }

    const missing = await app.router.request("/v1/custom/musics/999999", {
      method: "DELETE",
      headers: auth(),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Música não encontrada" });
  });

  it("returns the same error body when report target is foreign or missing", async () => {
    const violinCollection = app
      .getDb()
      .prepare(`SELECT id_collection FROM custom_collections WHERE name = ?`)
      .get("Violin Write Collection") as { id_collection: number };
    const report = (id: number) =>
      app.router.request(`/v1/custom/collections/${id}/report`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ reason: "bad" }),
      });

    const [foreign, missing] = await Promise.all([
      report(violinCollection.id_collection),
      report(999999),
    ]);

    expect(foreign.status).toBe(403);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });
});
