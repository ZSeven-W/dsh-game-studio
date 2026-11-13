// The host requirement is stated in three places: package.json engines, the README,
// and the CI workflow. They must agree, and a development machine below the range
// should be a known difference, not a surprise.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const check = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8')

const required = pkg.engines?.node ?? ''
const requiredMajor = Number(required.match(/>=(\d+)/u)?.[1])

test('the README states the same Node major as package.json engines', () => {
  assert.ok(requiredMajor >= 18, `unexpected engines.node: ${required}`)
  const documented = readme.match(/Node\.js `(\d+)\.(\d+)` or later/u)
  assert.ok(documented, 'the README should state the Node requirement')
  assert.equal(Number(documented[1]), requiredMajor, `README says ${documented[1]}.${documented[2]}, engines says ${required}`)
})

test('CI runs a Node major that satisfies the declared engines', () => {
  const major = Number(check.match(/node-version:\s*'?(\d+)'?/u)?.[1])
  assert.ok(major >= requiredMajor, `CI uses Node ${major}, engines requires ${required}`)
})

test('the DSH host requirement is declared and documented', () => {
  const range = pkg.engines?.dsh ?? ''
  assert.match(range, /^>=?\d+\.\d+\.\d+/u, `engines.dsh should be a semver range, got ${range}`)
  const documented = readme.match(/DeepSeek Harness `([\d.]+(?:-rc\.\d+)?)` or later/u)?.[1]
  assert.ok(documented, 'the README should state the DSH requirement')
  assert.equal(range, `>=${documented}`, `README says ${documented}, engines.dsh says ${range}`)
})

test('the lower bound is the DSH version the plugin is tested with', () => {
  // Refusing hosts older than the one actually tested is honest; refusing newer ones
  // (or claiming support below the tested version) is not.
  const tested = readme.match(/Tested with DSH <code>([\d.]+(?:-rc\.\d+)?)<\/code>/u)?.[1]
  assert.ok(tested, 'the README should state the tested DSH version')
  assert.equal(pkg.engines?.dsh, `>=${tested}`, `engines.dsh is ${pkg.engines?.dsh}, tested is ${tested}`)
})
