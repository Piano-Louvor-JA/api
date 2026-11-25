#!/usr/bin/env node
/**
 * Regression Gate — pianolouvorja/api
 * Baseline: testes (vitest) + typecheck + build
 * Uso:
 *   npm run test:regression -- --baseline   (salva baseline em .regression-baseline.json)
 *   npm run test:regression -- --compare    (compara execução atual c/ baseline; falha se regressão)
 */
import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const BASELINE_FILE = resolve('.regression-baseline.json')
const isBaseline = process.argv.includes('--baseline')
const isCompare = process.argv.includes('--compare')

function run(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { ok: false, out: e.stdout?.toString() || '', err: e.stderr?.toString() || e.message }
  }
}

function jsonParseSafe(s, fallback) {
  try { return JSON.parse(s) } catch { return fallback }
}

function collectResults() {
  const results = {}

  // 1) Testes (vitest, reporter json)
  const t = run('npx vitest run --reporter=json --outputFile=.vitest-results.json')
  if (t.ok || existsSync('.vitest-results.json')) {
    const vr = jsonParseSafe(readFileSync('.vitest-results.json', 'utf8'), {})
    results.tests = {
      passed: vr.numPassedTests || 0,
      failed: vr.numFailedTests || 0,
      total: vr.numTotalTests || 0,
    }
  } else {
    results.tests = { passed: 0, failed: -1, total: 0, error: (t.err || '').slice(0, 500) }
  }

  // 2) Typecheck
  const tc = run('npm run typecheck')
  results.typecheck = { ok: tc.ok, err: tc.ok ? '' : (tc.err || '').slice(0, 500) }

  // 3) Build
  const b = run('npm run build')
  results.build = { ok: b.ok, err: b.ok ? '' : (b.err || '').slice(0, 500) }

  return results
}

if (isBaseline) {
  console.log('📊 Salvando baseline de regressão (api)...')
  const results = collectResults()
  writeFileSync(BASELINE_FILE, JSON.stringify(results, null, 2))
  console.log('✅ Baseline salvo em', BASELINE_FILE)
  console.log('   Tests:', JSON.stringify(results.tests))
  console.log('   Typecheck:', results.typecheck.ok ? 'OK' : 'FAIL')
  console.log('   Build:', results.build.ok ? 'OK' : 'FAIL')
  process.exit(results.tests.failed > 0 || !results.typecheck.ok || !results.build.ok ? 1 : 0)
}

if (isCompare || (!isBaseline && !isCompare)) {
  if (!existsSync(BASELINE_FILE)) {
    console.error('❌ Baseline não encontrado. Rode com --baseline primeiro.')
    process.exit(1)
  }
  const base = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
  console.log('📊 Comparando com baseline...')

  const failures = []
  const cur = collectResults()

  if (cur.tests.failed > base.tests.failed || cur.tests.passed < base.tests.passed) {
    failures.push(`TESTS: baseline passed=${base.tests.passed} failed=${base.tests.failed} → atual passed=${cur.tests.passed} failed=${cur.tests.failed}`)
  }
  if (base.typecheck.ok && !cur.typecheck.ok) {
    failures.push('TYPECHECK: baseline OK → atual FAIL')
  }
  if (base.build.ok && !cur.build.ok) {
    failures.push('BUILD: baseline OK → atual FAIL')
  }

  if (failures.length > 0) {
    console.error('❌ REGRESSÃO DETECTADA:')
    failures.forEach((f) => console.error('  -', f))
    process.exit(1)
  }
  console.log('✅ Sem regressão detectada.')
  process.exit(0)
}
