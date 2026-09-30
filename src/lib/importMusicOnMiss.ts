/**
 * Fetch on-miss: importa uma unica musica direto do upstream
 * (api.louvorja.com.br /json_db/music_{id}) para o SQLite local.
 *
 * Usado pela rota /json_db/music_{id} quando a musica nao existe localmente
 * (hino novo publicado pelo Mayco antes do cron diário reconstruir).
 *
 * Reutiliza o mesmo padrão do import-upstream.ts: INSERT idempotente via
 * url UNIQUE em files, DELETE+INSERT de lyrics por musica.
 */

import type Database from "better-sqlite3";
import { fetchUpstream, UpstreamError } from "./upstream.js";

const UPSTREAM = process.env.UPSTREAM_API ?? "https://api.louvorja.workers.dev";

/** Flag de controle: desativa o fetch on-miss (default: ligado). */
export const ON_MISS_ENABLED = (process.env.ON_MISS_FETCH ?? "on") !== "off";

interface UpstreamLyric {
  id_lyric?: number;
  lyric?: string;
  aux_lyric?: string | null;
  url_image?: string;
  image_position?: number;
  time?: string;
  instrumental_time?: string;
  show_slide?: boolean;
  order?: number;
}

interface UpstreamMusicDetail {
  id_music?: number;
  name?: string;
  url_image?: string;
  image_position?: number;
  url_music?: string;
  duration?: string;
  url_instrumental_music?: string;
  instrumental_duration?: string;
  lyric?: UpstreamLyric[];
  error?: string;
}

function parseFilePath(fullPath: string): { dir: string; file_name: string } {
  const clean = fullPath.replace(/^https?:\/\/[^/]+\//, "");
  const parts = clean.split("/");
  const file_name = parts.pop() ?? clean;
  const dir = parts.join("/");
  return { dir, file_name };
}

/**
 * Busca e importa a musica `idMusic` do upstream.
 * @returns true se importada (ou já existente), false se upstream não tem.
 */
export async function importMusicById(
  idMusic: number,
  db: Database.Database,
  lang = "pt",
): Promise<boolean> {
  // Já existe? Idempotente.
  const existing = db
    .prepare("SELECT id_music FROM musics WHERE id_music = ?")
    .get(idMusic) as { id_music: number } | undefined;
  if (existing) return true;

  let detail: UpstreamMusicDetail | null = null;
  try {
    const res = await fetchUpstream(`${UPSTREAM}/json_db/music_${idMusic}`);
    detail = (await res.json()) as UpstreamMusicDetail;
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 404) return false;
    // Erro de rede/5xx: repropaga — chamador decide (não é "não existe").
    throw e;
  }
  if (!detail || detail.error || !detail.name) return false;

  const insertFile = db.prepare(`
    INSERT INTO files (name, path, type, url, size, dir, file_name, duration, image_position)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(url) DO NOTHING
  `);
  const findFileByUrl = db.prepare("SELECT id_file FROM files WHERE url = ?");
  const upsertMusic = db.prepare(`
    INSERT OR REPLACE INTO musics (id_music, name, id_file_image, id_file_music, id_file_instrumental_music, id_language)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const deleteLyrics = db.prepare("DELETE FROM lyrics WHERE id_music = ?");
  const insertLyric = db.prepare(`
    INSERT OR REPLACE INTO lyrics (id_lyric, id_music, lyric, aux_lyric, id_file_image, time, instrumental_time, show_slide, "order", id_language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertFile = (
    url: string,
    type: "image" | "audio",
    duration: string | null,
    imagePosition: number | null,
  ): number | null => {
    const existingFile = findFileByUrl.get(url) as
      | { id_file: number }
      | undefined;
    if (existingFile) return existingFile.id_file;
    const { dir, file_name } = parseFilePath(url);
    const result = insertFile.run(
      file_name,
      url,
      type,
      url,
      dir,
      file_name,
      duration,
      imagePosition,
    );
    return Number(result.lastInsertRowid);
  };

  const imageFileId = detail.url_image
    ? upsertFile(detail.url_image, "image", null, detail.image_position ?? null)
    : null;
  const musicFileId = detail.url_music
    ? upsertFile(detail.url_music, "audio", detail.duration ?? null, null)
    : null;
  const instrumentalFileId = detail.url_instrumental_music
    ? upsertFile(
        detail.url_instrumental_music,
        "audio",
        detail.instrumental_duration ?? null,
        null,
      )
    : null;

  upsertMusic.run(
    idMusic,
    detail.name,
    imageFileId,
    musicFileId,
    instrumentalFileId,
    lang,
  );

  if (detail.lyric && detail.lyric.length > 0) {
    deleteLyrics.run(idMusic);
    for (const l of detail.lyric) {
      const lyricImageFileId = l.url_image
        ? upsertFile(l.url_image, "image", null, l.image_position ?? null)
        : null;
      insertLyric.run(
        l.id_lyric ?? null,
        idMusic,
        l.lyric || "",
        l.aux_lyric ?? null,
        lyricImageFileId,
        l.time || "00:00:00",
        l.instrumental_time || "00:00:00",
        l.show_slide ? 1 : 0,
        l.order ?? 0,
        lang,
      );
    }
  }

  return true;
}
