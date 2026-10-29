import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

describe("community multitenant read scope", () => {
  let app: SeededDb;

  beforeAll(async () => {
    app = await setupSeededDb();
    const db = app.getDb();
    db.prepare(
      `INSERT INTO custom_users (email, password_hash, display_name, tenant_id)
       VALUES (?, 'x', ?, ?)`,
    ).run("piano@tenant.local", "Piano User", "piano");
    db.prepare(
      `INSERT INTO custom_users (email, password_hash, display_name, tenant_id)
       VALUES (?, 'x', ?, ?)`,
    ).run("violin@tenant.local", "Violin User", "violin");

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
