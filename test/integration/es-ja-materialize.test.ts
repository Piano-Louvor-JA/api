import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  assertLicense,
  materialize,
} from "../../scripts/lib/es-ja-materialize.js";

/**
 * Teste real de materializacao: cria fonte privada fake (mp3 + slja),
 * executa materialize() contra SQLite (node:sqlite) e verifica tabelas
 * existentes + promoção atomica de arquivos para musics/es/<album>/.
 * better-sqlite3 nao compila em Node 26 — node:sqlite e o substituto local.
 */

const root = await mkdtemp(path.join(tmpdir(), "esja-mat-"));
const sourceDir = path.join(root, "private");
const mediaRoot = path.join(root, "media");
const dbPath = path.join(root, "catalog.db");
const manifestPath = path.join(root, "manifest.tsv");
const migrationsDir = path.join(process.cwd(), "src", "db", "migrations");

const _sourceReady = false;

const ALBUM = "12. JA 2003 - Enséñame a Servir";
const AUDIO_DIR = `${ALBUM}/(audios) ${ALBUM}`;

async function writeSource(
  rel: string,
  content: Buffer | string,
): Promise<void> {
  const dest = path.join(sourceDir, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, content);
}

function sljaZip(entries: Record<string, string>): Buffer {
  const dir = path.join(root, "zip-tmp");
  execFileSync("rm", ["-rf", dir]);
  for (const [name, content] of Object.entries(entries)) {
    const dest = path.join(dir, name);
    mkdirSyncRecursive(path.dirname(dest));
    writeFileOf(dest, content);
  }
  execFileSync("zip", ["-q", "-r", path.join(root, "tmp.slja"), "."], {
    cwd: dir,
  });
  return readFileSyncOf(path.join(root, "tmp.slja"));
}

// helpers sync pequenos para montar zip via CLI
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

function mkdirSyncRecursive(p: string) {
  mkdirSync(p, { recursive: true });
}
function writeFileOf(p: string, c: string) {
  writeFileSync(p, c);
}
function readFileSyncOf(p: string) {
  return readFileSync(p);
}

beforeAll(buildSource);

async function buildSource(): Promise<void> {
  // cover do ano do tema (mesma disposicao do es-ja-source/covers/)
  await writeSource("covers/2003.jpg", Buffer.from("fake-cover-2003"));
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
        "[Geral]\r\nslides=2\r\ntitulo=Beta\r\n[Slide:1]\r\nletra=Estrofa|uno\r\ntempo_hms=00:00:05\r\n[Slide:2]\r\nletra=Estrofa|dos\r\n",
    }),
  );
  await writeSource(
    `${AUDIO_DIR}/Alfa (audio-cantado).mp3`,
    Buffer.from("fake-vocal-alfa"),
  );
  const tsv = [
    `id-beta-vocal\t${AUDIO_DIR}/Beta (audio-cantado).mp3`,
    `id-beta-pista\t${AUDIO_DIR}/Beta (audio-pista).mp3`,
    `id-beta-slja\t${AUDIO_DIR}/Beta.slja`,
    `id-alfa-vocal\t${AUDIO_DIR}/Alfa (audio-cantado).mp3`,
  ].join("\n");
  await writeFile(manifestPath, tsv, "utf8");
}
// buildSource roda via beforeAll

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
});

const baseOptions = {
  manifestPath,
  sourceDir,
  dbPath,
  mediaRoot,
  licenseApprovalId: "LA-ESJA-20261011",
  esCategoryId: 12,
};

describe("ES JA materialize", () => {
  it("rejeita license approval invalida", () => {
    expect(() => assertLicense("XX-123")).toThrow(
      "invalid license approval id",
    );
    expect(() => assertLicense("")).toThrow("invalid license approval id");
    expect(() => assertLicense("LA-ESJA-20261011")).not.toThrow();
  });

  it("aplica migrations em DB vazio", () => {
    const db = new DatabaseSync(path.join(root, "mig.db"));
    applyMigrations(db, migrationsDir);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('files','musics','albums','albums_musics','lyrics','categories_albums','catalog_imports')",
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual([
      "albums",
      "albums_musics",
      "catalog_imports",
      "categories_albums",
      "files",
      "lyrics",
      "musics",
    ]);
    db.close();
  });

  it("materializa catalogo nas tabelas existentes e promove arquivos atomicamente", async () => {
    const result = await materialize(baseOptions);
    expect(result.status).toBe("published");
    expect(result.albums).toBe(1);
    expect(result.musics).toBe(2);
    expect(result.files).toBe(4); // 3 mp3 + 1 cover image

    const db = new DatabaseSync(dbPath);
    // files: URLs /musics/es/<album>/<nome>.mp3
    const urlList = (
      db
        .prepare(
          "SELECT url FROM files WHERE url LIKE '/musics/es/%' ORDER BY url",
        )
        .all() as {
        url: string;
      }[]
    ).map((r) => r.url);
    expect(urlList).toEqual([
      `/musics/es/${ALBUM}/Alfa (audio-cantado).mp3`,
      `/musics/es/${ALBUM}/Beta (audio-cantado).mp3`,
      `/musics/es/${ALBUM}/Beta (audio-pista).mp3`,
    ]);

    // album + categoria 12
    const album = db
      .prepare(
        "SELECT id_album, name, id_file_image FROM albums WHERE id_language='es'",
      )
      .get() as { id_album: number; name: string; id_file_image: number };
    expect(album.name).toBe("JA 2003 - Enséñame a Servir");
    const catLink = db
      .prepare("SELECT id_category FROM categories_albums WHERE id_album = ?")
      .get(album.id_album) as { id_category: number };
    expect(catLink.id_category).toBe(12);

    // capa: files image shape PT (/covers/es/<ano>.jpg) ligada ao album
    const coverRow = db
      .prepare(
        "SELECT path, type, url, dir, file_name FROM files WHERE id_file = ?",
      )
      .get(album.id_file_image) as {
      path: string;
      type: string;
      url: string;
      dir: string;
      file_name: string;
    };
    expect(coverRow).toEqual({
      path: "/covers/es/2003.jpg",
      type: "image",
      url: "/covers/es/2003.jpg",
      dir: "/covers/es",
      file_name: "2003.jpg",
    });

    // musicas com tracks ordenadas (Alfa=1, Beta=2) e files ligados
    const rows = db
      .prepare(
        `SELECT m.name, am.track, vf.url AS vocal, IFNULL(if2.url,'') AS pista
         FROM musics m
         JOIN albums_musics am ON am.id_music = m.id_music AND am.id_language='es'
         JOIN files vf ON vf.id_file = m.id_file_music
         LEFT JOIN files if2 ON if2.id_file = m.id_file_instrumental_music
         WHERE m.id_language='es' ORDER BY am.track`,
      )
      .all() as { name: string; track: number; vocal: string; pista: string }[];
    expect(rows).toEqual([
      {
        name: "Alfa",
        track: 1,
        vocal: `/musics/es/${ALBUM}/Alfa (audio-cantado).mp3`,
        pista: "",
      },
      {
        name: "Beta",
        track: 2,
        vocal: `/musics/es/${ALBUM}/Beta (audio-cantado).mp3`,
        pista: `/musics/es/${ALBUM}/Beta (audio-pista).mp3`,
      },
    ]);

    // lyrics do slja (2 slides, ordem preservada)
    const lyrics = db
      .prepare(
        `SELECT l.lyric, l."order" FROM lyrics l JOIN musics m ON m.id_music=l.id_music
         WHERE m.name='Beta' ORDER BY l."order"`,
      )
      .all() as { lyric: string; order: number }[];
    expect(lyrics).toEqual([
      { lyric: "Estrofa\nuno", order: 1 },
      { lyric: "Estrofa\ndos", order: 2 },
    ]);

    // auditoria
    const audit = db
      .prepare("SELECT status, license_approval_id FROM catalog_imports")
      .get() as { status: string; license_approval_id: string };
    expect(audit).toEqual({
      status: "published",
      license_approval_id: "LA-ESJA-20261011",
    });
    db.close();

    // arquivos promovidos no media root, staging limpo
    const mediaAlbumDir = path.join(mediaRoot, "musics", "es", ALBUM);
    const promotedFiles = (await readdir(mediaAlbumDir)).sort();
    expect(promotedFiles).toEqual([
      "Alfa (audio-cantado).mp3",
      "Beta (audio-cantado).mp3",
      "Beta (audio-pista).mp3",
    ]);
    expect(
      await readFile(
        path.join(mediaAlbumDir, "Alfa (audio-cantado).mp3"),
        "utf8",
      ),
    ).toBe("fake-vocal-alfa");
    const stagingEntries = await readdir(
      path.join(mediaRoot, ".es-ja-staging"),
    );
    expect(stagingEntries).toHaveLength(0);

    // cover promovido para media/covers/es/
    expect(
      await readFile(path.join(mediaRoot, "covers", "es", "2003.jpg"), "utf8"),
    ).toBe("fake-cover-2003");

    // idempotencia: reexecutar nao duplica nada (noop por manifest hash)
    const again = await materialize(baseOptions);
    expect(again.status).toBe("published");
    expect(again.files).toBe(0);
    const db2 = new DatabaseSync(dbPath);
    expect(
      (
        db2
          .prepare(
            "SELECT COUNT(*) AS n FROM files WHERE url LIKE '/musics/es/%'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(3);
    expect(
      (
        db2
          .prepare(
            "SELECT COUNT(*) AS n FROM musics WHERE id_language='es' AND name IN ('Alfa','Beta')",
          )
          .get() as { n: number }
      ).n,
    ).toBe(2);
    db2.close();
  });
});
