/**
 * Materializacao do catalogo ES-JA (publicacao real, nao dry-run).
 *
 * Uso:
 *   npx tsx scripts/import-es-ja-catalog.ts \
 *     --manifest /path/manifest.tsv --source-dir /path/private \
 *     --db ./data/catalog.db --media-root ./static/media \
 *     --es-category-id 12 --license-approval-id LA-ESJA-20261011 [--dry-run]
 *
 * --dry-run mantem o comportamento anterior (report apenas).
 * Sem --dry-run executa materialize() com staging atomico + transacao SQLite.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizedManifestHash, parseManifest } from "./lib/es-ja-manifest.js";
import { materialize } from "./lib/es-ja-materialize.js";

type Options = {
  manifest?: string;
  sourceDir?: string;
  dryRun: boolean;
  licenseApprovalId?: string;
  report?: string;
  dbPath?: string;
  mediaRoot?: string;
  esCategoryId?: string;
};

function options(args: readonly string[]): Options {
  const value = (name: string) => args[args.indexOf(name) + 1];
  return {
    manifest: value("--manifest"),
    sourceDir: value("--source-dir"),
    dryRun: args.includes("--dry-run"),
    licenseApprovalId: value("--license-approval-id"),
    report: value("--report"),
    dbPath: value("--db"),
    mediaRoot: value("--media-root"),
    esCategoryId: value("--es-category-id"),
    coversDir: value("--es-covers-dir"),
  };
}

async function main(): Promise<void> {
  const input = options(process.argv.slice(2));
  if (!input.manifest || !input.sourceDir || !input.licenseApprovalId) {
    throw new Error(
      "usage: --manifest <tsv> --source-dir <private-dir> --license-approval-id <id> [--db <sqlite>] [--media-root <dir>] [--es-category-id <id>] [--dry-run] [--report <json>]",
    );
  }

  if (input.dryRun) {
    const items = parseManifest(await readFile(input.manifest, "utf8"));
    const counts = Object.fromEntries(
      ["approved", "excluded", "rejected", "source-only"].map((decision) => [
        decision,
        items.filter((item) => item.decision === decision).length,
      ]),
    );
    const report = {
      version: 1,
      mode: "dry-run",
      manifestSha256: normalizedManifestHash(items),
      total: items.length,
      counts,
      items,
    };
    const output =
      input.report ??
      path.join(
        input.sourceDir,
        ".es-ja-reports",
        `${report.manifestSha256}.json`,
      );
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(
      `${JSON.stringify({ ...report, items: undefined, report: output })}\n`,
    );
    return;
  }

  if (!input.dbPath || !input.mediaRoot || !input.esCategoryId) {
    throw new Error(
      "publication requires --db <sqlite> --media-root <dir> --es-category-id <id>",
    );
  }

  const result = await materialize({
    manifestPath: input.manifest,
    sourceDir: input.sourceDir,
    dbPath: input.dbPath,
    mediaRoot: input.mediaRoot,
    licenseApprovalId: input.licenseApprovalId,
    esCategoryId: Number.parseInt(input.esCategoryId, 10),
    ...(input.coversDir ? { coversDir: input.coversDir } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
