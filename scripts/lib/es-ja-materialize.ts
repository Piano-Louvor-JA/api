/**
 * Materializacao do catalogo ES-JA nas tabelas existentes
 * (files/musics/albums/albums_musics/lyrics/categories_albums) + media em
 * `musics/es/<album>/<arquivo>.mp3`.
 *
 * Garantias:
 * - Atomico: arquivos sao copiados para staging FORA do media dir e promovidos
 *   por rename; o SQLite roda em transacao com rollback em qualquer falha.
 * - Idempotente: reexecutar NAO duplica files (unique url), albuns (por nome+es)
 *   nem musicas (por album+nome). Arquivos ja promovidos sao reutilizados.
 * - Audit: registra catalog_imports/catalog_import_items (migration 030).
 * - Licenca: licenseApprovalId obrigatorio.
 *
 * SQLite: node:sqlite (DatabaseSync) — better-sqlite3 nao compila em Node 26.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { planCatalog } from "./es-ja-catalog.js";
import {
  type EsJaManifestItem,
  normalizedManifestHash,
  parseManifest,
} from "./es-ja-manifest.js";
import { parseSlja } from "./es-ja-slja.js";

export type MaterializeOptions = {
  manifestPath: string;
  sourceDir: string; // raiz privada com as colecoes JA
  dbPath: string;
  mediaRoot: string; // raiz onde vive musics/
  licenseApprovalId: string;
  esCategoryId: number; // categoria "CDs Oficiais" ES (12 na VM)
  stagingParent?: string; // default: mediaRoot/.es-ja-staging
};

export type MaterializeResult = {
  importId: string;
  status: "published";
  manifestSha256: string;
  albums: number;
  musics: number;
  files: number;
  lyricsSlides: number;
  skippedExistingFiles: number;
};

const REQUIRED_LICENSE_PREFIX = "LA-ESJA-";

export function assertLicense(licenseApprovalId: string): void {
  if (!licenseApprovalId?.startsWith(REQUIRED_LICENSE_PREFIX)) {
    throw new Error(
      `invalid license approval id: expected ${REQUIRED_LICENSE_PREFIX}* (got ${licenseApprovalId || "none"})`,
    );
  }
}

export function sha256File(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Executa as migrations existentes uma unica vez por DB (tabela de controle propria). */
export function applyMigrations(db: DatabaseSync, migrationsDir: string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS es_ja_applied_migrations (file TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const applied = new Set(
    (
      db.prepare("SELECT file FROM es_ja_applied_migrations").all() as {
        file: string;
      }[]
    ).map((row) => row.file),
  );
  for (const file of readdirSync(migrationsDir).sort()) {
    if (!file.endsWith(".sql") || applied.has(file)) continue;
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO es_ja_applied_migrations (file) VALUES (?)").run(
        file,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // ALTERs repetidos entre migrations (023/025) sao inofensivos: o que
      // falha por duplicidade ja foi aplicado antes (mesmas colunas/indexes).
      if (!message.includes("duplicate column name")) throw error;
      db.prepare(
        "INSERT OR REPLACE INTO es_ja_applied_migrations (file) VALUES (?)",
      ).run(file);
    }
  }
}

function ensureFile(
  db: DatabaseSync,
  row: {
    name: string;
    url: string;
    dir: string;
    fileName: string;
    size: number;
    duration: string | null;
    type: string;
  },
): { id: number; created: boolean } {
  const existing = db
    .prepare("SELECT id_file FROM files WHERE url = ?")
    .get(row.url) as FileRow | undefined;
  if (existing) return { id: existing.id_file, created: false };
  const result = db
    .prepare(
      `INSERT INTO files (name, path, type, url, size, dir, file_name, duration)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.name,
      row.url,
      row.type,
      row.url,
      row.size,
      row.dir,
      row.fileName,
      row.duration,
    );
  return { id: Number(result.lastInsertRowid), created: true };
}

function ensureAlbum(db: DatabaseSync, name: string, language: string): number {
  const existing = db
    .prepare("SELECT id_album FROM albums WHERE name = ? AND id_language = ?")
    .get(name, language) as { id_album: number } | undefined;
  if (existing) return existing.id_album;
  const result = db
    .prepare(
      "INSERT INTO albums (name, id_file_image, color, id_language) VALUES (?, NULL, '#000000', ?)",
    )
    .run(name, language);
  return Number(result.lastInsertRowid);
}

function ensureMusic(
  db: DatabaseSync,
  name: string,
  language: string,
  vocalFileId: number,
  instrumentalFileId: number | null,
): number {
  const existing = db
    .prepare(
      `SELECT m.id_music FROM musics m
       JOIN albums_musics am ON am.id_music = m.id_music
       JOIN albums a ON a.id_album = am.id_album
       WHERE m.name = ? AND m.id_language = ? AND a.id_language = ?`,
    )
    .get(name, language, language) as { id_music: number } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE musics SET id_file_music = ?, id_file_instrumental_music = ? WHERE id_music = ?",
    ).run(vocalFileId, instrumentalFileId, existing.id_music);
    return existing.id_music;
  }
  const result = db
    .prepare(
      `INSERT INTO musics (name, id_file_image, id_file_music, id_file_instrumental_music, id_language)
       VALUES (?, NULL, ?, ?, ?)`,
    )
    .run(name, vocalFileId, instrumentalFileId, language);
  return Number(result.lastInsertRowid);
}

export async function materialize(
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  assertLicense(options.licenseApprovalId);
  const manifestTsv = await readFile(options.manifestPath, "utf8");
  const items: EsJaManifestItem[] = parseManifest(manifestTsv);
  const manifestSha256 = normalizedManifestHash(items);
  const plan = planCatalog(items);

  const db = new DatabaseSync(options.dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, path.join(process.cwd(), "src", "db", "migrations"));

  // linguagens + categoria alvo (idempotente; na VM a categoria 12 ja existe)
  db.prepare(
    "INSERT OR IGNORE INTO languages (id_language, name) VALUES ('es', 'Espanol')",
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO categories (id_category, name, slug, "order", type, id_language)
     VALUES (?, 'CDs Oficiales', 'cds-oficiales-es', 0, 'collection', 'es')`,
  ).run(options.esCategoryId);

  // import de auditoria: idempotencia por manifest hash
  const prior = db
    .prepare(
      "SELECT import_id, status FROM catalog_imports WHERE source_sha256 = ?",
    )
    .get(manifestSha256) as { import_id: string; status: string } | undefined;
  if (prior && prior.status === "published") {
    db.close();
    return {
      importId: prior.import_id,
      status: "published",
      manifestSha256,
      albums: 0,
      musics: 0,
      files: 0,
      lyricsSlides: 0,
      skippedExistingFiles: -1, // sinaliza noop idempotente
    };
  }

  const stagingRoot =
    options.stagingParent ?? path.join(options.mediaRoot, ".es-ja-staging");
  await mkdir(stagingRoot, { recursive: true });
  const staging = await mkdtemp(path.join(stagingRoot, "import-"));
  const promoted: string[] = [];
  let createdFiles = 0;
  let skippedExisting = 0;
  let lyricsSlides = 0;

  try {
    // 1) staging: copiar mp3 approved para fora do media root
    const staged = new Map<
      string,
      { sourceAbs: string; stagedAbs: string; destAbs: string }
    >();
    for (const album of plan.albums) {
      for (const music of album.musics) {
        for (const variant of ["vocal", "instrumental"] as const) {
          const file = music[variant];
          if (!file) continue;
          const destAbs = path.join(
            options.mediaRoot,
            file.url.replace(/^\//u, ""),
          );
          if (existsSync(destAbs)) {
            skippedExisting += 1;
            continue;
          }
          const sourceAbs = path.join(options.sourceDir, file.sourcePath);
          const stagedAbs = path.join(staging, file.driveFileId);
          await copyFile(sourceAbs, stagedAbs);
          staged.set(file.driveFileId, { sourceAbs, stagedAbs, destAbs });
        }
      }
    }

    // 2) transacao SQLite com rollback integral
    db.exec("BEGIN");
    try {
      const importId = `esja-${manifestSha256.slice(0, 12)}`;
      db.prepare(
        `INSERT OR REPLACE INTO catalog_imports
         (import_id, source_sha256, language, status, manifest_path, license_approval_id)
         VALUES (?, ?, 'es', 'staged', ?, ?)`,
      ).run(
        importId,
        manifestSha256,
        options.manifestPath,
        options.licenseApprovalId,
      );

      const insertItem = db.prepare(
        `INSERT OR REPLACE INTO catalog_import_items
         (import_id, drive_file_id, source_path, source_sha256, role, decision, runtime_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const album of plan.albums) {
        const idAlbum = ensureAlbum(db, album.name, "es");
        db.prepare(
          `INSERT OR IGNORE INTO categories_albums (id_category, id_album, name, "order", id_language)
           VALUES (?, ?, NULL, ?, 'es')`,
        ).run(options.esCategoryId, idAlbum, album.order);

        for (const music of album.musics) {
          const vocal = ensureFile(db, {
            name: music.name,
            url: music.vocal.url,
            dir: path.posix.dirname(music.vocal.url),
            fileName: music.vocal.fileName,
            size: stagedSize(staged, music.vocal.driveFileId),
            duration: null,
            type: "music",
          });
          if (vocal.created) createdFiles += 1;
          let instrumentalId: number | null = null;
          if (music.instrumental) {
            const instrumental = ensureFile(db, {
              name: music.name,
              url: music.instrumental.url,
              dir: path.posix.dirname(music.instrumental.url),
              fileName: music.instrumental.fileName,
              size: stagedSize(staged, music.instrumental.driveFileId),
              duration: null,
              type: "music",
            });
            instrumentalId = instrumental.id;
            if (instrumental.created) createdFiles += 1;
          }

          const idMusic = ensureMusic(
            db,
            music.name,
            "es",
            vocal.id,
            instrumentalId,
          );
          db.prepare(
            `INSERT OR IGNORE INTO albums_musics (id_album, id_music, track, id_language)
             VALUES (?, ?, ?, 'es')`,
          ).run(idAlbum, idMusic, music.track);

          // lyrics a partir do .slja (fonte privada, nunca publicada)
          if (music.sljaPath) {
            const sljaAbs = path.join(options.sourceDir, music.sljaPath);
            if (existsSync(sljaAbs)) {
              const archive = await parseSlja(sljaAbs);
              db.prepare(
                "DELETE FROM lyrics WHERE id_music = ? AND id_language = 'es'",
              ).run(idMusic);
              const insertLyric = db.prepare(
                `INSERT INTO lyrics
                 (id_music, lyric, aux_lyric, id_file_image, time, instrumental_time, show_slide, "order", id_language)
                 VALUES (?, ?, ?, NULL, ?, '00:00:00', 1, ?, 'es')`,
              );
              for (const slide of archive.slides) {
                insertLyric.run(
                  idMusic,
                  slide.lyric,
                  slide.auxiliaryLyric,
                  slide.time,
                  slide.order,
                );
                lyricsSlides += 1;
              }
            }
          }

          for (const item of [music.vocal, music.instrumental].filter(
            (f) => f !== null,
          )) {
            insertItem.run(
              importId,
              item.driveFileId,
              item.sourcePath,
              null,
              item.variant,
              "approved",
              item.url,
            );
          }
        }
      }

      db.prepare(
        "UPDATE catalog_imports SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE import_id = ?",
      ).run(`esja-${manifestSha256.slice(0, 12)}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    // 3) promocao atomica: rename staging -> media (fora da transacao SQL;
    //    falha aqui deixa staging para tras, reexecucao recupera)
    for (const { stagedAbs, destAbs } of staged.values()) {
      await mkdir(path.dirname(destAbs), { recursive: true });
      await rename(stagedAbs, destAbs);
      promoted.push(destAbs);
    }
  } catch (error) {
    // desfaz promocoes parciais e mantem DB consistente (rollback ja feito se falhou no SQL)
    await Promise.allSettled(
      promoted.map((dest) =>
        rename(dest, path.join(staging, path.basename(dest))),
      ),
    );
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    db.close();
  }

  return {
    importId: `esja-${manifestSha256.slice(0, 12)}`,
    status: "published",
    manifestSha256,
    albums: plan.albums.length,
    musics: plan.musicCount,
    files: createdFiles,
    lyricsSlides,
    skippedExistingFiles: skippedExisting,
  };
}

function stagedSize(
  staged: Map<
    string,
    { sourceAbs: string; stagedAbs: string; destAbs: string }
  >,
  driveFileId: string,
): number {
  const entry = staged.get(driveFileId);
  if (!entry) return 0; // ja existia no destino — tamanho e best-effort aqui
  try {
    return readFileSync(entry.stagedAbs).length;
  } catch {
    return 0;
  }
}
