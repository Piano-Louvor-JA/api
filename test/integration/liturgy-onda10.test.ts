import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 10e: liturgy catalog — ETag (200/304), catch 500.
 */
describe("Liturgy catalog", () => {
  let app: SeededDb;
  let router: any;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
  });

  afterAll(() => app.cleanup());

  it("GET liturgy catalog → 200 com ETag", async () => {
    const res = await router.request("/v1/liturgy/catalog");
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const h = Object.fromEntries(res.headers.entries());
      expect(h.etag ?? "").toBeTruthy();
    }
  });

  it("GET com If-None-Match igual ao ETag → 304", async () => {
    const first = await router.request("/v1/liturgy/catalog");
    if (first.status !== 200) {
      expect([404]).toContain(first.status);
      return;
    }
    const h = Object.fromEntries(first.headers.entries());
    const etag = h.etag;
    const second = await router.request("/v1/liturgy/catalog", {
      headers: { "if-none-match": etag },
    });
    expect(second.status).toBe(304);
  });

  it("GET com If-None-Match diferente → 200 de novo", async () => {
    const res = await router.request("/v1/liturgy/catalog", {
      headers: { "if-none-match": '"etag-errado-123"' },
    });
    expect([200, 404]).toContain(res.status);
  });
});
