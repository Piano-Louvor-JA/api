import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseManifest } from "./lib/es-ja-manifest.js";

const DEFAULT_MANIFEST =
  "/media/rafaelejosi/NovoVolume/es-ja-drive/manifest.tsv";
const DEFAULT_DESTINATION = "/media/rafaelejosi/NovoVolume/es-ja-drive/private";
const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB de folga antes de abortar
const RETRY_LIMIT = 3;

type Row = Record<string, string | number>;

function destinationFor(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`))
    throw new Error("unsafe destination");
  return target;
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function freeBytes(dir: string): Promise<number> {
  const { bavail } = await statfs(dir);
  return Number(bavail) * 4096;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function download(driveFileId: string, target: string): Promise<Row> {
  const url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(driveFileId)}&export=download&confirm=t`;
  const response = await fetch(url);
  if (!response.ok || !response.body)
    throw new Error(`HTTP ${response.status}`);
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  try {
    await pipeline(response.body, createWriteStream(partial, { flags: "w" }));
    const bytes = (await stat(partial)).size;
    if (bytes === 0) throw new Error("empty response");
    const digest = await sha256(partial);
    await rename(partial, target);
    return { status: "downloaded", bytes, sha256: digest };
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const manifestPath = process.argv[2] ?? DEFAULT_MANIFEST;
  const destination = process.argv[3] ?? DEFAULT_DESTINATION;
  const items = parseManifest(await readFile(manifestPath, "utf8"));
  const report: Row[] = [];
  let failures = 0;

  for (const item of items) {
    const target = destinationFor(destination, item.relativePath);
    if (await exists(target)) {
      report.push({
        id: item.driveFileId,
        path: item.relativePath,
        status: "existing",
        bytes: (await stat(target)).size,
        sha256: await sha256(target),
      });
      continue;
    }
    if ((await freeBytes(path.dirname(target))) < MIN_FREE_BYTES) {
      report.push({
        id: item.driveFileId,
        path: item.relativePath,
        status: "skipped",
        error: "disk guard: <5GiB free",
      });
      failures += 1;
      continue;
    }
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        report.push({
          id: item.driveFileId,
          path: item.relativePath,
          ...(await download(item.driveFileId, target)),
        });
        break;
      } catch (error) {
        if (attempt >= RETRY_LIMIT) {
          report.push({
            id: item.driveFileId,
            path: item.relativePath,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            attempts: attempt,
          });
          failures += 1;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  const summary = {
    scope: "private-archive-only",
    total: report.length,
    downloaded: report.filter((r) => r.status === "downloaded").length,
    existing: report.filter((r) => r.status === "existing").length,
    failed: report.filter((r) => r.status === "failed").length,
    skipped: report.filter((r) => r.status === "skipped").length,
  };
  process.stdout.write(`${JSON.stringify({ ...summary, report }, null, 2)}\n`);
  if (failures > 0) process.exitCode = 1;
}

await main();
