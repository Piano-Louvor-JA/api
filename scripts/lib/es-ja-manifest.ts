import { createHash } from "node:crypto";
import path from "node:path";

export type EsJaDecision = "approved" | "excluded" | "rejected" | "source-only";
export type EsJaRole = "vocal" | "instrumental" | "slja" | "presentation" | "video" | "legacy-audio" | "unknown-mp3";

export type EsJaManifestItem = {
  driveFileId: string;
  relativePath: string;
  role: EsJaRole;
  decision: EsJaDecision;
};

const ALBUM_PATH = /^\d+\. JA \d{4}(?: y \d{4})? - [^/]+\/.+/u;
const EXCLUDED_EXTENSIONS = new Set([".ppt", ".ppsx"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".wmv"]);
const LEGACY_AUDIO_EXTENSIONS = new Set([".wma"]);

export function classifyPath(relativePath: string): Pick<EsJaManifestItem, "role" | "decision"> {
  const filename = path.posix.basename(relativePath).toLocaleLowerCase("es");
  const extension = path.posix.extname(filename);
  if (extension === ".slja") return { role: "slja", decision: "source-only" };
  if (EXCLUDED_EXTENSIONS.has(extension)) return { role: "presentation", decision: "excluded" };
  if (VIDEO_EXTENSIONS.has(extension)) return { role: "video", decision: "excluded" };
  if (LEGACY_AUDIO_EXTENSIONS.has(extension)) return { role: "legacy-audio", decision: "excluded" };
  if (extension !== ".mp3") throw new Error(`unsupported extension: ${extension || "none"}`);
  if (filename.endsWith("(audio-cantado).mp3")) return { role: "vocal", decision: "approved" };
  if (filename.endsWith("(audio-pista).mp3") || filename.endsWith("(audio-instrumental).mp3")) {
    return { role: "instrumental", decision: "approved" };
  }
  return { role: "unknown-mp3", decision: "rejected" };
}

function assertSafePath(relativePath: string): void {
  if (!relativePath || relativePath.includes("\0") || path.posix.isAbsolute(relativePath)) {
    throw new Error("unsafe path");
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith("../") || normalized !== relativePath || !ALBUM_PATH.test(relativePath)) {
    throw new Error("unsafe path");
  }
}

export function parseManifest(tsv: string): EsJaManifestItem[] {
  const seen = new Map<string, string>();
  const items = tsv.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    const columns = line.split("\t");
    if (columns.length !== 2 || !columns[0] || !columns[1]) throw new Error(`invalid manifest row ${index + 1}`);
    const [driveFileId, relativePath] = columns;
    assertSafePath(relativePath);
    const prior = seen.get(driveFileId);
    if (prior && prior !== relativePath) throw new Error(`duplicate Drive ID: ${driveFileId}`);
    seen.set(driveFileId, relativePath);
    return { driveFileId, relativePath, ...classifyPath(relativePath) };
  });
  return items.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "es") || a.driveFileId.localeCompare(b.driveFileId));
}

export function normalizedManifestHash(items: readonly EsJaManifestItem[]): string {
  const normalized = items.map(({ driveFileId, relativePath }) => `${driveFileId}\t${relativePath}`).join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}
