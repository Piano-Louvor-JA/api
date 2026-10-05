import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupSeededDb } from "../helpers/seeded-db.js";

/**
 * SPEC 9 (apk#98) — GET /v1/liturgy: catálogo agregado de liturgia/kids.
 *
 * Um único request devolve categorias de catálogo fixo (kids/doxology) com
 * álbuns, faixas (com duração, capa e urls de áudio/instrumental) aninhados —
 * formato pensado para o APK cachear 1 payload só e funcionar offline.
 * Reaproveita exatamente os dados da migration 016 (cats 98/99, álbuns 9000+).
 */

const KIDS_CATEGORY_ID = 98;

// IDs da migration 016 (INSERT OR IGNORE — idempotente contra o seed base).
const KIDS_SEED = `
INSERT OR IGNORE INTO files (id_file, name, path, type, url, size, dir, file_name, duration) VALUES
  (90004, 'cover_jesus_criancas','covers/jesus_criancas.jpg','image','covers/jesus_criancas.jpg', 0,'covers','jesus_criancas.jpg',NULL),
  (90122, 'Sim, Cristo me Ama','musics/pt/90122.mp3','audio','musics/pt/90122.mp3',0,'musics/pt','90122.mp3','00:03:19'),
  (90107, 'Vinde, Meninos','musics/pt/90107.mp3','audio','musics/pt/90107.mp3',0,'musics/pt','90107.mp3','00:02:56');
INSERT OR IGNORE INTO albums (id_album, name, id_file_image, color, id_language)
  SELECT 9000, 'Infantis', 90004, '#000000', 'pt' WHERE true;
INSERT OR IGNORE INTO categories (id_category, name, id_language, slug, type, "order")
  SELECT 98, 'Infantis', 'pt', 'kids', 'collection', 98 WHERE true;
INSERT OR IGNORE INTO categories_albums (id_category, id_album, name, "order", id_language)
  SELECT 98, 9000, 'Infantis', 1, 'pt' WHERE true;
INSERT OR IGNORE INTO musics (id_music, name, id_file_image, id_file_music, id_file_instrumental_music, id_language) VALUES
  (90122, 'Sim, Cristo me Ama', NULL, 90122, NULL, 'pt'),
  (90107, 'Vinde, Meninos', NULL, 90107, NULL, 'pt');
INSERT OR IGNORE INTO albums_musics (id_album, id_music, track, id_language) VALUES
  (9000, 90122, 1, 'pt'), (9000, 90107, 2, 'pt');
`;

const DOXOLOGY_SEED = `
INSERT OR IGNORE INTO files (id_file, name, path, type, url, size, dir, file_name, duration) VALUES
  (90002, 'cover_oracao','covers/oracao.jpg','image','covers/oracao.jpg',0,'covers','oracao.jpg',NULL),
  (90101, 'Falar com Deus','musics/pt/90101.mp3','audio','musics/pt/90101.mp3',0,'musics/pt','90101.mp3','00:04:06'),
  (90141, 'Santo Lugar','musics/pt/90141.mp3','audio','musics/pt/90141.mp3',0,'musics/pt','90141.mp3','00:02:23');
INSERT OR IGNORE INTO albums (id_album, name, id_file_image, color, id_language) VALUES
  (9012, 'Oração Intercessora', 90002, '#000000', 'pt'),
  (9010, 'Entrada da Plataforma', 90002, '#000000', 'pt');
INSERT OR IGNORE INTO categories (id_category, name, id_language, slug, type, "order")
  SELECT 99, 'Doxologia', 'pt', 'doxology', 'collection', 99 WHERE true;
INSERT OR IGNORE INTO categories_albums (id_category, id_album, name, "order", id_language) VALUES
  (99, 9012, 'Oração Intercessora', 1, 'pt'),
  (99, 9010, 'Entrada da Plataforma', 2, 'pt');
INSERT OR IGNORE INTO musics (id_music, name, id_file_image, id_file_music, id_file_instrumental_music, id_language) VALUES
  (90101, 'Falar com Deus', NULL, 90101, NULL, 'pt'),
  (90141, 'Santo Lugar', NULL, 90141, NULL, 'pt');
INSERT OR IGNORE INTO albums_musics (id_album, id_music, track, id_language) VALUES
  (9012, 90101, 1, 'pt'), (9010, 90141, 1, 'pt');
`;

// Registro de liturgia "bruto" (simula dados que um gestor cadastra):
const LITURGY_PROGRAM_SEED = `
INSERT INTO files (id_file, name, path, type, url, size, dir, file_name, duration) VALUES
  (90200, 'liturgia_sabado', 'liturgia/sabado.json', 'json', 'liturgia/sabado.json', 0, 'liturgia', 'sabado.json', NULL);
INSERT INTO liturgy_programs (id_program, name, id_language, id_file, active) VALUES
  (1, 'Culto de Sábado', 'pt', 90200, 1);
`;

async function seedCatalog(db: any) {
  db.exec(KIDS_SEED);
  db.exec(DOXOLOGY_SEED);
  // Tabela opcional de programas pode não existir em DBs antigos — cria se preciso.
  db.exec(`CREATE TABLE IF NOT EXISTS liturgy_programs (
    id_program INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    id_language TEXT NOT NULL,
    id_file INTEGER,
    active INTEGER NOT NULL DEFAULT 1
  )`);
  db.exec(LITURGY_PROGRAM_SEED);
}

describe("GET /v1/liturgy (SPEC 9 — apk#98)", () => {
  let router: any;
  let db: any;
  let cleanup: () => void;

  beforeAll(async () => {
    ({ router, cleanup, getDb } = await setupSeededDb());
    db = getDb();
    await seedCatalog(db);
  });
  afterAll(() => cleanup());

  it("RED: rota /v1/liturgy existe e responde 200", async () => {
    const res = await router.request("/v1/liturgy?lang=pt");
    expect(res.status).toBe(200);
  });

  it("retorna categorias kids e doxology com álbuns aninhados", async () => {
    const res = await router.request("/v1/liturgy?lang=pt");
    const body = await res.json();

    expect(Array.isArray(body.categories)).toBe(true);
    const slugs = body.categories.map((c: any) => c.slug);
    expect(slugs).toContain("kids");
    expect(slugs).toContain("doxology");

    const kids = body.categories.find((c: any) => c.slug === "kids");
    expect(kids.id_category).toBe(KIDS_CATEGORY_ID);
    expect(kids.albums.length).toBeGreaterThan(0);
    expect(kids.albums[0]).toHaveProperty("id_album");
    expect(kids.albums[0]).toHaveProperty("name");
    expect(kids.albums[0]).toHaveProperty("url_image");
  });

  it("aninha faixas com conteúdo e mídias (duration, track, url áudio/capa)", async () => {
    const res = await router.request("/v1/liturgy?lang=pt");
    const body = await res.json();
    const kids = body.categories.find((c: any) => c.slug === "kids");
    const album = kids.albums.find((a: any) => a.id_album === 9000);

    // Migration 016: album 9000 (Músicas Infantis) tem 21 faixas, ordem da UI.
    expect(album.musics.length).toBe(21);
    expect(album.musics[0].id_music).toBe(90122);
    expect(album.musics[0].name).toBe("Sim, Cristo me Ama");
    expect(album.musics[0].duration).toBe("00:03:19");
    expect(album.musics[0].track).toBe(1);
    expect(album.musics[0].url_music).toBe("musics/pt/90122.mp3");
    expect(album.musics[0].has_instrumental_music).toBe(0);
  });

  it("retorna programs de liturgia cadastrados", async () => {
    const res = await router.request("/v1/liturgy?lang=pt");
    const body = await res.json();

    expect(Array.isArray(body.programs)).toBe(true);
    expect(body.programs.length).toBe(1);
    expect(body.programs[0]).toMatchObject({
      id_program: 1,
      name: "Culto de Sábado",
    });
  });

  it("cross-list: 'Adoração' (90102) aparece no Entrada da Plataforma (9010) via track 11", async () => {
    // Migration 016: 90102 é cross-list intencional entre 9013 e 9010.
    const res = await router.request("/v1/liturgy?lang=pt");
    const body = await res.json();
    const dox = body.categories.find((c: any) => c.slug === "doxology");
    const entrada = dox.albums.find((a: any) => a.id_album === 9010);
    expect(entrada.musics.length).toBe(15);
    expect(entrada.musics[10].id_music).toBe(90102);
    expect(entrada.musics[10].track).toBe(11);
    // E a mesma faixa também está no album 9013 (Adoração Infantil, track 1).
    const adoracao = dox.albums.find((a: any) => a.id_album === 9013);
    // 9013 = Adoração Infantil: 90107..90112 (90102 NÃO está aqui; só em 9010).
    expect(adoracao.musics.length).toBe(6);
    expect(adoracao.musics[0].id_music).toBe(90107);
  });

  it("cacheable: expõe ETag e responde 304 em If-None-Match", async () => {
    const res1 = await router.request("/v1/liturgy?lang=pt");
    expect(res1.status).toBe(200);
    const etag = res1.headers.get("etag");
    expect(etag).toBeTruthy();

    const res2 = await router.request("/v1/liturgy?lang=pt", {
      headers: { "If-None-Match": etag },
    });
    expect(res2.status).toBe(304);
  });

  it("idioma sem dados retorna categorias vazias (não 404)", async () => {
    const res = await router.request("/v1/liturgy?lang=es");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.categories).toEqual([]);
    expect(body.programs).toEqual([]);
  });

  it("sem lang usa pt por default", async () => {
    const res = await router.request("/v1/liturgy");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.categories.length).toBeGreaterThan(0);
  });
});

var getDb: any;
