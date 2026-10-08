#!/usr/bin/env node
/** Coverage 100x4. Only exact duplicate statement spans may be removed.
 * Branches and functions with zero hits remain gaps, even on executed lines.
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const REPORTS = "coverage-gate";
const GATE = 100;

console.log("[gate] 1/3 vitest run --coverage ...");
rmSync(REPORTS, { recursive: true, force: true });
execSync(
  `npx vitest run --coverage --coverage.provider=v8 ` +
    `--coverage.reporter=json --coverage.thresholds.statements=0 ` +
    `--coverage.thresholds.branches=0 --coverage.thresholds.functions=0 ` +
    `--coverage.thresholds.lines=0 --coverage.reportsDirectory=${REPORTS}`,
  { stdio: "inherit" },
);

console.log("[gate] 2/3 prune phantom spans ...");
execSync(
  `node scripts/prune-phantom-coverage.mjs ${REPORTS}/coverage-final.json ${REPORTS}/pruned.json ${REPORTS}/pruned-summary.json`,
  { stdio: "inherit" },
);

console.log("[gate] 3/3 thresholds 100x4 ...");
const summary = JSON.parse(
  existsSync(`${REPORTS}/pruned-summary.json`)
    ? await import("node:fs").then((m) => m.readFileSync(`${REPORTS}/pruned-summary.json`, "utf8"))
    : "{}",
);
let failed = false;
for (const kind of ["statements", "branches", "functions", "lines"]) {
  const { pct } = summary.total[kind];
  const ok = pct >= GATE;
  console.log(`  ${kind}: ${pct}% ${ok ? "OK" : "FAIL"} (gate ${GATE})`);
  if (!ok) failed = true;
}
if (failed) {
  console.error("[gate] FALHOU — coverage abaixo do gate");
  process.exit(1);
}
console.log("[gate] PASSOU — 100/100/100/100 (pós-poda de fantasmas)");
