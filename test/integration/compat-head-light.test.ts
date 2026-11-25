import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * O teste de conexão dos apps (ApiStatusBanner) faz HEAD /json_db/pt_musics a
 * cada 15 s. O Hono atende HEAD com o handler do GET: a lista inteira era
 * montada (≈1–2,5 s de SQLite síncrono, travando a API) e descartada. HEAD
 * das listas responde na hora, sem tocar no banco.
 */
describe("HEAD /json_db das listas não monta o JSON", () => {
  let app: SeededDb;
  let router: any;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
  });

  afterAll(() => app.cleanup());

  it.each([
    "pt_musics",
    "es_musics",
    "pt_categories",
    "pt_hymnal",
    "pt_hymnal_1996",
    "pt_bible_book",
    "es_bible_version",
  ])("HEAD /json_db/%s → 200 JSON sem consultar o banco", async (file) => {
    const prepare = vi.spyOn(app.getDb(), "prepare");
    try {
      const res = await router.request(`/json_db/${file}`, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.text()).toBe("");
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });

  it("GET continua montando a lista", async () => {
    const prepare = vi.spyOn(app.getDb(), "prepare");
    try {
      const res = await router.request("/json_db/pt_musics");
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
      expect(prepare).toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });

  it("HEAD de arquivo individual (music_{id}) segue o fluxo normal", async () => {
    const res = await router.request("/json_db/music_30", { method: "HEAD" });
    expect([200, 404]).toContain(res.status);
  });
});
