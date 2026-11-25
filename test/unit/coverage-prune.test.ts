import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps uncovered branches and functions on a covered line", () => {
  const dir = mkdtempSync(join(tmpdir(), "coverage-prune-"));
  const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 30 } };
  const branchLoc = {
    start: { line: 1, column: 10 },
    end: { line: 1, column: 20 },
  };
  try {
    const input = join(dir, "in.json"),
      output = join(dir, "out.json"),
      summary = join(dir, "summary.json");
    writeFileSync(
      input,
      JSON.stringify({
        "/tmp/example.ts": {
          path: "/tmp/example.ts",
          statementMap: { 0: loc, 1: loc },
          s: { 0: 1, 1: 0 },
          fnMap: {
            0: { name: "unexecuted", decl: branchLoc, loc: branchLoc, line: 1 },
          },
          f: { 0: 0 },
          branchMap: {
            0: {
              line: 1,
              type: "cond-expr",
              loc,
              locations: [branchLoc, branchLoc],
            },
          },
          b: { 0: [1, 0] },
        },
      }),
    );
    execFileSync(process.execPath, [
      "scripts/prune-phantom-coverage.mjs",
      input,
      output,
      summary,
    ]);
    const totals = JSON.parse(readFileSync(summary, "utf8")).total;
    expect(totals.branches.pct).toBe(50);
    expect(totals.functions.pct).toBe(0);
    expect(totals.statements.total).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
