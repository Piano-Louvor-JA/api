import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materialize } from "../../scripts/lib/es-ja-materialize.js";

/**
 * Auditoria estrutural PT x ES (aceite 1 e 5 do card t_eede2f70):
 * materializa um album ES real nas tabelas existentes e compara o SHAPE das
 * respostas de /json_db/es_* contra /json_db/pt_* e contra /v1?lang=es.
 * Equivalencia estrutural = mesmas chaves, mesmos tipos, mesma navegabilidade
 * (capa, audio, pista, lyrics com tempo) que um album PT servido pela API.
 */

const root = await mkdtemp(path.join(tmpdir(), "esja-parity-"));
const originalDbPath = process.env.DB_PATH;
const originalOnMiss = process.env.ON_MISS_FETCH;
const originalMirror = process.env.MEDIA_MIRROR;

const sourceDir = path.join(root, "private");
const mediaRoot = path.join(root, "media");
const dbPath = path.join(root, "catalog.db");
const manifestPath = path.join(root, "manifest.tsv");

const ALBUM = "12. JA 2003 - Enséñame a Servir";
const AUDIO_DIR = `${ALBUM}/(audios) ${ALBUM}`;

let router: any;
let cleanup: () => void;
let getDb: () => any;
let esMusicId = 0;
let esAlbumId = 0;

function sljaZip(entries: Record<string, string | Buffer>): Buffer {
  const dir = path.join(root, "zip-tmp");
  execFileSync("rm", ["-rf", dir]);
  for (const [name, content] of Object.entries(entries)) {
    const dest = path.join(dir, name);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  execFileSync("zip", ["-q", "-r", path.join(root, "tmp.slja"), "."], {
    cwd: dir,
  });
  return readFileSync(path.join(root, "tmp.slja"));
}

beforeAll(async () => {
  // fonte privada fake (mesmo padrao do teste de materializacao)
  const writeSource = async (rel: string, content: Buffer | string) => {
    const dest = path.join(sourceDir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  };
  await writeSource("covers/2003.jpg", Buffer.from("cover-2003"));
  await writeSource(
    `${AUDIO_DIR}/Beta (audio-cantado).mp3`,
    Buffer.from("fake-vocal-beta"),
  );
  await writeSource(
    `${AUDIO_DIR}/Beta (audio-pista).mp3`,
    Buffer.from("fake-pista-beta"),
  );
  await writeSource(
    `${AUDIO_DIR}/Beta.slja`,
    sljaZip({
      "slides.lja":
        "[Geral]\r\nslides=2\r\ntitulo=Beta\r\nurl_musica=audio\\Beta (audio-cantado).mp3\r\n[Slide:1]\r\nletra=Estrofa|uno\r\ntempo=00:00:05\r\nimagem=imagens\\hasd_297B.jpg\r\nimagem_posicao=5\r\n[Slide:2]\r\nletra=Estrofa|dos\r\ntempo=00:00:12\r\n",
      "imagens/hasd_297B.jpg": Buffer.from("fake-image-297"),
    }),
  );
  await writeFile(
    manifestPath,
    [
      `id-beta-vocal\t${AUDIO_DIR}/Beta (audio-cantado).mp3`,
      `id-beta-pista\t${AUDIO_DIR}/Beta (audio-pista).mp3`,
      `id-beta-slja\t${AUDIO_DIR}/Beta.slja`,
    ].join("\n"),
    "utf8",
  );

  // DB da app (migrations oficiais) + materializacao ES por cima
  process.env.DB_PATH = dbPath;
  process.env.PORT = "0";
  process.env.ON_MISS_FETCH = "off";
  process.env.MEDIA_MIRROR = "off";
  const { initDb, closeDb } = await import("../../src/db/connection.js");
  await initDb();
  closeDb();

  await materialize({
    manifestPath,
    sourceDir,
    dbPath,
    mediaRoot,
    licenseApprovalId: "LA-ESJA-20261011",
    esCategoryId: 12,
    probeDuration: async () => 294.879125,
  });

  // album PT equivalente (mesma estrutura que o catalogo atual serve)
  const { initDb: init2, getDb: getDbFn } = await import(
    "../../src/db/connection.js"
  );
  await init2();
  getDb = getDbFn;
  const db = getDb();
  db.exec(`
    INSERT INTO files (id_file, name, path, type, url, size, dir, file_name, duration)
      VALUES (900,'alb_pt','covers/2003.jpg','image','/covers/2003.jpg',10,'covers','2003.jpg',NULL),
             (901,'mus_pt','musics/m1.mp3','music','/musics/m1.mp3',200,'musics','m1.mp3','00:04:55'),
             (902,'pit_pt','musics/m1p.mp3','music','/musics/m1p.mp3',200,'musics','m1p.mp3','00:04:55'),
             (903,'img_pt','images/i1.jpg','image','/images/i1.jpg',10,'images','i1.jpg',NULL);
    INSERT INTO albums (id_album, name, id_file_image, color, id_language)
      VALUES (900,'Album PT',900,'#000000','pt');
    INSERT INTO musics (id_music, name, id_file_image, id_file_music, id_file_instrumental_music, id_language)
      VALUES (900,'Musica PT',903,901,902,'pt');
    INSERT INTO albums_musics (id_album, id_music, track, id_language)
      VALUES (900,900,1,'pt');
    INSERT INTO lyrics (id_music, lyric, aux_lyric, id_file_image, time, instrumental_time, show_slide, "order", id_language)
      VALUES (900,'Estrofa um','aux',903,'00:00:05','00:00:05',1,1,'pt');
    INSERT INTO categories (id_category, name, slug, "order", type, id_language)
      VALUES (900,'CDs Oficiais','cds',1,'collection','pt');
    INSERT INTO categories_albums (id_category, id_album, name, "order", id_language)
      VALUES (900,900,NULL,1,'pt');
  `);
  const { createApp } = await import("../../src/app.js");
  const esMusicRow = db
    .prepare("SELECT id_music FROM musics WHERE id_language='es' LIMIT 1")
    .get() as { id_music: number };
  const esAlbumRow = db
    .prepare("SELECT id_album FROM albums WHERE id_language='es' LIMIT 1")
    .get() as { id_album: number };
  esMusicId = esMusicRow.id_music;
  esAlbumId = esAlbumRow.id_album;
  router = createApp();
  cleanup = () => {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    if (originalOnMiss === undefined) delete process.env.ON_MISS_FETCH;
    else process.env.ON_MISS_FETCH = originalOnMiss;
    if (originalMirror === undefined) delete process.env.MEDIA_MIRROR;
    else process.env.MEDIA_MIRROR = originalMirror;
    void rm(root, { recursive: true, force: true });
  };
});

afterAll(() => cleanup());

const keysOf = (value: unknown): string[] =>
  value === null || typeof value !== "object" ? [] : Object.keys(value).sort();

describe("ES x PT — equivalência estrutural dos endpoints (t_eede2f70 aceite 1)", () => {
  it("/json_db/es_categories tem o mesmo shape de /json_db/pt_categories", async () => {
    const [pt, es] = await Promise.all([
      router.request("/json_db/pt_categories"),
      router.request("/json_db/es_categories"),
    ]);
    expect(pt.status).toBe(200);
    expect(es.status).toBe(200);
    const ptBody = await pt.json();
    const esBody = await es.json();
    expect(keysOf(ptBody[0])).toEqual(keysOf(esBody[0]));
    expect(keysOf(ptBody[0].albums[0])).toEqual(keysOf(esBody[0].albums[0]));

    // album ES navegavel igual ao PT: capa, nome, ordem
    const esAlbum = esBody[0].albums[0];
    expect(esAlbum).toMatchObject({
      id_album: expect.any(Number),
      name: "JA 2003 - Enséñame a Servir",
      url_image: "/covers/es/2003.jpg",
    });
  });

  it("/json_db/es_musics tem o mesmo shape de /json_db/pt_musics", async () => {
    const [pt, es] = await Promise.all([
      router.request("/json_db/pt_musics"),
      router.request("/json_db/es_musics"),
    ]);
    expect(pt.status).toBe(200);
    expect(es.status).toBe(200);
    const ptBody = await pt.json();
    const esBody = await es.json();
    expect(keysOf(ptBody[0])).toEqual(keysOf(esBody[0]));
    expect(keysOf(ptBody[0].albums[0])).toEqual(keysOf(esBody[0].albums[0]));

    const esMusic = esBody[0];
    expect(esMusic).toMatchObject({
      name: "Beta",
      duration: "00:04:55",
      has_instrumental_music: 1,
    });
    expect(esMusic.lyric).toContain("Estrofa");
  });

  it("/json_db/music_{id} ES serve audio, pista e slides como o PT", async () => {
    const [ptRes, esRes] = await Promise.all([
      router.request("/json_db/music_900"),
      router.request(`/json_db/music_${esMusicId}`),
    ]);
    expect(ptRes.status).toBe(200);
    expect(esRes.status).toBe(200);
    const pt = await ptRes.json();
    const es = await esRes.json();
    expect(keysOf(pt)).toEqual(keysOf(es));
    expect(keysOf(pt.lyric[0])).toEqual(keysOf(es.lyric[0]));
    expect(keysOf(pt.albums[0])).toEqual(keysOf(es.albums[0]));

    expect(es.url_music).toBe(
      "/musics/es/12. JA 2003 - Enséñame a Servir/Beta (audio-cantado).mp3",
    );
    expect(es.url_instrumental_music).toBe(
      "/musics/es/12. JA 2003 - Enséñame a Servir/Beta (audio-pista).mp3",
    );
    expect(es.duration).toBe("00:04:55");
    expect(es.lyric).toHaveLength(2);
    expect(es.lyric[0]).toMatchObject({
      time: "00:00:05",
      instrumental_time: "00:00:05",
      show_slide: 1,
      url_image: "/images/es/hasd_297B.jpg",
      image_position: 5,
    });
  });

  it("/json_db/album_{id} ES tem o mesmo shape do PT", async () => {
    const [ptRes, esRes] = await Promise.all([
      router.request("/json_db/album_900"),
      router.request(`/json_db/album_${esAlbumId}`),
    ]);
    expect(ptRes.status).toBe(200);
    expect(esRes.status).toBe(200);
    const pt = await ptRes.json();
    const es = await esRes.json();
    expect(keysOf(pt)).toEqual(keysOf(es));
    expect(keysOf(pt.musics[0])).toEqual(keysOf(es.musics[0]));
    expect(es.name).toBe("JA 2003 - Enséñame a Servir");
    expect(es.url_image).toBe("/covers/es/2003.jpg");
    expect(es.musics[0]).toMatchObject({
      name: "Beta",
      has_instrumental_music: 1,
      has_playback: true,
      duration: "00:04:55",
    });
  });

  it("/v1?lang=es mantém paridade de shape com lang=pt", async () => {
    const [ptCat, esCat] = await Promise.all([
      router.request("/v1/categories?lang=pt"),
      router.request("/v1/categories?lang=es"),
    ]);
    expect(ptCat.status).toBe(200);
    expect(esCat.status).toBe(200);
    const ptBody = await ptCat.json();
    const esBody = await esCat.json();
    expect(keysOf(ptBody[0])).toEqual(keysOf(esBody[0]));
    expect(keysOf(ptBody[0].albums[0])).toEqual(keysOf(esBody[0].albums[0]));
    expect(esBody[0].albums[0].url_image).toBe("/covers/es/2003.jpg");

    const [ptMus, esMus] = await Promise.all([
      router.request("/v1/musics?lang=pt"),
      router.request("/v1/musics?lang=es"),
    ]);
    expect(ptMus.status).toBe(200);
    expect(esMus.status).toBe(200);
    const ptList = await ptMus.json();
    const esList = await esMus.json();
    expect(keysOf(ptList.data[0])).toEqual(keysOf(esList.data[0]));
  });

  it("mídia ES materializada só expõe assets runtime (sem slja/ppt/vídeo)", async () => {
    const entries = await (await import("node:fs/promises")).readdir(
      path.join(mediaRoot, "musics", "es", ALBUM),
    );
    expect(entries.every((f) => f.endsWith(".mp3") || f.endsWith(".jpg"))).toBe(
      true,
    );
    expect(entries.some((f) => f.endsWith(".slja"))).toBe(false);
  });
});
