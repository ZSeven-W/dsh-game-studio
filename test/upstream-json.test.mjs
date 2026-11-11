// The --json contract of the upstream check: the nightly workflow and any dashboard
// parse this, so its shape (and a clean exit code) is pinned. No --build here: that
// worktree run is slow and covered by the fork's own checks.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

test('upstream-check --json reports the fork versus upstream and exits 0 on a clean tree', () => {
  const out = execFileSync(process.execPath, ['scripts/upstream-check.mjs', '--json', '--no-apply'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 180_000,
  })
  const report = JSON.parse(out.slice(out.indexOf('{')))
  assert.ok(['up-to-date', 'upstream-moved'].includes(report.status), `status ${report.status}`)
  assert.match(report.base, /^[0-9a-f]{40}$/u)
  assert.match(report.upstream, /^[0-9a-f]{40}$/u)
  assert.match(report.head, /^[0-9a-f]{40}$/u)
  // --no-apply: the fast path must say so instead of claiming it applied.
  assert.equal(report.applied, null)
  assert.ok(report.patchCount >= 100, `patchCount ${report.patchCount}`)
  // The recovery hint is what a maintainer sees when the series stops applying.
  assert.equal(typeof report.recovery, 'string')
  assert.ok(Array.isArray(report.conflicts))
})
