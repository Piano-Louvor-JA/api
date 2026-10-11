import assert from "node:assert/strict";
import { test } from "node:test";
import { coverageThreshold } from "./coverage-policy.mjs";

test("PR targeting staging uses 50 regardless of its source branch", () => {
  assert.equal(coverageThreshold({eventName:"pull_request",baseRef:"staging",ref:"refs/pull/189/merge"}),50);
});
test("promotion targeting main stays at 100 even with a staging source", () => {
  assert.equal(coverageThreshold({eventName:"pull_request",baseRef:"main",ref:"refs/heads/staging"}),100);
});
test("main, tags and unknown events never use the staging threshold", () => {
  for(const input of [{eventName:"push",ref:"refs/heads/main"},{eventName:"push",ref:"refs/tags/v1.6.0"},{eventName:"workflow_dispatch",ref:"refs/heads/main"},{eventName:"pull_request"},{}]) assert.equal(coverageThreshold(input),100);
});
test("staging integration and manual validation use the staging threshold", () => {
  for(const eventName of ["push","workflow_dispatch"]) assert.equal(coverageThreshold({eventName,ref:"refs/heads/staging"}),50);
});
