import { open } from "node:fs/promises";
import yauzl from "yauzl";

export type SljaSlide = {
  lyric: string;
  auxiliaryLyric: string | null;
  type: string;
  time: string;
  imageName: string | null;
  order: number;
};

export type SljaArchive = {
  title: string;
  slides: SljaSlide[];
};

const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

type Entry = { name: string; buffer: Buffer };

function promisifiedOpen(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, decodeStrings: true },
      (error, zipfile) => {
        if (error || !zipfile) reject(error ?? new Error("cannot open ZIP"));
        else resolve(zipfile);
      },
    );
  });
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
        reject(new Error("ZIP exceeds size limit"));
        return;
      }
      zipfile.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
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

function hms(value: string | undefined): string {
  return value && /^\d{1,2}:\d{2}(:\d{2})?$/u.test(value) ? value : "00:00:00";
}

export async function parseSlja(
  zipPath: string,
  maxBytes = MAX_UNCOMPRESSED_BYTES,
): Promise<SljaArchive> {
  let entries = (
    await readEntries(await promisifiedOpen(zipPath), maxBytes)
  ).map((entry) => {
    assertSafeEntry(entry.name);
    return { ...entry, name: entry.name.replaceAll("\\", "/") };
  });

  // ponytail: nested .slja.zip (WhatsApp) — unwrap one level only; drop when source is always Drive-native.
  if (!entries.some((entry) => entry.name === "slides.lja")) {
    const nested = entries.find((entry) =>
      entry.name.toLowerCase().endsWith(".slja"),
    );
    if (nested) {
      const temp = `${zipPath}.inner`;
      const handle = await open(temp, "w");
      await handle.writeFile(nested.buffer);
      await handle.close();
      entries = (await readEntries(await promisifiedOpen(temp), maxBytes)).map(
        (entry) => {
          assertSafeEntry(entry.name);
          return { ...entry, name: entry.name.replaceAll("\\", "/") };
        },
      );
    }
  }

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
    slides.push({
      lyric: (section.get("letra") ?? "").replaceAll("|", "\n"),
      auxiliaryLyric: section.get("letra_aux")?.replaceAll("|", "\n") ?? null,
      type: section.get("tipo") ?? (index === 1 ? "CAPA" : "LETRA"),
      time: hms(section.get("tempo_hms")),
      imageName: imagem ? imagem.replace(/^imagens\//u, "") : null,
      order: index,
    });
  }
  return { title, slides };
}
