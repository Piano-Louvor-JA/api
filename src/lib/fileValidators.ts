/**
 * Validadores HTTP do /file: ETag forte (SHA-256 do conteúdo) + Last-Modified.
 * Clientes que guardam mídia offline (parceiros, APK) descobrem um arquivo
 * corrigido no mesmo endereço com If-None-Match e recebem 304 quando nada mudou.
 */

import { createHash } from "node:crypto";

const MAX_ENTRIES = 20_000;
/** Hash por (caminho, mtime, tamanho): arquivo trocado no disco gera chave nova. */
const etagCache = new Map<string, string>();

export function contentEtag(
  path: string,
  mtimeMs: number,
  size: number,
  content: Buffer,
): string {
  const key = `${path}:${mtimeMs}:${size}`;
  let etag = etagCache.get(key);
  if (!etag) {
    if (etagCache.size >= MAX_ENTRIES) etagCache.clear();
    etag = `"${createHash("sha256").update(content).digest("hex").slice(0, 32)}"`;
    etagCache.set(key, etag);
  }
  return etag;
}

/** RFC 9110: If-None-Match tem precedência; If-Modified-Since só sem ele. */
export function isNotModified(
  ifNoneMatch: string | undefined,
  ifModifiedSince: string | undefined,
  etag: string,
  mtime: Date,
): boolean {
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() === "*") return true;
    return ifNoneMatch
      .split(",")
      .map((tag) => tag.trim().replace(/^W\//, ""))
      .includes(etag);
  }
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    if (Number.isNaN(since)) return false;
    return Math.floor(mtime.getTime() / 1000) <= Math.floor(since / 1000);
  }
  return false;
}

export function validatorHeaders(
  etag: string,
  mtime: Date,
): Record<string, string> {
  return {
    ETag: etag,
    "Last-Modified": mtime.toUTCString(),
    "Cache-Control": "no-cache",
  };
}
