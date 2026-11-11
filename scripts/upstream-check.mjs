// Upstream drift check for the WeChat fork.
//
// The WeChat target lives in a fork of ZSeven-W/dsh-game-studio. Upstream moving
// is expected; losing the WeChat capability when it does is not. This script
// compares upstream main with the commit this fork branched from and proves the
// patch series still applies — in a temporary worktree, never in the working tree.
//
//   node scripts/upstream-check.mjs [--json] [--no-apply]
//   node scripts/upstream-check.mjs --upstream <ref>   # check against any ref
//
// Exit codes: 0 = up to date and applying cleanly (or skipped because the remote
// or ref is unavailable), 1 = the series no longer applies.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const asJson = flag('--json')
const skipApply = flag('--no-apply')
const REMOTE = value('--remote', 'origin')
const BRANCH = value('--branch', 'main')
const OVERRIDE = value('--upstream', null)

function git(cwd, argv, { allowFail = false } = {}) {
  const result = spawnSync('git', argv, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${argv.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`)
  }
  return { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() }
}

const report = {
  at: new Date().toISOString(),
  remote: REMOTE,
  branch: BRANCH,
  status: 'unknown',
  upstream: null,
  base: null,
  head: null,
  patchCount: 0,
  applied: null,
  conflicts: [],
  message: '',
}

async function applySeries() {
  const patchDir = await mkdtemp(join(tmpdir(), 'dsh-upstream-patches-'))
  const worktree = await mkdtemp(join(tmpdir(), 'dsh-upstream-apply-'))
  try {
    if (report.upstream !== report.base) git(repo, ['fetch', '--quiet', REMOTE, report.upstream], { allowFail: true })
    const serialised = git(repo, ['format-patch', `${report.base}..HEAD`, '-o', patchDir, '--no-signature'], { allowFail: true })
    if (!serialised.ok) {
      report.applied = false
      report.message += '; could not serialise the patch series'
      return
    }
    const add = git(repo, ['worktree', 'add', '--detach', worktree, report.upstream], { allowFail: true })
    if (!add.ok) {
      report.applied = false
      report.message += `; could not create a worktree at ${report.upstream.slice(0, 12)}`
      return
    }
    const patches = spawnSync('git', ['format-patch', '--stdout', `${report.base}..HEAD`], { cwd: repo, encoding: 'utf8' })
    const am = spawnSync('git', ['am', '--3way'], { cwd: worktree, input: patches.stdout, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    report.applied = am.status === 0
    if (!report.applied) {
      report.conflicts = git(worktree, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).out
        .split('\n').map((line) => line.trim()).filter(Boolean)
      git(worktree, ['am', '--abort'], { allowFail: true })
      return
    }
    // On an unchanged upstream the applied tree must be byte-identical to ours.
    if (report.upstream === report.base) {
      const appliedTree = git(worktree, ['rev-parse', 'HEAD^{tree}']).out
      const localTree = git(repo, ['rev-parse', 'HEAD^{tree}']).out
      if (appliedTree !== localTree) {
        report.applied = false
        report.conflicts = ['tree hash differs from the working fork']
      }
    }
  } finally {
    git(repo, ['worktree', 'remove', '--force', worktree], { allowFail: true })
    git(repo, ['worktree', 'prune'], { allowFail: true })
    await rm(patchDir, { recursive: true, force: true })
    await rm(worktree, { recursive: true, force: true })
  }
}

try {
  report.base = git(repo, ['rev-list', '--max-parents=0', 'HEAD']).out.split('\n').pop()
  report.head = git(repo, ['rev-parse', 'HEAD']).out
  report.patchCount = Number(git(repo, ['rev-list', '--count', `${report.base}..HEAD`]).out) || 0

  if (OVERRIDE) {
    git(repo, ['fetch', '--quiet', REMOTE, OVERRIDE], { allowFail: true })
    const resolved = git(repo, ['rev-parse', '--verify', `${OVERRIDE}^{commit}`], { allowFail: true })
    report.upstream = resolved.ok ? resolved.out : null
    if (!report.upstream) {
      report.status = 'skipped'
      report.message = `cannot resolve ${OVERRIDE}`
    } else {
      report.status = report.upstream === report.base ? 'up-to-date' : 'upstream-moved'
      report.message = `checking against ${OVERRIDE}`
    }
  } else {
    const remote = git(repo, ['ls-remote', '--heads', REMOTE, BRANCH], { allowFail: true })
    if (!remote.ok) {
      report.status = 'skipped'
      report.message = `cannot reach ${REMOTE}/${BRANCH}: ${(remote.err || remote.out).slice(0, 200)}`
    } else {
      report.upstream = remote.out.split(/\s+/)[0] || null
      if (!report.upstream) {
        report.status = 'skipped'
        report.message = `${REMOTE}/${BRANCH} does not exist (or has no commits)`
      } else if (report.upstream === report.base) {
        report.status = 'up-to-date'
        report.message = 'upstream still points at the commit this fork branched from'
      } else {
        report.status = 'upstream-moved'
        report.message = `upstream moved from ${report.base.slice(0, 12)} to ${report.upstream.slice(0, 12)}`
      }
    }
  }

  if (!skipApply && report.status !== 'skipped' && report.upstream) await applySeries()
} catch (error) {
  report.status = 'error'
  report.message = String((error && error.message) || error)
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`upstream ${REMOTE}/${BRANCH}: ${report.status}`)
  console.log(`  base      ${report.base ? report.base.slice(0, 12) : '?'}`)
  console.log(`  upstream  ${report.upstream ? report.upstream.slice(0, 12) : '?'}`)
  console.log(`  head      ${report.head ? report.head.slice(0, 12) : '?'} (${report.patchCount} patches)`)
  if (report.applied !== null) console.log(`  series    ${report.applied ? 'applies cleanly' : 'no longer applies'}`)
  if (report.conflicts.length > 0) console.log(`  conflicts ${report.conflicts.join(', ')}`)
  if (report.message) console.log(`  ${report.message}`)
  if (report.status === 'upstream-moved' && report.applied) {
    console.log('  next      git rebase --onto origin/main <base> main   (or cherry-pick the series)')
  }
}

if (report.status === 'error' || report.applied === false) process.exitCode = 1
