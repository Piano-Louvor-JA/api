// HOTFIX t_b3824cb7: leitura dos tarballs multilíngues
// data/json_db/bible_multilingue/{lang}_bible_chapters.tar.gz.
//
// Node puro (zlib + parse de membros tar em memória) — sem depender do
// binário `tar` no container. Tar completo ~1-2 MB por idioma comprimido;
// extração por entry com índice, cacheando offsets sob invalidação por
// mtime+size do tarball (trocar o tarball invalida o índice).
//
// Memória: índice pequeno (offsets), entry extraído sob demanda. Justificativa
// da escolha "índice + extração sob demanda" vs "tar inteiro em RAM no boot":
// 15 idiomas × ~17k entradas só de metadados (~1 MB), payload lido apenas do
// capítulo pedido — memória residente mínima e boot instantâneo.

import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";

const MULTI_VERSION_TO_LANG: ReadonlyMap<string, string> = new Map([
  ["100", "en"],
  ["101", "fr"],
  ["102", "ru"],
  ["103", "uk"],
  ["104", "it"],
  ["105", "nl"],
  ["106", "pl"],
  ["107", "tr"],
  ["108", "ja"],
  ["109", "ko"],
  ["110", "zh"],
  ["111", "ar"],
  ["112", "hi"],
]);

/** Idiomas que têm tarball multilíngue (falso → upstream). */
export const MULTILINGUE_LANGS: ReadonlySet<string> = new Set(
  MULTI_VERSION_TO_LANG.values(),
);

export function multilingueLangForVersion(version: string): string | null {
  return MULTI_VERSION_TO_LANG.get(version) ?? null;
}

interface TarIndex {
  mtimeMs: number;
  size: number;
  // name -> { offset, size } do membro DENTRO do buffer descomprimido
  entries: Map<string, { offset: number; size: number }>;
  gunzipped: Buffer;
}

/** Resolve o diretório dos tarballs (env para testes/fixtures limpos). */
export function resolveBibleTarballDir(): string {
  return (
    process.env.BIBLE_TARBALL_DIR ||
    join(process.cwd(), "data", "json_db", "bible_multilingue")
  );
}

const indexCache = new Map<string, TarIndex>();

const HEADER_SIZE = 512;

/** tar string field: trim NULs/spaces. */
function tarStr(buf: Buffer, off: number, len: number): string {
  return buf
    .toString("utf-8", off, off + len)
    .replace(/\0+$/, "")
    .trim();
}

function buildIndex(tarPath: string): TarIndex {
  const st = statSync(tarPath);
  const gunzipped = gunzipSync(readFileSync(tarPath));
  const entries = new Map<string, { offset: number; size: number }>();
  let off = 0;
  while (off + HEADER_SIZE <= gunzipped.length) {
    const name = tarStr(gunzipped, off, 100);
    if (!name) break; // bloco de fim (dois blocos NUL)
    const sizeField = tarStr(gunzipped, off + 124, 12);
    const size = Number.parseInt(sizeField, 8) || 0;
    const dataOff = off + HEADER_SIZE;
    entries.set(basename(name), { offset: dataOff, size });
    // membros alinhados a 512; bloco seguinte após header+data
    off = dataOff + Math.ceil(size / HEADER_SIZE) * HEADER_SIZE;
  }
  return { mtimeMs: st.mtimeMs, size: st.size, entries, gunzipped };
}

function getIndex(lang: string): TarIndex | null {
  const tarPath = `${resolveBibleTarballDir()}/${lang}_bible_chapters.tar.gz`;
  let cached = indexCache.get(lang);
  try {
    const st = statSync(tarPath);
    if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      cached = buildIndex(tarPath);
      indexCache.set(lang, cached);
    }
    return cached;
  } catch {
    return null;
  }
}

/**
 * Extrai e retorna o conteúdo JSON (string) de um membro do tarball do
 * idioma, ou null se o tarball ou o membro não existir.
 */
export function readBibleChapterEntry(
  lang: string,
  entryName: string,
): string | null {
  const idx = getIndex(lang);
  if (!idx) return null;
  const entry = idx.entries.get(entryName);
  if (!entry) return null;
  return idx.gunzipped.toString(
    "utf-8",
    entry.offset,
    entry.offset + entry.size,
  );
}

/**
 * Assinatura de invalidação do cache de DISCO (data/bible_cache/{key}.json)
 * do tarball de um idioma: mtime+size atuais. Trocar o tarball muda a
 * assinatura e o handler invalida o arquivo de cache velho.
 */
export function tarballStamp(lang: string): string | null {
  try {
    const st = statSync(
      `${resolveBibleTarballDir()}/${lang}_bible_chapters.tar.gz`,
    );
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/** Reset do índice (testes). */
export function _resetTarballIndexForTest(): void {
  indexCache.clear();
}
