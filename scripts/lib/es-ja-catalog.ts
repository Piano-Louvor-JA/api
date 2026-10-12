import path from "node:path";
import type { EsJaManifestItem } from "./es-ja-manifest.js";

/**
 * Planejamento puro da materializacao do catalogo ES-JA.
 * Sem IO: transforma itens do manifest em um plano deterministico que o
 * executor (es-ja-materialize) valida e aplica no SQLite + filesystem.
 *
 * Convencoes herdadas do catalogo existente (VM):
 * - audio em `musics/es/<album>/<arquivo>.mp3`
 * - um album por colecao JA ("12. JA 2003 - Enséñame a Servir")
 * - musicas ligadas ao album com track sequencial por ordem alfabetica
 * - vocal = (audio-cantado), instrumental = (audio-pista|audio-instrumental)
 */

export type PlannedVariant = "vocal" | "instrumental";

export type PlannedFile = {
  driveFileId: string;
  sourcePath: string; // caminho relativo dentro do source dir privado
  variant: PlannedVariant;
  musicName: string;
  fileName: string; // nome final seguro (basename)
  url: string; // /musics/es/<albumSlug>/<fileName>
};

export type PlannedMusic = {
  key: string; // nome da musica (unico por album)
  name: string;
  track: number;
  vocal: PlannedFile | null;
  instrumental: PlannedFile | null;
  sljaPath: string | null; // fonte .slja (letra/slides), nunca publicado
};

export type PlannedAlbum = {
  collectionDir: string; // "12. JA 2003 - Enséñame a Servir"
  name: string; // nome de exibicao (sem prefixo numerico)
  order: number; // numero da colecao
  year: number | null; // primeiro ano do tema ("JA 2022 y 2023" -> 2022)
  albumDir: string; // segmento de path seguro
  coverUrl: string | null; // /covers/es/<year>.jpg quando year conhecido
  musics: PlannedMusic[];
};

export type CatalogPlan = {
  albums: PlannedAlbum[];
  fileCount: number;
  musicCount: number;
};

const VARIANT_SUFFIXES: ReadonlyArray<[PlannedVariant, string]> = [
  ["vocal", "(audio-cantado)"],
  ["instrumental", "(audio-pista)"],
  ["instrumental", "(audio-instrumental)"],
];

/** Remove caracteres perigosos mantendo acentos/espacos (convencao VM usa nomes literais). */
export function sanitizeSegment(segment: string): string {
  const cleaned = segment
    .replaceAll("\0", "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: limpeza explicita de controle
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.includes("/"))
    throw new Error(`unsafe path segment: ${JSON.stringify(segment)}`);
  return cleaned;
}

export function collectionMeta(collectionDir: string): {
  name: string;
  order: number;
  albumDir: string;
} {
  const match = /^(\d+)\.\s*(.+)$/u.exec(collectionDir);
  const name = (match?.[2] ?? collectionDir).trim();
  const order = Number.parseInt(match?.[1] ?? "0", 10) || 0;
  return { name, order, albumDir: sanitizeSegment(collectionDir) };
}

/** "JA 2022 y 2023 - Yo Voy" -> 2022 (primeiro ano do tema); null se nao ha ano. */
export function collectionYear(collectionDir: string): number | null {
  const match = /(?:^|\s)JA\s+(\d{4})/u.exec(collectionDir);
  return match ? Number.parseInt(match[1], 10) : null;
}

function musicNameFrom(fileName: string): {
  name: string;
  variant: PlannedVariant;
} {
  const stem = fileName.replace(/\.mp3$/u, "").trim();
  for (const [variant, suffix] of VARIANT_SUFFIXES) {
    if (stem.toLowerCase().endsWith(suffix.toLowerCase())) {
      return { name: stem.slice(0, -suffix.length).trim(), variant };
    }
  }
  throw new Error(`approved mp3 without known variant suffix: ${fileName}`);
}

/**
 * Chave canônica para agrupar vocal/pista/slja da mesma música quando a
 * grafia diverge entre arquivos (acento, case, pontuação):
 * "Enseñame a Servir" ≡ "Enséñame a Servir" ≡ "VEN, Espíritu Santo".
 * NFKD + remove diacríticos, casefold, remove não-alfanuméricos.
 */
export function musicKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

function fileNameFrom(relativePath: string): string {
  return sanitizeSegment(path.posix.basename(relativePath));
}

/**
 * Agrupa itens approved+slja em albuns/musicas. Rejeita:
 * - mp3 approved sem variante reconhecida (nao deveria acontecer: classifier marca unknown-mp3)
 * - musicas sem vocal (catalogo JA sempre tem audio-cantado)
 */
export function planCatalog(items: readonly EsJaManifestItem[]): CatalogPlan {
  type Accumulator = {
    musics: Map<string, PlannedMusic>;
    order: string[]; // chaves na ordem alfabetica do arquivo vocal
  };
  const albums = new Map<string, Accumulator>();

  for (const item of items) {
    const collectionDir = path.posix.dirname(item.relativePath).split("/")[0];
    if (!collectionDir || collectionDir === ".")
      throw new Error(
        `manifest item outside collection dir: ${item.relativePath}`,
      );
    let album = albums.get(collectionDir);
    if (!album) {
      album = { musics: new Map(), order: [] };
      albums.set(collectionDir, album);
    }

    if (item.decision === "source-only" && item.role === "slja") {
      const stem = path.posix
        .basename(item.relativePath)
        .replace(/\.slja$/u, "");
      const key = musicKey(stem.trim());
      let music = album.musics.get(key);
      if (!music) {
        music = {
          key,
          name: key,
          track: 0,
          vocal: null,
          instrumental: null,
          sljaPath: item.relativePath,
        };
        album.musics.set(key, music);
      } else if (music.sljaPath && music.sljaPath !== item.relativePath) {
        throw new Error(
          `duplicate slja for music "${key}" in ${collectionDir}`,
        );
      } else {
        music.sljaPath = item.relativePath;
      }
      continue;
    }
    if (item.decision !== "approved") continue;

    const fileName = fileNameFrom(item.relativePath);
    const { name, variant } = musicNameFrom(fileName);
    const albumDir = collectionMeta(collectionDir).albumDir;
    const planned: PlannedFile = {
      driveFileId: item.driveFileId,
      sourcePath: item.relativePath,
      variant,
      musicName: name,
      fileName,
      url: `/musics/es/${albumDir}/${fileName}`,
    };

    const key = musicKey(name);
    let music = album.musics.get(key);
    if (!music) {
      music = {
        key,
        name,
        track: 0,
        vocal: null,
        instrumental: null,
        sljaPath: null,
      };
      album.musics.set(key, music);
      album.order.push(key);
    }
    if (music[variant]) {
      throw new Error(
        `duplicate ${variant} for music "${name}" in ${collectionDir}: ${item.relativePath}`,
      );
    }
    music[variant] = planned;
    if (!album.order.includes(key)) album.order.push(key);
  }

  const plannedAlbums: PlannedAlbum[] = [];
  let musicCount = 0;
  let fileCount = 0;
  for (const [collectionDir, album] of albums) {
    const meta = collectionMeta(collectionDir);
    const year = collectionYear(collectionDir);
    // validar: toda musica precisa de vocal; track = ordem alfabetica do nome
    const musics = [...album.musics.values()]
      .sort((a, b) => a.key.localeCompare(b.key, "es"))
      .map((music, index) => {
        // track sem audio na fonte (ex.: titulo JA 2003 "Enseñame a Servir"
        // existe so como .slja) entra como letra-only; nao aborta o album.
        musicCount += 1;
        fileCount += 1 + (music.instrumental ? 1 : 0);
        return { ...music, track: index + 1 };
      });
    if (musics.length === 0) continue;
    plannedAlbums.push({
      collectionDir,
      ...meta,
      year,
      coverUrl: year ? `/covers/es/${year}.jpg` : null,
      musics,
    });
  }

  plannedAlbums.sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name, "es"),
  );
  return { albums: plannedAlbums, fileCount, musicCount };
}
