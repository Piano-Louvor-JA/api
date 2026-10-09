import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * E2E APK→API: is_owner da listagem de coletâneas tem que ser BOOLEANO real
 * (1 quando o próprio usuário é o dono, 0 para coletâneas de terceiros).
 * Bug achado por E2E real do APK contra produção (07/10/2026): o SELECT
 * injetava o id_user no lugar do flag — dono aparecia como não-dono e o
 * app desabilitava edição/exclusão da própria coletânea.
 */
describe("GET /v1/custom/collections — is_owner booleano (bug APK E2E)", () => {
  let app: SeededDb;
  let router: any;
  let ownerToken: string;
  let otherToken: string;
  let ownerId: number;
  let collectionId: number;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    const owner = registerUser("isowner-dono@test.local", "SenhaForte1!");
    const other = registerUser("isowner-outro@test.local", "SenhaForte1!");
    ownerToken = owner.token;
    otherToken = other.token;
    ownerId = owner.user?.id_user ?? owner.id_user;

    const created = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Dono E2E", description: "is_owner" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    collectionId = body.id_collection ?? body.id;
    expect(collectionId).toBeDefined();
  });

  afterAll(() => app.cleanup());

  it("dono vê is_owner === 1 na própria coletânea", async () => {
    const res = await router.request("/v1/custom/collections", {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = body.data ?? body;
    const mine = (Array.isArray(items) ? items : items.items).find(
      (c: any) => (c.id_collection ?? c.id) === collectionId,
    );
    expect(mine).toBeDefined();
    expect(mine.is_owner).toBe(1);
  });

  it("outro usuário vê is_owner === 0 (não o id do dono)", async () => {
    const res = await router.request("/v1/custom/collections", {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = body.data ?? body;
    const row = (Array.isArray(items) ? items : items.items).find(
      (c: any) => (c.id_collection ?? c.id) === collectionId,
    );
    // Coletânea é pública → visível, mas NÃO é dele:
    if (row) {
      expect(row.is_owner).toBe(0);
    }
  });

  it("deslogado vê is_owner === 0", async () => {
    const res = await router.request("/v1/custom/collections");
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = body.data ?? body;
    const row = (Array.isArray(items) ? items : items.items).find(
      (c: any) => (c.id_collection ?? c.id) === collectionId,
    );
    if (row) {
      expect(row.is_owner).toBe(0);
    }
  });
});
