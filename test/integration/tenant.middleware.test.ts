import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

describe("tenant middleware", () => {
  let app: SeededDb;

  beforeAll(async () => {
    app = await setupSeededDb();
  });

  afterAll(() => app.cleanup());

  it("defaults missing X-Tenant to piano", async () => {
    const response = await app.router.request("/v1/custom/collections");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tenant")).toBe("piano");
  });

  it("rejects an unknown X-Tenant with valid_tenants", async () => {
    const response = await app.router.request("/v1/custom/collections", {
      headers: { "x-tenant": "guitarra" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid tenant",
      valid_tenants: ["classic", "flute", "piano", "violin"],
    });
  });

  it("scopes collection reads to the request tenant", async () => {
    const db = await import("../../src/db/connection.js");
    db.getDb()
      .prepare(
        "INSERT INTO custom_collections (name, owner_id, visibility, tenant_id) VALUES (?, ?, ?, ?)",
      )
      .run("Flute only", 1, "public", "flute");

    const piano = await app.router.request("/v1/custom/collections");
    const flute = await app.router.request("/v1/custom/collections", {
      headers: { "x-tenant": "flute" },
    });

    expect((await piano.json()).data).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Flute only" })]),
    );
    expect((await flute.json()).data).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Flute only" })]),
    );
  });
});
