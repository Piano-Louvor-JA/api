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

  it("returns 404 when reporting another tenant collection", async () => {
    const violinCollection = app
      .getDb()
      .prepare(`SELECT id_collection FROM custom_collections WHERE name = ?`)
      .get("Violin Write Collection") as { id_collection: number };

    const response = await app.router.request(
      `/v1/custom/collections/${violinCollection.id_collection}/report`,
      {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ reason: "bad" }),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Coletânea não encontrada" });
  });
});
