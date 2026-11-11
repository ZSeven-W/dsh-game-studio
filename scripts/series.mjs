import { spawnSync } from 'node:child_process'

/**
 * Serialise `base..HEAD` as one mbox string.
 *
 * The buffer must be far above spawnSync's 1 MB default: the 97-patch WeChat series
 * is ~1.07 MB of UTF-8, and a truncated series makes `git am` apply only part of it
 * while still exiting 0 — which used to look like "the series no longer applies".
 */
export function readSeries(repo, base, { git = 'git' } = {}) {
  const result = spawnSync(git, ['format-patch', '--stdout', `${base}..HEAD`], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) return { ok: false, text: '', error: result.error.code || result.error.message }
  if (result.status !== 0) return { ok: false, text: '', error: (result.stderr || result.stdout || '').trim().slice(0, 300) }
  return { ok: true, text: result.stdout, error: '' }
}

/** How many patches a mbox string starts: one "From <sha>" line per commit. */
export function countPatches(series) {
  return (series.match(/^From [0-9a-f]{40} /gmu) || []).length
}
