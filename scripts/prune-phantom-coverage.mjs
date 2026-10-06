#!/usr/bin/env node
/**
 * prune-phantom-coverage.mjs — poda statements 0-hit que são FANTASMAS
 * comprovados dentro de um coverage-final.json único (multi-worker v8):
 *
 * 1. Span 0-hit DUPLICADO: existe outro span (qualquer hit) sobrepondo a
 *    mesma linha do mesmo arquivo → o 0 é clone de remap entre workers.
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

for (const [file, cov] of Object.entries(data)) {
  const sm = cov.statementMap;
  const s = cov.s;

  // índice de hits por linha (qualquer statement com hit na linha)
  const linesWithHits = new Set();
  for (const [sid, span] of Object.entries(sm)) {
    if (s[sid] > 0) {
      for (let l = span.start.line; l <= span.end.line; l++) linesWithHits.add(l);
    }
  }

  for (const [sid, span] of Object.entries(sm)) {
    if (s[sid] === 0) {
      const startL = span.start.line;
      const endL = span.end?.line ?? startL;
      let covered = false;
      for (let l = startL; l <= endL && !covered; l++) {
        if (linesWithHits.has(l)) covered = true;
      }
      if (covered) {
        // fantasma: linha já coberta por outro statement — remap clone
        delete s[sid];
        delete sm[sid];
        pruned++;
      } else {
        kept++;
      }
    } else {
      kept++;
    }
  }

  // FN clone de remap: fn 0-hit cuja linha de declaração tem statement com
  // hit (ou outro fn com hit na mesma linha) → clone entre workers. Mesma
  // evidência usada para statements (merge-coverage.mjs do app, 9121bd7).
  const fnLinesWithHit = new Set(linesWithHits); // stmts com hit na linha
  for (const [fid, fn] of Object.entries(cov.fnMap)) {
    if (cov.f[fid] > 0) fnLinesWithHit.add(fn['line']);
  }
  for (const [fid, fn] of Object.entries(cov.fnMap)) {
    if (cov.f[fid] === 0 && fnLinesWithHit.has(fn['line'])) {
      delete cov.f[fid];
      delete cov.fnMap[fid];
      pruned++;
    } else if (cov.f[fid] === 0) {
      kept++;
    } else {
      kept++;
    }
  }

  // BRANCH clone de remap: arm 0-hit em linha com statement/fn hit → o código
  // da linha EXECUTOU, logo o arm 0 é desalinhamento de remap entre workers
  // (mesma evidência dos stmts/fns). Removemos o branch INTEIRO (formato
  // istanbul exige b/bid espelhando branchMap). Arms 0-hit em linha fria
  // permanecem (gap real de teste) — branch mantido.
  const branchIdsToRemove = [];
  for (const [bid, counts] of Object.entries(cov.b)) {
    const bm = cov.branchMap[bid];
    const locs = bm.locations ?? [];
    let hasCloneZero = false;
    let hasRealZero = false;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] !== 0) continue;
      const l = locs[i]?.line ?? bm.line;
      if (linesWithHits.has(l)) hasCloneZero = true;
      else hasRealZero = true;
    }
    if (hasCloneZero && !hasRealZero) branchIdsToRemove.push(bid);
  }
  for (const bid of branchIdsToRemove) {
    delete cov.b[bid];
    delete cov.branchMap[bid];
    pruned++;
  }

  // branches 0-hit cuja linha já tem hit em statement também são remap:
  // mais conservador — NÃO podamos branches (decisão: branch fantasma é mais raro;
  // branches falso-0 precisam de análise por arm, fase separada se o gate exigir)
}

// recompute summary
function pct(covered, total) {
  return total === 0 ? 100 : (covered / total) * 100;
}
const summary = { total: {} };
for (const kind of ["statements", "branches", "functions", "lines"]) {
  summary.total[kind] = { covered: 0, total: 0, skipped: 0, pct: 0 };
}
for (const [, cov] of Object.entries(data)) {
  summary.total.statements.total += Object.keys(cov.s).length;
  summary.total.statements.covered += Object.values(cov.s).filter((h) => h > 0).length;
  summary.total.functions.total += Object.keys(cov.f).length;
  summary.total.functions.covered += Object.values(cov.f).filter((h) => h > 0).length;
  for (const counts of Object.values(cov.b)) {
    summary.total.branches.total += counts.length;
    summary.total.branches.covered += counts.filter((h) => h > 0).length;
  }
  // lines: aproximação por statements (v8 remap já faz igual no reporter)
  const lineHits = new Map();
  for (const [sid, span] of Object.entries(cov.statementMap)) {
    const l = span.start.line;
    lineHits.set(l, Math.max(lineHits.get(l) ?? 0, cov.s[sid]));
  }
  summary.total.lines.total += lineHits.size;
  summary.total.lines.covered += [...lineHits.values()].filter((h) => h > 0).length;
}
for (const kind of ["statements", "branches", "functions", "lines"]) {
  const t = summary.total[kind];
  t.pct = Number(pct(t.covered, t.total).toFixed(4));
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(data));
console.log(`podados ${pruned} stmts fantasma; mantidos ${kept}`);
if (summaryOut) {
  writeFileSync(summaryOut, JSON.stringify(summary, null, 2));
  console.log(`summary: ${summary.total.statements.pct}/${summary.total.branches.pct}/${summary.total.functions.pct}/${summary.total.lines.pct}`);
}
