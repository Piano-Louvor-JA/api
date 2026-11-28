import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// SPEC-v2 §4.1/4.2 — F-v2-api: MULTI_VERSION_TO_LANG 200–213, catálogos
// multi-item, tarball único por idioma com todas as versões, compat [0].
// Env ANTES dos imports (hoisted), mesmo padrão do bible-chapter-hotfix.
const { cleanTarDir } = vi.hoisted(() => {
  process.env.FETCH_TIMEOUT_MS = "1000";
  process.env.MEDIA_MIRROR = "off";
  process.env.ON_MISS_FETCH = "off";
  return {
    // SPEC-v2: dir versionado (bible_multilingue) agora é limpo E
    // multi-versão — o -clean gitignored nunca existiu no runner do CI.
    cleanTarDir: `${process.cwd()}/data/json_db/bible_multilingue`,
  };
});

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "../../src/app.js";
import { resolveBibleCacheDir } from "../../src/lib/bibleCacheDir.js";
import {
  _resetTarballIndexForTest,
  multilingueLangForVersion,
} from "../../src/lib/bibleTarball.js";
import { _resetThrottleForTest } from "../../src/lib/upstream.js";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

process.env.BIBLE_TARBALL_DIR = cleanTarDir;

let fixture: SeededDb, app: ReturnType<typeof createApp>;

beforeAll(async () => {
  fixture = await setupSeededDb();
  app = createApp();
}, 60000);
afterEach(() => {
  vi.unstubAllGlobals();
  _resetThrottleForTest();
});
afterAll(() => fixture.cleanup());

function tarEntry(lang: string, entry: string): string {
  return execFileSync(
    "tar",
    ["-xzOf", join(cleanTarDir, `${lang}_bible_chapters.tar.gz`), entry],
    { encoding: "utf-8" },
  );
}

function rmCache(key: string) {
  rmSync(join(resolveBibleCacheDir(), `${key}.json`), { force: true });
}

describe("SPEC-v2: MULTI_VERSION_TO_LANG ids 200–213", () => {
  const NEW: ReadonlyArray<readonly [string, string]> = [
    ["200", "pt"],
    ["201", "en"],
    ["202", "en"],
    ["203", "en"],
    ["204", "en"],
    ["205", "es"],
    ["206", "es"],
    ["207", "fr"],
    ["208", "fr"],
    ["209", "fr"],
    ["210", "ru"],
    ["211", "uk"],
    ["212", "it"],
    ["213", "nl"],
  ];
  it.each(NEW)("multilingueLangForVersion(%s) → %s", (id, lang) => {
    expect(multilingueLangForVersion(id)).toBe(lang);
  });

  it("ids v1 (100–112) preservados", () => {
    expect(multilingueLangForVersion("100")).toBe("en");
    expect(multilingueLangForVersion("112")).toBe("hi");
  });
});

describe("SPEC-v2 AC3: capítulos das novas versões", () => {
  it("bible_201_2100_1 (KJV Gn 1) 200 com texto KJV", async () => {
    rmCache("bible_201_2100_1");
    const res = await app.request("/json_db/bible_201_2100_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body["1"]).toContain(
      "In the beginning God created the heaven and the earth.",
    );
  });

  it("bible_100_200_1 (WEB Gn 1) inalterado (payload = tarball)", async () => {
    rmCache("bible_100_200_1");
    const res = await app.request("/json_db/bible_100_200_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      JSON.parse(tarEntry("en", "bible_100_200_1.json")),
    );
  });

  it("payload do KJV serve exatamente o membro do tarball", async () => {
    rmCache("bible_201_2100_1");
    const res = await app.request("/json_db/bible_201_2100_1");
    expect(await res.json()).toEqual(
      JSON.parse(tarEntry("en", "bible_201_2100_1.json")),
    );
  });
});

describe("SPEC-v2 AC2: catálogos multi-versão", () => {
  it("en_bible_version.json = 5 itens com WEB (100) em [0] (SPEC tabela §3.1: WEB + 4 novas; AC2 diz 6 — typo da SPEC, tabela é o recorte congelado)", async () => {
    const res = await app.request("/json_db/en_bible_version");
    expect(res.status).toBe(200);
    const versions = (await res.json()) as Array<Record<string, unknown>>;
    expect(versions).toHaveLength(5);
    expect(String(versions[0]?.id_bible_version)).toBe("100");
    expect(versions.map((v) => String(v.id_bible_version)).sort()).toEqual(
      ["100", "201", "202", "203", "204"].sort(),
    );
  });

  // pt/es: catálogo multi-versão é o ARQUIVO empacotado (SPEC-v2 §4.2
  // AC2); as ROTAS pt/es seguem legado (DB/fallback — ids 99/98 e
  // paridade api#76 intactas). Idiomas novos: rota serve o arquivo.
  it.each([
    ["fr", 4],
    ["es", 3],
    ["pt", 2],
    ["it", 2],
    ["nl", 2],
    ["ru", 2],
    ["uk", 2],
    ["ja", 1],
    ["ko", 1],
    ["zh", 1],
    ["ar", 1],
    ["pl", 1],
    ["tr", 1],
  ])("%s_bible_version.json = %d itens", async (lang, n) => {
    const raw = tarListCleanDir(`${lang}_bible_version.json`);
    expect(JSON.parse(raw)).toHaveLength(n);
    if (lang === "pt" || lang === "es") return;
    const res = await app.request(`/json_db/${lang}_bible_version`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(n);
  });
});

describe("SPEC-v2 §4.2: catálogo de livros concatenado", () => {
  it("en_bible_book: 66 livros por versão (5×66)", async () => {
    const res = await app.request("/json_db/en_bible_book");
    const books = (await res.json()) as Array<Record<string, unknown>>;
    expect(books).toHaveLength(66 * 5);
    // v1 primeiro: primeiros 66 são book 200–265
    expect(Number(books[0]?.id_bible_book)).toBe(200);
    expect(Number(books[65]?.id_bible_book)).toBe(265);
  });

  it("livros KJV: 2100–2165", async () => {
    const res = await app.request("/json_db/en_bible_book");
    const books = (await res.json()) as Array<Record<string, unknown>>;
    const kjv = books.filter((b) => {
      const id = Number(b.id_bible_book);
      return id >= 2100 && id <= 2165;
    });
    expect(kjv).toHaveLength(66);
    expect(kjv.map((b) => Number(b.book_number))).toEqual(
      Array.from({ length: 66 }, (_, i) => i + 1),
    );
  });
});

describe("SPEC-v2: sha256 do catálogo", () => {
  it("en_bible_catalog.sha256 bate com os arquivos", async () => {
    const lines = tarListCleanDir("en_bible_catalog.sha256").split("\n");
    for (const line of lines) {
      const [hash, name] = line.trim().split(/\s+/);
      if (!hash || !name) continue;
      const real = sha256File(join(cleanTarDir, name));
      expect(real).toBe(hash);
    }
  });
});

function tarListCleanDir(f: string): string {
  return execFileSync("cat", [join(cleanTarDir, f)], { encoding: "utf-8" });
}

function sha256File(p: string): string {
  return execFileSync("sha256sum", [p], { encoding: "utf-8" }).split(" ")[0];
}

describe("SPEC-v2 §4.1: colisão de id_bible_book", () => {
  it("nenhum id novo (2000–3365) colide com os existentes nos catálogos", async () => {
    // conta ids duplicados em en (o mais carregado: 6 versões)
    const res = await app.request("/json_db/en_bible_book");
    const books = (await res.json()) as Array<Record<string, unknown>>;
    const ids = books.map((b) => Number(b.id_bible_book));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
