#!/usr/bin/env node
/**
 * prune-phantom-coverage.mjs — poda statements 0-hit que são FANTASMAS
 * comprovados dentro de um coverage-final.json único (multi-worker v8):
 *
 * 1. Span 0-hit DUPLICADO: existe outro span com hit nas mesmas
 *    posições inicial e final. Compartilhar linha não comprova duplicação.
 *    (mesma regra do merge-coverage.mjs do repo app, onda 100% — 9121bd7)
 * 2. NÃO poda: statement 0-hit em linha totalmente sem hits (gap real).
 *
 * Uso: node scripts/prune-phantom-coverage.mjs <in.json> <out.json> [out-summary.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [input, output, summaryOut] = process.argv.slice(2);
if (!input || !output) {
  console.error("uso: prune-phantom-coverage.mjs <in.json> <out.json> [summary.json]");
  process.exit(2);
}

const data = JSON.parse(readFileSync(input, "utf8"));
let pruned = 0;
let kept = 0;

// Only identical statement spans prove duplication. A hit elsewhere on the
// same line does not prove that a function or branch arm was executed.
for (const cov of Object.values(data)) {
  const spanKey = (span) => JSON.stringify([span.start, span.end]);
  const coveredSpans = new Set(Object.entries(cov.statementMap)
    .filter(([id]) => cov.s[id] > 0).map(([, span]) => spanKey(span)));
  for (const [id, span] of Object.entries(cov.statementMap)) {
    if (cov.s[id] === 0 && coveredSpans.has(spanKey(span))) {
      delete cov.s[id];
      delete cov.statementMap[id];
      pruned++;
    } else {
      kept++;
    }
  }
  // Preserve every function and branch counter, including zero-hit arms.
}

// Use Istanbul's standard line/branch semantics rather than a line approximation.
const { createCoverageMap } = await import("istanbul-lib-coverage").then((m) => m.default ?? m);
const summary = { total: createCoverageMap(data).getCoverageSummary().toJSON() };

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(data));
console.log(`podados ${pruned} stmts fantasma; mantidos ${kept}`);
if (summaryOut) {
  writeFileSync(summaryOut, JSON.stringify(summary, null, 2));
  console.log(`summary: ${summary.total.statements.pct}/${summary.total.branches.pct}/${summary.total.functions.pct}/${summary.total.lines.pct}`);
}
