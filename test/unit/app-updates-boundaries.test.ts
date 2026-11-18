import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/fetch-apk.js";
import {
  androidDir,
  manifestPath,
  readManifest,
  updatesDir,
} from "../../src/lib/appUpdates.js";

const apk = Buffer.from("verified Android package");
const filename = "louvorja-piano-1.0.1.apk";
const digest = createHash("sha256").update(apk).digest("hex");
const downloadUrl = `https://github.com/example/apk/releases/download/v1.0.1/${filename}`;

function asset(overrides: Record<string, unknown> = {}) {
  return {
    name: filename,
    size: apk.length,
    digest: `sha256:${digest}`,
    browser_download_url: downloadUrl,
    ...overrides,
  };
}

function release(overrides: Record<string, unknown> = {}) {
  return { tag_name: "v1.0.1", assets: [asset()], ...overrides };
}

function github(
  metadata: unknown,
  download: () => Response = () => new Response(apk),
) {
  return vi.fn<typeof fetch>(async (input) =>
    String(input) === downloadUrl ? download() : Response.json(metadata),
  );
}

describe("publicação de APK: limites e falhas", () => {
  let dir: string;
  const out = vi.fn<(line: string) => void>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "piano-apk-boundaries-"));
    vi.stubEnv("APP_UPDATES_DIR", dir);
    vi.stubEnv("APK_RELEASE_REPO", "example/apk");
    vi.stubEnv("GITHUB_TOKEN", "");
    out.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejeita argumentos extras sem consultar a rede", async () => {
    const fetcher = github(release());
    expect(await run(["1.0.1", "extra"], out, fetcher)).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{}, { tag_name: "vnext" }])(
    "rejeita uma release sem versão estável: %j",
    async (metadata) => {
      expect(await run([], out, github(metadata))).toBe(1);
      expect(out).toHaveBeenLastCalledWith(
        expect.stringContaining("Tag inválida"),
      );
      expect(existsSync(manifestPath())).toBe(false);
    },
  );

  it.each([
    release({ assets: undefined }),
    release({ assets: [{}] }),
    release({ assets: [asset({ browser_download_url: undefined })] }),
    release({ assets: [asset({ size: 0 })] }),
  ])("recusa metadados sem um APK completo: %j", async (metadata) => {
    const fetcher = github(metadata);
    expect(await run([], out, fetcher)).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(existsSync(manifestPath())).toBe(false);
  });

  it.each([null, "md5:abc", "sha256:invalid"])(
    "recusa digest ausente ou inválido: %s",
    async (value) => {
      expect(
        await run(
          [],
          out,
          github(release({ assets: [asset({ digest: value })] })),
        ),
      ).toBe(1);
      expect(out).toHaveBeenLastCalledWith(
        expect.stringContaining("não tem SHA-256"),
      );
    },
  );

  it.each([403, 204])(
    "não publica download HTTP %i sem conteúdo e remove temporários",
    async (status) => {
      const fetcher = github(release(), () => new Response(null, { status }));
      expect(await run([], out, fetcher)).toBe(1);
      expect(readdirSync(androidDir())).toEqual([]);
      expect(out).toHaveBeenLastCalledWith(`Falha ao baixar o apk (${status})`);
    },
  );

  it("recusa tamanho incorreto mesmo com SHA-256 válido", async () => {
    const fetcher = github(
      release({ assets: [asset({ size: apk.length + 1 })] }),
    );
    expect(await run([], out, fetcher)).toBe(1);
    expect(readdirSync(androidDir())).toEqual([]);
  });

  it("preserva arquivo que surge durante o download sem publicar manifesto", async () => {
    const fetcher = github(release(), () => {
      writeFileSync(join(androidDir(), filename), "concurrent publication");
      return new Response(apk);
    });
    expect(await run([], out, fetcher)).toBe(1);
    expect(readFileSync(join(androidDir(), filename), "utf8")).toBe(
      "concurrent publication",
    );
    expect(readdirSync(androidDir())).toEqual([filename]);
    expect(existsSync(manifestPath())).toBe(false);
  });

  it("autentica só a consulta de release e publica valores opcionais vazios", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-only-token");
    const fetcher = github(release());
    expect(await run([], out, fetcher)).toBe(0);
    expect(fetcher.mock.calls[0]).toEqual([
      "https://api.github.com/repos/example/apk/releases/latest",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-only-token",
        }),
      }),
    ]);
    expect(fetcher.mock.calls[1]).toEqual([
      downloadUrl,
      { headers: { "User-Agent": "piano-api-fetch-apk" } },
    ]);
    expect(readManifest()).toMatchObject({ notes: "", published_at: null });
  });

  it("não anuncia manifesto com formato inválido", () => {
    mkdirSync(androidDir(), { recursive: true });
    writeFileSync(manifestPath(), JSON.stringify({ version: "1.0.1" }));
    expect(readManifest()).toBeNull();
  });

  it("usa data/updates quando o diretório não é configurado", () => {
    vi.stubEnv("APP_UPDATES_DIR", undefined);
    expect(updatesDir()).toBe(resolve("data/updates"));
  });

  it("pode importar o CLI sem argv de executável e sem fazer rede", async () => {
    const argv = process.argv;
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    try {
      process.argv = [argv[0]!];
      vi.resetModules();
      await import("../../src/cli/fetch-apk.js");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      process.argv = argv;
    }
  });
});
