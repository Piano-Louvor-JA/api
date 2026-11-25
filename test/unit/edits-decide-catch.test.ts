import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Cobre o catch de POST /v1/custom/edits/:id/decide:
 * - Error sem "reason" → 500
 * - throw não-Error → String(e) no catch
 */
const mocks = vi.hoisted(() => ({
  decideEdit: vi.fn(),
}));

vi.mock("../../src/v1/custom/edits.service.js", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("../../src/v1/custom/edits.service.js")
    >();
  return {
    ...real,
    decideEdit: (...args: unknown[]) => mocks.decideEdit(...args),
  };
});

import { createApp } from "../../src/app.js";
import { closeDb, getDb, initDb } from "../../src/db/connection.js";
import { hashToken } from "../../src/v1/custom/auth.service.js";

describe("POST /edits/:id/decide catch", () => {
  let router: ReturnType<typeof createApp>;
  let gmToken: string;

  beforeAll(async () => {
    process.env.DB_PATH = ":memory:";
    await initDb();
    const db = getDb();
    const gmId = Number(
      db
        .prepare(
          `INSERT INTO custom_users (email, password_hash, display_name, tenant_id, is_gm)
           VALUES ('decide-catch-gm@t.local', 'x', 'GM', 'piano', 1)`,
        )
        .run().lastInsertRowid,
    );
    gmToken = "decide-catch-gm-token";
    db.prepare(
      `INSERT INTO custom_sessions (token_hash, id_user) VALUES (?, ?)`,
    ).run(hashToken(gmToken), gmId);
    router = createApp();
  });

  afterAll(() => closeDb());

  it("decideEdit lança Error sem reason → 500", async () => {
    mocks.decideEdit.mockImplementation(() => {
      throw new Error("sqlite busy");
    });
    const res = await router.request("/v1/custom/edits/1/decide", {
      method: "POST",
      headers: {
        authorization: `Bearer ${gmToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });

  it("decideEdit lança valor não-Error → 500 via String(e)", async () => {
    mocks.decideEdit.mockImplementation(() => {
      throw "boom-non-error";
    });
    const res = await router.request("/v1/custom/edits/1/decide", {
      method: "POST",
      headers: {
        authorization: `Bearer ${gmToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(500);
  });
});
