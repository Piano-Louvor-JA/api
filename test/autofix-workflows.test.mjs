import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readWorkflow = (name) =>
  readFileSync(
    new URL(`../.github/workflows/${name}`, import.meta.url),
    "utf8",
  );

test("autofix detection runs unprivileged and emits only a patch artifact", () => {
  const workflow = readWorkflow("autofix.yml");
  assert.match(workflow, /push:\n {4}branches: \[staging\]/);
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(
    workflow,
    /concurrency:\n {2}group: autofix-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true/,
  );
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /npm run lint:fix/);
  assert.match(workflow, /git diff --binary --no-ext-diff > autofix\.patch/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
});

test("autofix application validates the patch without executing repository code", () => {
  const workflow = readWorkflow("autofix.yml");
  assert.match(workflow, /apply:\n {4}needs: detect/);
  assert.match(workflow, /contents: write\n {6}pull-requests: write/);
  assert.match(workflow, /git apply --check autofix\.patch/);
  assert.match(workflow, /gh pr create/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf("  apply:")), /npm /);
});
