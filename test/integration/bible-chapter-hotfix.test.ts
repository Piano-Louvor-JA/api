import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// HOTFIX t_b3824cb7 — rota dos tarballs multilíngues (item principal).
// fetchUpstream REAL: stub só no global.fetch para os cenários de upstream.
// Env ANTES dos imports (hoisted): upstream.ts lê FETCH_TIMEOUT_MS no import.
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

import { createApp } from "../../src/app.js";
import { resolveBibleCacheDir } from "../../src/lib/bibleCacheDir.js";
import { _resetTarballIndexForTest } from "../../src/lib/bibleTarball.js";
import { _resetThrottleForTest } from "../../src/lib/upstream.js";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

let fixture: SeededDb, app: ReturnType<typeof createApp>;
// Fixtures LIMPOS de df05c9f (branch feat/bible-rework-strong-ko): o tarball
// em main ainda tem strong=. BIBLE_TARBALL_DIR aponta a rota para os limpos.
const tarDir = cleanTarDir;
process.env.BIBLE_TARBALL_DIR = tarDir;

beforeAll(async () => {
  fixture = await setupSeededDb();
  app = createApp();
});
afterEach(() => {
  vi.unstubAllGlobals();
  _resetThrottleForTest();
});
afterAll(() => {
  fixture.cleanup();
});

/** fetch que pendura até o AbortSignal disparar (upstream pendurado). */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("This operation was aborted")),
        );
      }),
  );
}

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

describe("HOTFIX t_b3824cb7: capítulos multilíngues via tarball local", () => {
  it("bible_100_203_21 (en) 200 com payload igual ao tarball limpo", async () => {
    rmCache("bible_100_203_21");
    const res = await app.request("/json_db/bible_100_203_21");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      JSON.parse(tarEntry("en", "bible_100_203_21.json")),
    );
  });

  it("bible_101_305_4 (fr) 200 com payload igual ao tarball limpo", async () => {
    rmCache("bible_101_305_4");
    const res = await app.request("/json_db/bible_101_305_4");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      JSON.parse(tarEntry("fr", "bible_101_305_4.json")),
    );
  });

  it("idioma multilíngue NÃO consulta upstream (tarball é a fonte)", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    rmCache("bible_100_200_1");
    const res = await app.request("/json_db/bible_100_200_1");
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("segunda leitura serve do cache sem re-extrair", async () => {
    rmCache("bible_100_203_21");
    const first = await app.request("/json_db/bible_100_203_21");
    expect(first.status).toBe(200);
    const second = await app.request("/json_db/bible_100_203_21");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(
      JSON.parse(tarEntry("en", "bible_100_203_21.json")),
    );
  });

  it("pt (bible_13_1_1) com upstream pendurado responde em <= 11s com 5xx", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    rmCache("bible_13_1_1");
    const t0 = Date.now();
    const res = await app.request("/json_db/bible_13_1_1");
    const elapsed = Date.now() - t0;
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThanOrEqual(11_000);
  });

  it("pt (bible_2_5_1) com upstream 404 devolve 404 rápido e cache negativo evita re-fetch", async () => {
    const fetchMock = vi.fn(
      async () => new Response("missing", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    rmCache("bible_2_5_1");
    const t0 = Date.now();
    expect((await app.request("/json_db/bible_2_5_1")).status).toBe(404);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect((await app.request("/json_db/bible_2_5_1")).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("capítulo inexistente em versão multilíngue devolve 404", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request("/json_db/bible_100_999_99");
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trocar o tarball invalida o cache de disco (serve o novo conteúdo)", async () => {
    // Cópia própria em tmp: o teste troca o tarball — fixture intocada.
    const dir = mkdtempSync(join(tmpdir(), "bible-tar-"));
    process.env.BIBLE_TARBALL_DIR = dir;
    _resetTarballIndexForTest();
    try {
      const key = "bible_100_200_1";
      const clean = readFileSync(join(tarDir, "en_bible_chapters.tar.gz"));
      // tarball "novo" com conteúdo REALMENTE diferente: recompacta o mesmo
      // JSON com um versículo alterado (t_5582d47e: ambos os tarballs estão
      // limpos, então mtime/size iguais não bastam para provar invalidação)
      const altered = execFileSync(
        "sh",
        [
          "-c",
          `tmp=$(mktemp -d) && tar xzf ${JSON.stringify(
            join(tarDir, "en_bible_chapters.tar.gz"),
          )} -C "$tmp" bible_100_200_1.json && python3 - "$tmp/bible_100_200_1.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
d["1"]="In the beginning God created the heavens and the earth. (alterado)"
json.dump(d,open(p,"w"),ensure_ascii=False,separators=(",",":"))
PY
tar czf - -C "$tmp" bible_100_200_1.json && rm -rf "$tmp"`,
        ],
        { maxBuffer: 1024 * 1024, encoding: "buffer" } as object,
      );
      writeFileSync(join(dir, "en_bible_chapters.tar.gz"), clean);
      rmCache(key);
      const first = await app.request(`/json_db/${key}`);
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      expect(firstBody[1]).not.toContain("strong=");
      // troca o tarball — conteúdo diferente
      writeFileSync(join(dir, "en_bible_chapters.tar.gz"), altered);
      const second = await app.request(`/json_db/${key}`);
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      expect(secondBody[1]).toContain("(alterado)");
      // cache de disco PRECISA ter sido invalidado: o arquivo em disco agora
      // reflete o tarball novo
      const disk = JSON.parse(
        readFileSync(join(resolveBibleCacheDir(), `${key}.json`), "utf-8"),
      );
      expect(disk[1]).toContain("(alterado)");
      expect(JSON.stringify(disk)).not.toEqual(JSON.stringify(firstBody));
      rmCache(key);
    } finally {
      process.env.BIBLE_TARBALL_DIR = tarDir;
      _resetTarballIndexForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
