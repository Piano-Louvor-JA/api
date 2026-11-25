/**
 * Publica na API uma versão do apk Android, a partir da release do GitHub.
 * Depois disso os celulares veem a atualização em GET /v1/app/version e
 * baixam o apk da própria API (sem o limite anônimo do GitHub).
 *
 * Produção (dentro do container, sem rebuild nem restart):
 *   docker compose exec api node dist/cli/fetch-apk.js          # última release
 *   docker compose exec api node dist/cli/fetch-apk.js 1.0.1    # versão exata
 * Rodar com uma versão anterior é o rollback.
 *
 * Garantias:
 * - confere o SHA-256 publicado pelo GitHub no asset (digest);
 * - nunca sobrescreve um apk já publicado que difira da release;
 * - o version.json só é trocado depois de o apk estar no lugar e conferido,
 *   então o banner nunca aparece antes de o download funcionar;
 * - mantém o apk anterior (rollback rápido) e apaga os mais antigos.
 *
 * Dev: npm run fetch-apk -- [versão]
 */

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
  APK_FILE_PATTERN,
  type AppUpdateManifest,
  androidDir,
  manifestPath,
  readManifest,
} from "../lib/appUpdates.js";

const USAGE = "Uso: fetch-apk [versão X.Y.Z]   (sem versão = última release)";

type Fetch = typeof fetch;

interface ReleaseAsset {
  name?: string;
  size?: number;
  digest?: string | null;
  browser_download_url?: string;
}

interface Release {
  tag_name?: string;
  body?: string | null;
  published_at?: string | null;
  assets?: ReleaseAsset[];
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "piano-api-fetch-apk",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Executa a publicação. Devolve o exit code. */
export async function run(
  argv: string[],
  out: (line: string) => void,
  fetchImpl: Fetch = fetch,
): Promise<number> {
  const [version, ...extra] = argv;
  if (extra.length > 0 || (version && !/^\d+\.\d+\.\d+$/.test(version))) {
    out(USAGE);
    return 2;
  }

  const repo = process.env.APK_RELEASE_REPO ?? "Piano-Louvor-JA/apk";
  const releaseUrl = version
    ? `https://api.github.com/repos/${repo}/releases/tags/v${version}`
    : `https://api.github.com/repos/${repo}/releases/latest`;

  const res = await fetchImpl(releaseUrl, { headers: githubHeaders() });
  if (!res.ok) {
    out(`Release não encontrada (${res.status}): ${releaseUrl}`);
    return 1;
  }
  const release = (await res.json()) as Release;
  const tagVersion = (release.tag_name ?? "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(tagVersion)) {
    out(`Tag inválida na release: ${release.tag_name ?? "(vazia)"}`);
    return 1;
  }

  const asset = (release.assets ?? []).find(
    (a) => APK_FILE_PATTERN.exec(a.name ?? "")?.[1] === tagVersion,
  );
  const expected = asset?.digest?.startsWith("sha256:")
    ? asset.digest.slice("sha256:".length).toLowerCase()
    : null;
  if (!asset?.name || !asset.browser_download_url || !asset.size) {
    out(`A release v${tagVersion} não tem louvorja-piano-${tagVersion}.apk`);
    return 1;
  }
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    out(`O apk da release v${tagVersion} não tem SHA-256 publicado`);
    return 1;
  }

  const dir = androidDir();
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, asset.name);

  if (existsSync(dest)) {
    if ((await sha256File(dest)) !== expected) {
      out(`${dest} já existe e difere da release — nada publicado`);
      return 1;
    }
    out(`${asset.name} já publicado (SHA-256 confere)`);
  } else {
    const tmp = path.join(dir, `.${asset.name}.${process.pid}.part`);
    try {
      const download = await fetchImpl(asset.browser_download_url, {
        headers: { "User-Agent": "piano-api-fetch-apk" },
      });
      if (!download.ok || !download.body) {
        out(`Falha ao baixar o apk (${download.status})`);
        return 1;
      }
      const hash = createHash("sha256");
      const tap = new Transform({
        transform(chunk, _enc, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(
          download.body as import("node:stream/web").ReadableStream,
        ),
        tap,
        createWriteStream(tmp),
      );
      const got = hash.digest("hex");
      if (got !== expected || statSync(tmp).size !== asset.size) {
        out(`SHA-256/tamanho do apk não confere (${got}) — nada publicado`);
        return 1;
      }
      if (existsSync(dest)) {
        out(`${dest} apareceu durante o download — nada publicado`);
        return 1;
      }
      renameSync(tmp, dest);
      out(`Publicado: ${dest}`);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  const previous = readManifest();
  const manifest: AppUpdateManifest = {
    version: tagVersion,
    file: asset.name,
    size: asset.size,
    sha256: expected,
    notes: release.body ?? "",
    published_at: release.published_at ?? null,
  };
  const tmpManifest = `${manifestPath()}.${process.pid}.tmp`;
  writeFileSync(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmpManifest, manifestPath());
  out(`version.json → ${tagVersion} (os celulares já veem a atualização)`);

  // Mantém o atual e o anterior (rollback); apaga os outros apks.
  const keep = new Set([asset.name, previous?.file]);
  for (const name of readdirSync(dir)) {
    if (APK_FILE_PATTERN.test(name) && !keep.has(name)) {
      rmSync(path.join(dir, name), { force: true });
      out(`Removido apk antigo: ${name}`);
    }
  }
  return 0;
}

/* istanbul ignore if -- entrypoint do processo; a lógica é coberta via run() */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.argv.slice(2), (line) => console.log(line)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
