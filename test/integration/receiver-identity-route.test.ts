import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

let app: SeededDb;
beforeAll(async () => {
  app = await setupSeededDb();
});
afterAll(() => {
  app.cleanup();
  vi.unstubAllEnvs();
});

it("serve script de identidade sem cache e mantém acesso sem token", async () => {
  vi.stubEnv("PALCO_PARTNER_KEY_STG", "plj_palco_stg_teste");
  const response = await app.router.request("/palco/client-identity.js");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain(
    "application/javascript",
  );
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toContain('"staging":"plj_palco_stg_teste"');
});
