// The changelog names the commit behind every entry, and the upgrade notes must
// call out behaviour changes. This keeps it honest: a hash that does not exist on
// the branch fails, and so does dropping the Midas or subpackage note.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const text = readFileSync(new URL('../docs/CHANGELOG.md', import.meta.url), 'utf8')
const hashes = [...text.matchAll(/\(([0-9a-f]{7})\)/gu)].map((match) => match[1])

function branchHashes() {
  try {
    const depth = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }))
    if (depth < 2) return null
    return new Set(execFileSync('git', ['log', '--format=%h'], { encoding: 'utf8' }).split('\n').filter(Boolean))
  } catch {
    return null
  }
}

test('every changelog entry points at a commit on this branch', (t) => {
  const known = branchHashes()
  if (!known) {
    t.skip('git history is not available here (shallow clone)')
    return
  }
  assert.ok(hashes.length >= 30, `expected many entries, found ${hashes.length}`)
  const missing = [...new Set(hashes)].filter((hash) => !known.has(hash))
  assert.deepEqual(missing, [], `changelog names commits that do not exist: ${missing.join(', ')}`)
})

test('the upgrade notes call out the behaviour changes', () => {
  assert.match(text, /## Upgrading from the plain Game Studio build/u)
  assert.match(text, /requestMidasPaymentGameItem/u)
  assert.match(text, /subpackages/u)
  assert.match(text, /game_ad_error/u)
  // Removing the Midas switch from the notes would ship a silently broken purchase.
  assert.ok(hashes.includes('d1d3894'), 'the Midas API switch must stay named with its commit')
})
