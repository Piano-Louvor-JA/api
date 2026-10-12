import { afterAll, beforeAll, expect, it } from "vitest";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

let fixture: SeededDb;
beforeAll(async () => {
  fixture = await setupSeededDb();
  fixture.getDb().exec(`
    INSERT INTO albums (id_album,name,id_language,color) VALUES (777777,'Empty metadata','pt',NULL);
    INSERT INTO categories_albums (id_category,id_album,name,id_language,"order") VALUES (98,777777,NULL,'pt',99);
    INSERT INTO musics (id_music,name,id_language) VALUES (777777,'No media','pt');
    INSERT INTO albums_musics (id_album,id_music,track,id_language) VALUES (777777,777777,NULL,'pt');
    CREATE TABLE IF NOT EXISTS liturgy_programs (id_program INTEGER PRIMARY KEY,name TEXT NOT NULL,id_language TEXT NOT NULL,id_file INTEGER,active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO liturgy_programs (id_program,name,id_language,id_file,active) VALUES (777777,'No document','pt',NULL,0);
  `);
});
afterAll(() => fixture.cleanup());
it("catálogo conserva campos nulos sem inventar mídia ou ordem", async () => {
  const response = await fixture.router.request("/v1/liturgy?lang=pt");
  expect(response.status).toBe(200);
  const body = await response.json();
  const album = body.categories
    .flatMap((c: any) => c.albums)
    .find((a: any) => a.id_album === 777777);
  expect(album).toMatchObject({ color: null, url_image: null, subtitle: null });
  expect(album.musics).toEqual([
    {
      id_music: 777777,
      name: "No media",
      duration: null,
      track: null,
      has_instrumental_music: 0,
      url_music: null,
      url_instrumental_music: null,
      url_image: null,
    },
  ]);
  expect(body.programs).toContainEqual({
    id_program: 777777,
    name: "No document",
    active: false,
    url_file: null,
  });
});
