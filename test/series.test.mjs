import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countPatches, readSeries, recoveryHint } from '../scripts/series.mjs'

const git = (cwd, argv) => execFileSync('git', argv, {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
})

/**
 * Build a repo whose serialised series is larger than spawnSync's 1 MB default.
 * A truncated series applies only the first part and exits 0, so the regression is
 * silent — the delimiter count is what catches it.
 */
async function bigSeriesRepo(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-series-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  await writeFile(join(root, 'base.txt'), 'base\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-q', '-m', 'base'])
  const base = git(root, ['rev-parse', 'HEAD']).trim()
  // ~60 KB of CJK per commit over 25 commits: past 1 MB of patch text.
  const block = '发布材料与驳回原因'.repeat(2000)
  for (let index = 0; index < 25; index += 1) {
    await writeFile(join(root, `part-${index}.txt`), `${block}${index}\n`)
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', `提交 ${index}：小程序备案与适龄提示`])
  }
  return { root, base, commits: 25 }
}

test('readSeries returns the whole series even when it passes one megabyte', async (t) => {
  const { root, base, commits } = await bigSeriesRepo(t)
  const result = readSeries(root, base)
  assert.equal(result.ok, true, result.error)
  const bytes = Buffer.byteLength(result.text, 'utf8')
  assert.ok(bytes > 1024 * 1024, `the fixture must exceed the old limit, got ${bytes} bytes`)
  assert.equal(countPatches(result.text), commits, 'every commit is in the series, not just the first megabyte')
})

test('readSeries reports a bad revision instead of an empty series', async (t) => {
  const { root } = await bigSeriesRepo(t)
  const result = readSeries(root, 'does-not-exist')
  assert.equal(result.ok, false)
  assert.match(result.error, /unknown revision|bad revision|not a valid/iu)
})

test('a conflict carries the rebase command with the real commits', () => {
  const hint = recoveryHint({
    upstream: 'aaaaaaaaaaaa1111',
    base: 'bbbbbbbbbbbb2222',
    applied: false,
    conflicts: ['src/index.ts', 'src/wx.ts'],
  })
  assert.match(hint, /git rebase --onto aaaaaaaaaaaa bbbbbbbbbbbb main/u)
  assert.match(hint, /src\/index\.ts, src\/wx\.ts/u)
  assert.match(hint, /rerun npm run upstream -- --build/u)

  // No hint when it applied, or when nothing specific conflicted.
  assert.equal(recoveryHint({ upstream: 'a', base: 'b', applied: true, conflicts: ['x'] }), '')
  assert.equal(recoveryHint({ upstream: 'a', base: 'b', applied: false, conflicts: [] }), '')
})
