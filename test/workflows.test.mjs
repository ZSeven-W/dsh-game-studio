// The CI workflows are part of the deliverable: they are how a maintainer
// re-verifies the branch without this machine. A silently removed evidence step
// would still leave the tests green, so the files are checked here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const check = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8')
const drift = readFileSync(new URL('../.github/workflows/upstream-drift.yml', import.meta.url), 'utf8')

test('CI runs the acceptance and screenshot evidence inside the workspace', () => {
  assert.match(check, /node-version: '24'/u)
  assert.match(check, /npm run build/u)
  assert.match(check, /npm test/u)
  // Relative to the checkout: a "../artifacts" path is outside the workspace and
  // upload-artifact refuses it.
  assert.match(check, /npm run acceptance -- --out artifacts\/acceptance/u)
  assert.match(check, /npm run shots -- --out artifacts\/sidebar/u)
  assert.doesNotMatch(check, /\.\.\/artifacts/u)
  assert.match(check, /npm run trace/u)
})

test('a red CI run prints the acceptance report and still uploads the evidence', () => {
  assert.match(check, /name: Acceptance report tail/u)
  assert.match(check, /tail -n 40 artifacts\/acceptance\/REPORT\.md/u)
  assert.match(check, /actions\/upload-artifact@v4/u)
  assert.match(check, /if: always\(\)/u)
  assert.match(check, /artifacts\/acceptance/u)
  assert.match(check, /artifacts\/sidebar/u)
})

test('the nightly drift job applies, builds and tests the series on upstream', () => {
  assert.match(drift, /cron: '0 19 \* \* \*'/u)
  assert.match(drift, /workflow_dispatch:/u)
  assert.match(drift, /remote add upstream/u)
  assert.match(drift, /npm run upstream -- --remote upstream --build --out artifacts\/upstream-drift\/report\.json/u)
  // The JSON report is the CI evidence: keep it even when the check fails.
  assert.match(drift, /actions\/upload-artifact@v4/u)
  assert.match(drift, /if: always\(\)/u)
  assert.match(drift, /artifacts\/upstream-drift\/report\.json/u)
})
