import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readWorkflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')

test('autofix detection runs unprivileged and emits only a patch artifact', () => {
  const workflow = readWorkflow('autofix.yml')
  assert.match(workflow, /push:\n    branches: \[staging\]/)
  assert.match(workflow, /permissions:\n  contents: read/)
  assert.match(workflow, /concurrency:\n  group: autofix-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true/)
  assert.match(workflow, /npm ci --ignore-scripts/)
  assert.match(workflow, /npm run lint:fix/)
  assert.match(workflow, /git diff --binary --no-ext-diff > autofix\.patch/)
  assert.match(workflow, /actions\/upload-artifact@v4/)
})

test('autofix application validates the patch without executing repository code', () => {
  const workflow = readWorkflow('autofix.yml')
  assert.match(workflow, /apply:\n    needs: detect/)
  assert.match(workflow, /contents: write\n      pull-requests: write/)
  assert.match(workflow, /git apply --check autofix\.patch/)
  assert.match(workflow, /gh pr create/)
  assert.doesNotMatch(workflow.slice(workflow.indexOf('  apply:')), /npm /)
})

test('autofix PRs merge only after green checks and close on a failed check', () => {
  const workflow = readWorkflow('autofix-finalize.yml')
  assert.match(workflow, /pull_request_target:/)
  assert.match(workflow, /check_suite:/)
  assert.match(workflow, /pull\.head\.ref\.startsWith\('autofix\/staging\/'\)/)
  assert.match(workflow, /github\.rest\.pulls\.merge/)
  assert.match(workflow, /merge_method: 'squash'/)
  assert.match(workflow, /if \(!result\.data\.merged\)/)
  assert.match(workflow, /github\.rest\.pulls\.update[\s\S]*state: 'closed'/)
  assert.match(workflow, /github\.rest\.git\.deleteRef/)
})
