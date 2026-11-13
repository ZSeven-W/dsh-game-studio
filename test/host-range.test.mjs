// The host evaluates engines.dsh with semver.satisfies(version, range, { includePrerelease: true }).
// This pins the same semantics in CI (where the DSH host module is unavailable), so
// the range cannot silently start accepting an older harness.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import semver from 'semver'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const range = pkg.engines?.dsh ?? ''
const allows = (version) => semver.satisfies(version, range, { includePrerelease: true })

test('the declared DSH range matches how the host evaluates it', () => {
  assert.match(range, /^>=/u, `expected a lower-bound range, got ${range}`)
  assert.equal(allows('0.2.0'), false, 'an older release must be refused')
  assert.equal(allows('0.2.1-rc.4'), false, 'a prerelease below the tested one must be refused')
  assert.equal(allows('0.2.1-rc.5'), true, 'the tested harness must be accepted')
  assert.equal(allows('0.2.1'), true, 'the same release without the prerelease tag must be accepted')
  assert.equal(allows('0.3.0'), true, 'a newer release must be accepted')
})
