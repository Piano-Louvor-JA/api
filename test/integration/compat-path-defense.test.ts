import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.MEDIA_MIRROR = "on";
});
vi.mock("../../src/lib/mirrorGuard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/mirrorGuard.js")>()),
  mirrorablePath: () => true,
}));

import { createApp } from "../../src/app.js";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

let fixture: SeededDb;
beforeAll(async () => {
  fixture = await setupSeededDb();
});
afterAll(() => fixture.cleanup());
it("defesa do caminho resolvido impede traversal mesmo se allowlist falhar", async () => {
  const response = await createApp().request("/file/%2e%2e%2foutside.mp3");
  expect(response.status).toBe(400);
});
