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

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { planCatalog } from "./es-ja-catalog.js";
import {
  type EsJaManifestItem,
  normalizedManifestHash,
  parseManifest,
} from "./es-ja-manifest.js";
import { parseSlja, type SljaArchive } from "./es-ja-slja.js";

const execFileAsync = promisify(execFile);

/** ffprobe local; lança erro explícito se binário ausente (sem dep npm). */
async function probeDurationFfprobe(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { timeout: 30_000 },
  );
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe sem duração válida: ${filePath}`);
  }
  return seconds;
}

/** 294.879125s -> "00:04:55" (round-half-up determinístico, igual shape PT). */
export function secondsToHms(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/** nome seguro p/ extração: basename, sem path/absolute/NUL. */
export function safeImageName(name: string): string | null {
  if (!name || name.includes("\0")) return null;
  const base = path.posix.basename(name.replaceAll("\\", "/"));
  if (!base || base === "." || base === ".." || base === "/") return null;
  if (!/^[\w.\- À-ÿ()]+$/.test(base)) return null;
  return base;
}

export type MaterializeOptions = {
  manifestPath: string;
  sourceDir: string; // raiz privada com as colecoes JA
  dbPath: string;
  mediaRoot: string; // raiz onde vive musics/
  licenseApprovalId: string;
  esCategoryId: number; // categoria "CDs Oficiais" ES (12 na VM)
  stagingParent?: string; // default: mediaRoot/.es-ja-staging
  coversDir?: string; // default: <sourceDir>/covers (arquivos <year>.jpg)
  /** Afere duração (segundos) do arquivo de áudio; default = ffprobe local. */
  probeDuration?: (filePath: string) => Promise<number>;
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

/** Executa APENAS as migrations do import ES-JA (idempotentes por IF NOT
 *  EXISTS) sobre DB ja migrado pelo runner oficial da API. Rodar todo o dir
 *  falha: staging aplicou 023_custom_password_reset antes de 023_offline_sync
 *  e a ordem lexicografica quebraria tabelas custom_* existentes. */
export function applyMigrations(db: DatabaseSync, migrationsDir: string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS es_ja_applied_migrations (file TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const ES_JA_MIGRATIONS = [
    "001_languages.sql",
    "002_files.sql",
    "003_albums.sql",
    "004_musics.sql",
    "005_lyrics.sql",
    "006_albums_musics.sql",
    "007_categories.sql",
    "008_categories_albums.sql",
    "030_es_ja_catalog_imports.sql",
  ];
  const applied = new Set(
    (
      db.prepare("SELECT file FROM es_ja_applied_migrations").all() as {
        file: string;
      }[]
    ).map((row) => row.file),
  );
  for (const file of ES_JA_MIGRATIONS) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO es_ja_applied_migrations (file) VALUES (?)").run(
        file,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate column name")) throw error;
      db.prepare(
        "INSERT OR REPLACE INTO es_ja_applied_migrations (file) VALUES (?)",
      ).run(file);
    }
  }
  const columns: Record<string, Record<string, string>> = {
    files: {
      dir: "TEXT",
      file_name: "TEXT",
      duration: "TEXT",
      version: "INTEGER",
      image_position: "INTEGER",
    },
    albums_musics: { track: "INTEGER", id_language: "TEXT" },
    categories_albums: { name: "TEXT", order: "INTEGER", id_language: "TEXT" },
  };
  for (const [table, additions] of Object.entries(columns)) {
    const existing = new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((row) => row.name),
    );
    for (const [column, type] of Object.entries(additions)) {
      if (!existing.has(column))
        db.exec(`ALTER TABLE ${table} ADD COLUMN "${column}" ${type}`);
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
  if (existing) {
    // backfill: duração aferida depois preenche NULL de import antigo
    if (row.duration !== null) {
      db.prepare(
        "UPDATE files SET duration = ? WHERE id_file = ? AND duration IS NULL",
      ).run(row.duration, existing.id_file);
    }
    return { id: existing.id_file, created: false };
  }
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
  albumId: number,
  vocalFileId: number | null,
  instrumentalFileId: number | null,
): number {
  const existing = db
    .prepare(
      `SELECT m.id_music FROM musics m
       JOIN albums_musics am ON am.id_music = m.id_music
       JOIN albums a ON a.id_album = am.id_album
       WHERE m.name = ? AND m.id_language = ? AND a.id_language = ? AND a.id_album = ?`,
    )
    .get(name, language, language, albumId) as { id_music: number } | undefined;
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
    `INSERT OR IGNORE INTO categories (id_category, name, id_language)
     VALUES (?, 'CDs Oficiales', 'es')`,
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
    // 1) staging: copiar mp3 approved + covers para fora do media root
    const staged = new Map<
      string,
      { sourceAbs: string; stagedAbs: string; destAbs: string }
    >();
    const coversDir =
      options.coversDir ?? path.join(options.sourceDir, "covers");
    const stagedCovers = new Map<
      string,
      { stagedAbs: string; destAbs: string }
    >();
    // imagens de slides extraídas dos .slja: dedup por nome no run
    const stagedImages = new Map<
      string,
      { stagedAbs: string; destAbs: string; imagePosition: number | null }
    >();
    const seenCoverYears = new Set<number>();
    const coverYearsAvailable = new Set<number>();
    for (const album of plan.albums) {
      if (!album.year || seenCoverYears.has(album.year)) continue;
      seenCoverYears.add(album.year);
      const sourceCover = path.join(coversDir, `${album.year}.jpg`);
      if (!existsSync(sourceCover)) continue; // cover ausente: album sem capa
      const destAbs = path.join(
        options.mediaRoot,
        album.coverUrl?.replace(/^\//u, "") ?? "",
      );
      if (existsSync(destAbs)) {
        coverYearsAvailable.add(album.year); // ja promovido em run anterior
        skippedExisting += 1;
        continue;
      }
      const stagedAbs = path.join(staging, `cover-${album.year}.jpg`);
      await copyFile(sourceCover, stagedAbs);
      stagedCovers.set(String(album.year), { stagedAbs, destAbs });
      coverYearsAvailable.add(album.year);
    }
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

        // capa: file image + id_file_image (shape PT: path=url=/covers/es/<ano>.jpg)
        // somente quando o jpg existe (staged neste run ou ja promovido antes)
        if (
          album.coverUrl &&
          album.year &&
          coverYearsAvailable.has(album.year)
        ) {
          const cover = ensureFile(db, {
            name: path.posix.basename(album.coverUrl),
            url: album.coverUrl,
            dir: path.posix.dirname(album.coverUrl),
            fileName: path.posix.basename(album.coverUrl),
            size: stagedSize2(stagedCovers, String(album.year)),
            duration: null,
            type: "image",
          });
          if (cover.created) createdFiles += 1;
          db.prepare(
            "UPDATE albums SET id_file_image = ? WHERE id_album = ? AND (id_file_image IS NULL OR id_file_image != ?)",
          ).run(cover.id, idAlbum, cover.id);
        }

        for (const music of album.musics) {
          // probe de duração: staged se disponível (fonte), senão destino já promovido
          const probe = options.probeDuration ?? probeDurationFfprobe;
          const durationOf = async (
            file: { driveFileId: string; url: string } | null,
          ): Promise<string | null> => {
            if (!file) return null;
            const stagedEntry = staged.get(file.driveFileId);
            const abs =
              stagedEntry?.stagedAbs ??
              path.join(options.mediaRoot, file.url.replace(/^\//u, ""));
            if (!existsSync(abs)) return null; // áudio ausente: duração fica NULL
            try {
              return secondsToHms(await probe(abs));
            } catch {
              return null; // ffprobe falhou p/ este arquivo: não aborta o import
            }
          };

          // letra-only (vocal null): sem file de audio, id_file_music NULL
          const vocalDuration = await durationOf(music.vocal);
          const vocal = music.vocal
            ? ensureFile(db, {
                name: music.name,
                url: music.vocal.url,
                dir: path.posix.dirname(music.vocal.url),
                fileName: music.vocal.fileName,
                size: stagedSize(staged, music.vocal.driveFileId),
                duration: vocalDuration,
                type: "music",
              })
            : null;
          if (vocal?.created) createdFiles += 1;
          let instrumentalId: number | null = null;
          if (music.instrumental) {
            const instrDuration = await durationOf(music.instrumental);
            const instrumental = ensureFile(db, {
              name: music.name,
              url: music.instrumental.url,
              dir: path.posix.dirname(music.instrumental.url),
              fileName: music.instrumental.fileName,
              size: stagedSize(staged, music.instrumental.driveFileId),
              duration: instrDuration,
              type: "music",
            });
            instrumentalId = instrumental.id;
            if (instrumental.created) createdFiles += 1;
          }

          const idMusic = ensureMusic(
            db,
            music.name,
            "es",
            idAlbum,
            vocal?.id ?? null,
            instrumentalId,
          );
          db.prepare(
            `INSERT OR IGNORE INTO albums_musics (id_album, id_music, track, id_language)
             VALUES (?, ?, ?, 'es')`,
          ).run(idAlbum, idMusic, music.track);

          // lyrics a partir do .slja (fonte privada, nunca publicada):
          // tempo real por slide, imagem extraída do ZIP, convenção PT
          if (music.sljaPath) {
            const sljaAbs = path.join(options.sourceDir, music.sljaPath);
            if (existsSync(sljaAbs)) {
              const archive = await parseSlja(sljaAbs);
              db.prepare(
                "DELETE FROM lyrics WHERE id_music = ? AND id_language = 'es'",
              ).run(idMusic);

              // imagens: extrai p/ staging (1ª vez) e resolve id_file_image por slide
              const slideImageIds = new Map<string, number>();
              let firstImageId: number | null = null;
              for (const slide of archive.slides) {
                if (!slide.imageName) continue;
                const safe = safeImageName(slide.imageName);
                if (!safe) continue; // nome inválido: slide fica sem imagem
                const buffer = archive.images.get(slide.imageName);
                if (!buffer) continue; // ZIP sem a imagem: sem vínculo
                if (!slideImageIds.has(safe)) {
                  const url = `/images/es/${safe}`;
                  const destAbs = path.join(
                    options.mediaRoot,
                    url.replace(/^\//u, ""),
                  );
                  if (!existsSync(destAbs) && !stagedImages.has(safe)) {
                    const stagedAbs = path.join(staging, `img-${safe}`);
                    await writeFile(stagedAbs, buffer);
                    stagedImages.set(safe, {
                      stagedAbs,
                      destAbs,
                      imagePosition: slide.imagePosition,
                    });
                  }
                  const file = ensureFile(db, {
                    name: safe,
                    url,
                    dir: "/images/es",
                    fileName: safe,
                    size: buffer.length,
                    duration: null,
                    type: "image",
                  });
                  if (file.created) createdFiles += 1;
                  slideImageIds.set(safe, file.id);
                }
                const fileId = slideImageIds.get(safe) ?? null;
                if (fileId !== null && firstImageId === null)
                  firstImageId = fileId;
              }

              const insertLyric = db.prepare(
                `INSERT INTO lyrics
                 (id_music, lyric, aux_lyric, id_file_image, time, instrumental_time, show_slide, "order", id_language)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'es')`,
              );
              for (const slide of archive.slides) {
                const safe = slide.imageName
                  ? safeImageName(slide.imageName)
                  : null;
                const imageId = safe ? (slideImageIds.get(safe) ?? null) : null;
                const hasInstrumental = instrumentalId !== null;
                insertLyric.run(
                  idMusic,
                  slide.lyric,
                  slide.auxiliaryLyric,
                  imageId,
                  slide.time,
                  hasInstrumental ? slide.time : "00:00:00", // convenção PT: cópia quando há pista
                  slide.lyric.trim().length === 0 ? 0 : 1, // slide vazio → não exibe
                  slide.order,
                );
                lyricsSlides += 1;
              }

              // capa da música = primeira imagem válida dos slides
              if (firstImageId !== null) {
                db.prepare(
                  "UPDATE musics SET id_file_image = ? WHERE id_music = ? AND id_file_image IS NULL",
                ).run(firstImageId, idMusic);
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
      // Promote files before committing: a failed rename must roll back SQL.
      for (const { stagedAbs, destAbs } of stagedCovers.values()) {
        await mkdir(path.dirname(destAbs), { recursive: true });
        await rename(stagedAbs, destAbs);
        promoted.push(destAbs);
      }
      for (const { stagedAbs, destAbs } of staged.values()) {
        await mkdir(path.dirname(destAbs), { recursive: true });
        await rename(stagedAbs, destAbs);
        promoted.push(destAbs);
      }
      for (const [
        safe,
        { stagedAbs, destAbs, imagePosition },
      ] of stagedImages) {
        await mkdir(path.dirname(destAbs), { recursive: true });
        await rename(stagedAbs, destAbs);
        promoted.push(destAbs);
        // image_position vive em files; atualiza dentro da mesma transação.
        db.prepare(
          "UPDATE files SET image_position = ? WHERE url = ? AND (image_position IS NULL OR image_position != ?)",
        ).run(imagePosition, `/images/es/${safe}`, imagePosition);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
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

function stagedSize2(
  staged: Map<string, { stagedAbs: string }>,
  key: string,
): number {
  const entry = staged.get(key);
  if (!entry) return 0;
  try {
    return readFileSync(entry.stagedAbs).length;
  } catch {
    return 0;
  }
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
