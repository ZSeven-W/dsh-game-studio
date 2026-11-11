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
import { existsSync, symlinkSync, unlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readSeries } from './series.mjs'

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
const buildAfterApply = flag('--build')

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

/**
 * Remove only the node_modules link. A recursive delete on Windows follows a
 * junction and would wipe the fork's real node_modules — the first version of
 * this check did exactly that.
 */
function unlinkNodeModules(worktree) {
  const link = join(worktree, 'node_modules')
  try {
    if (!existsSync(link)) return
    if (process.platform === 'win32') spawnSync('cmd', ['/c', 'rmdir', link], { encoding: 'utf8' })
    else unlinkSync(link)
  } catch { /* best effort */ }
}

/** Apply the series, then prove it builds and the WeChat tests pass (opt-in). */
function verifyBuildIn(worktree) {
  const target = join(repo, 'node_modules')
  const link = join(worktree, 'node_modules')
  try {
    if (!existsSync(link)) {
      if (process.platform === 'win32') spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8' })
      else symlinkSync(target, link, 'dir')
    }
  } catch { /* build will report the missing dependency */ }
  report.junction = existsSync(link)

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const build = spawnSync(npm, ['run', 'build'], { cwd: worktree, shell: true, encoding: 'utf8', timeout: 300000 })
  report.build = build.status === 0 ? 'ok' : 'failed'
  if (build.status !== 0) {
    const out = String(build.stdout ?? '') + String(build.stderr ?? '')
    report.buildLog = out.trim().split(/\r?\n/u).slice(-14).join(' | ')
    report.message += '; the applied tree does not build'
    unlinkNodeModules(worktree)
    return
  }
  const files = [
    'test/wechat.test.mjs', 'test/release.test.mjs', 'test/client.test.mjs', 'test/consistency.test.mjs',
    'test/journey.test.mjs', 'test/commerce.test.mjs', 'test/size.test.mjs', 'test/devtools.test.mjs',
    'test/ci.test.mjs', 'test/review.test.mjs',
  ]
  const tests = spawnSync(process.execPath, ['--test', ...files], {
    cwd: worktree,
    encoding: 'utf8',
    timeout: 600000,
    env: { ...process.env, NODE_OPTIONS: '--experimental-strip-types' },
  })
  const out = String(tests.stdout ?? '') + String(tests.stderr ?? '')
  report.tests = {
    pass: Number(out.match(/^# pass (\d+)/mu)?.[1] ?? 0),
    fail: Number(out.match(/^# fail (\d+)/mu)?.[1] ?? 0),
    skipped: Number(out.match(/^# skipped (\d+)/mu)?.[1] ?? 0),
  }
  if (tests.status !== 0) report.message += '; the WeChat tests fail after applying the series'
  unlinkNodeModules(worktree)
}

async function applySeries() {  const patchDir = await mkdtemp(join(tmpdir(), 'dsh-upstream-patches-'))
  // Next to the checkout: esbuild's service is not allowed to write to %TEMP%.
  const worktree = await mkdtemp(join(repo, '..', '.upstream-verify-'))
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
    const series = readSeries(repo, report.base)
    if (!series.ok) {
      report.applied = false
      report.message += `; could not read the patch series (${series.error})`
      return
    }
    const am = spawnSync('git', ['am', '--3way'], {
      cwd: worktree, input: series.text, encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
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
    if (report.applied && buildAfterApply) verifyBuildIn(worktree)
  } finally {
    unlinkNodeModules(worktree)
    git(repo, ['worktree', 'remove', '--force', worktree], { allowFail: true })
    git(repo, ['worktree', 'prune'], { allowFail: true })
    await rm(patchDir, { recursive: true, force: true })
    await rm(worktree, { recursive: true, force: true })
  }
}

try {
  report.head = git(repo, ['rev-parse', 'HEAD']).out

  // Resolve upstream before the base: with full history the branch point is the
  // merge-base with upstream, not the repository root (a shallow clone's root
  // happens to be the branch point, which is why the first version worked
  // locally and would have compared against the fork itself in CI).
  if (OVERRIDE) {
    git(repo, ['fetch', '--quiet', REMOTE, OVERRIDE], { allowFail: true })
    const resolved = git(repo, ['rev-parse', '--verify', `${OVERRIDE}^{commit}`], { allowFail: true })
    report.upstream = resolved.ok ? resolved.out : null
    if (!report.upstream) {
      report.status = 'skipped'
      report.message = `cannot resolve ${OVERRIDE}`
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
      } else {
        git(repo, ['fetch', '--quiet', REMOTE, BRANCH], { allowFail: true })
      }
    }
  }

  if (report.upstream) {
    const merged = git(repo, ['merge-base', 'HEAD', report.upstream], { allowFail: true })
    report.base = (merged.ok && merged.out)
      || git(repo, ['rev-list', '--max-parents=0', 'HEAD']).out.split('\n').pop()
    report.patchCount = Number(git(repo, ['rev-list', '--count', `${report.base}..HEAD`]).out) || 0
    if (report.upstream === report.base) {
      report.status = 'up-to-date'
      report.message = 'upstream still points at the commit this fork branched from'
    } else {
      report.status = 'upstream-moved'
      report.message = `upstream moved from ${report.base.slice(0, 12)} to ${report.upstream.slice(0, 12)}`
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
  if (report.build) console.log(`  links     node_modules junction: ${report.junction}`)
  if (report.build) console.log(`  build     ${report.build}${report.buildLog ? ` — ${report.buildLog}` : ''}`)
  if (report.tests) console.log(`  tests     ${report.tests.pass} pass, ${report.tests.fail} fail, ${report.tests.skipped} skipped`)
  if (report.conflicts.length > 0) console.log(`  conflicts ${report.conflicts.join(', ')}`)
  if (report.message) console.log(`  ${report.message}`)
  if (report.status === 'upstream-moved' && report.applied) {
    console.log('  next      git rebase --onto origin/main <base> main   (or cherry-pick the series)')
  }
}

if (report.status === 'error' || report.applied === false) process.exitCode = 1
