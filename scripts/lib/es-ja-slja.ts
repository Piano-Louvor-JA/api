import { readFile } from "node:fs/promises";
import yauzl from "yauzl";

export type SljaSlide = {
  lyric: string;
  auxiliaryLyric: string | null;
  type: string;
  time: string;
  imageName: string | null;
  imagePosition: number | null;
  order: number;
};

export type SljaArchive = {
  title: string;
  slides: SljaSlide[];
  /** Buffers das imagens referenciadas em slides (chave = nome do arquivo). */
  images: Map<string, Buffer>;
};

const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

type Entry = { name: string; buffer: Buffer };

// yauzl.open(fd-slicer) pendura em Node 26; fromBuffer é estável. Cap 64MB cobre custo de memória.
function promisifiedOpen(path: string): Promise<yauzl.ZipFile> {
  return readFile(path).then(
    (buffer) =>
      new Promise((resolve, reject) => {
        yauzl.fromBuffer(
          buffer,
          { lazyEntries: true, decodeStrings: true, autoClose: true },
          (error, zipfile) => {
            if (error || !zipfile)
              reject(error ?? new Error("cannot open ZIP"));
            else resolve(zipfile);
          },
        );
      }),
  );
}

function readEntries(
  zipfile: yauzl.ZipFile,
  maxBytes: number,
): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    let total = 0;
    zipfile.on("error", reject);
    zipfile.on("end", () => resolve(entries));
    zipfile.on("entry", (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith("/")) {
        zipfile.readEntry();
        return;
      }
      total += entry.uncompressedSize;
      if (total > maxBytes) {
        zipfile.close();
        reject(new Error("ZIP exceeds size limit"));
        return;
      }
      zipfile.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          zipfile.close();
          reject(error ?? new Error("cannot read ZIP entry"));
          return;
        }
        const parts: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => parts.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => {
          entries.push({ name: entry.fileName, buffer: Buffer.concat(parts) });
          zipfile.readEntry();
        });
      });
    });
    zipfile.readEntry();
  });
}

function assertSafeEntry(name: string): void {
  if (!name || name.includes("\0"))
    throw new Error(`unsafe ZIP entry: ${name}`);
  const normalized = name.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`unsafe ZIP entry: ${name}`);
  }
}

export function parseIni(ini: string): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  let current: string | null = null;
  for (const rawLine of ini.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const section = /^\[(.+)\]$/u.exec(line);
    if (section) {
      current = section[1] ?? "";
      result.set(current, new Map());
      continue;
    }
    const equals = line.indexOf("=");
    if (equals > 0 && current) {
      result
        .get(current)
        ?.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
    }
  }
  return result;
}

// tempo=HH:MM:SS (formato antigo) ou MM:SS/HH:MM:SS via tempo_hms (formato novo,
// JA ~2012+). tempo inteiro do formato novo não é linear (frames de export) e
// é ignorado — tempo_hms é a fonte confiável quando presente.
function hms(value: string | undefined): string {
  return value && /^\d{1,2}:\d{2}(:\d{2})?$/u.test(value) ? value : "00:00:00";
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function hmsFromTempoHms(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(value.trim());
  if (!m) return null;
  // tempo_hms grava MM:SS; com 3 grupos é HH:MM:SS
  return m[3] ? value.trim() : `00:${pad2(Number(m[1]))}:${m[2]}`;
}

function slideTime(
  tempoHms: string | undefined,
  tempo: string | undefined,
): string {
  return hmsFromTempoHms(tempoHms) ?? hms(tempo);
}

export async function parseSlja(
  zipPath: string,
  maxBytes = MAX_UNCOMPRESSED_BYTES,
): Promise<SljaArchive> {
  const entries = (
    await readEntries(await promisifiedOpen(zipPath), maxBytes)
  ).map((entry) => {
    assertSafeEntry(entry.name);
    return { ...entry, name: entry.name.replaceAll("\\", "/") };
  });

  const iniEntry = entries.find((entry) => entry.name === "slides.lja");
  if (!iniEntry) throw new Error("slides.lja not found");

  const ini = parseIni(iniEntry.buffer.toString("latin1"));
  const general = ini.get("Geral") ?? new Map<string, string>();
  const count = Number.parseInt(general.get("slides") ?? "0", 10) || 0;
  const title = (general.get("titulo") || "").trim() || "Sin título";

  const slides: SljaSlide[] = [];
  for (let index = 1; index <= count; index += 1) {
    const section = ini.get(`Slide:${index}`);
    if (!section) continue;
    const imagem = section.get("imagem");
    // INI real usa backslash: imagem=imagens\hasd_297B.jpg
    const imageName = imagem
      ? imagem.replace(/^imagens[\\/]/u, "").replaceAll("\\", "/")
      : null;
    const posicaoRaw = section.get("imagem_posicao");
    const imagePosition = posicaoRaw ? Number.parseInt(posicaoRaw, 10) : null;
    slides.push({
      lyric: (section.get("letra") ?? "").replaceAll("|", "\n"),
      auxiliaryLyric: section.get("letra_aux")?.replaceAll("|", "\n") ?? null,
      type: section.get("tipo") ?? (index === 1 ? "CAPA" : "LETRA"),
      time: slideTime(section.get("tempo_hms"), section.get("tempo")),
      imageName: imageName && imageName.length > 0 ? imageName : null,
      imagePosition:
        imagePosition !== null && Number.isFinite(imagePosition)
          ? imagePosition
          : null,
      order: index,
    });
  }
  const images = new Map<string, Buffer>();
  for (const slide of slides) {
    if (!slide.imageName || images.has(slide.imageName)) continue;
    const imgEntry = entries.find(
      (entry) => entry.name === `imagens/${slide.imageName}`,
    );
    if (imgEntry) images.set(slide.imageName, imgEntry.buffer);
  }
  return { title, slides, images };
}
