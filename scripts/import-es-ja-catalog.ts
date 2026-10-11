import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizedManifestHash, parseManifest } from "./lib/es-ja-manifest.js";

type Options = { manifest?: string; sourceDir?: string; dryRun: boolean; licenseApprovalId?: string; report?: string };

function options(args: readonly string[]): Options {
  const value = (name: string) => args[args.indexOf(name) + 1];
  return {
    manifest: value("--manifest"), sourceDir: value("--source-dir"), dryRun: args.includes("--dry-run"),
    licenseApprovalId: value("--license-approval-id"), report: value("--report"),
  };
}

async function main(): Promise<void> {
  const input = options(process.argv.slice(2));
  if (!input.manifest || !input.sourceDir || !input.licenseApprovalId) {
    throw new Error("usage: --manifest <tsv> --source-dir <private-dir> --license-approval-id <id> [--dry-run] [--report <json>]");
  }
  if (!input.dryRun) throw new Error("publication is disabled until staging authorization is implemented; use --dry-run");
  const items = parseManifest(await readFile(input.manifest, "utf8"));
  const counts = Object.fromEntries(["approved", "excluded", "rejected", "source-only"].map((decision) => [decision, items.filter((item) => item.decision === decision).length]));
  const report = { version: 1, mode: "dry-run", manifestSha256: normalizedManifestHash(items), total: items.length, counts, items };
  const output = input.report ?? path.join(input.sourceDir, ".es-ja-reports", `${report.manifestSha256}.json`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, items: undefined, report: output })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
