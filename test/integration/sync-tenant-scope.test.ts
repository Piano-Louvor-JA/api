import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmpDir = mkdtempSync(join(tmpdir(), "plj-sync-tenant-"));
process.env.DB_PATH = join(tmpDir, "sync.db");

const { closeDb, getDb, initDb } = await import("../../src/db/connection.js");
const { runSync } = await import("../../src/v1/custom/sync.service.js");
const { registerUser } = await import("./helpers/custom-auth-helpers.js");

describe("sync tenant scope", () => {
  let userId: number;

  beforeAll(() => {
    initDb();
    userId = registerUser("sync-tenant@test.local", "S3nh@F0rte").id_user;
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("isolates same client UUIDs and persists the request tenant", () => {
    const body = {
      collections: [
        {
          client_uuid: "shared-uuid-0001",
          name: "Violin sync",
          updated_at: 1_700_000_000_000,
        },
      ],
    };

    const violin = runSync(userId, body, "violin");
    const piano = runSync(userId, { collections: [] }, "piano");

    expect(violin.collections).toEqual([
      expect.objectContaining({ client_uuid: "shared-uuid-0001" }),
    ]);
    expect(piano.collections).toEqual([]);
    expect(
      getDb()
        .prepare(`SELECT tenant_id FROM custom_collections WHERE client_uuid = ?`)
        .get("shared-uuid-0001"),
    ).toEqual({ tenant_id: "violin" });
  });
});
