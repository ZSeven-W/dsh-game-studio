/**
 * Publish games (or the game wall) to GitHub Pages through the user's local,
 * already-signed-in GitHub CLI (`gh`). The plugin never touches tokens, never
 * installs or signs in to `gh` itself, and refuses to write to any existing
 * repository that does not carry its `.dsh-game-studio.json` marker file.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { sha256, StudioError } from './util.ts'

export const DEFAULT_GITHUB_REPO = 'dsh-games'
export const REPO_MARKER_FILE = '.dsh-game-studio.json'
export const GAMES_FEED_FILE = 'games.json'
export const DEFAULT_PAGES_TIMEOUT_MS = 180_000
const DEFAULT_PAGES_POLL_MS = 5_000

// eslint-disable-next-line no-control-regex -- stripping terminal escape sequences from gh output
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/gu

export const NO_GH_AGENT_HINT = '(Tell the user how to install gh and run `gh auth login`; do not download, install, or run `gh auth login` yourself.)'
export const GH_AUTH_AGENT_HINT = '(Tell the user to run `gh auth login` in their terminal; do not run `gh auth login` yourself.)'

export interface StudioRepoGame {
  title: string
  source: string
  publishedAt: string
  buildId: string
  dimension?: '2d' | '3d'
  orientation?: 'portrait' | 'landscape'
  cover?: string | null
}

export interface StudioRepoManifest {
  tool: 'dsh-game-studio'
  version: 1
  games: Record<string, StudioRepoGame>
  wall: { publishedAt: string; games: number } | null
}

export interface GamesFeedItem {
  slug: string
  title: string
  url: string
  cover: string | null
  dimension?: '2d' | '3d'
  orientation: 'portrait' | 'landscape'
  publishedAt: string
}

export interface GamesFeed {
  format: 'dsh-games-feed'
  version: 1
  name: string
  author: string
  updatedAt: string
  games: GamesFeedItem[]
  wall: string | null
}

export interface PublishedRecord {
  url: string
  siteUrl: string
  repo: string
  slug: string
  publishedAt: string
  buildId: string
  status: 'built' | 'building'
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function findGh(configured?: string): string | undefined {
  if (configured !== undefined && configured !== '') {
    return isExecutable(configured) ? configured : undefined
  }
  const names = process.platform === 'win32' ? ['gh.exe', 'gh'] : ['gh']
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutable(candidate)) return candidate
    }
  }
  if (process.platform !== 'win32') {
    for (const candidate of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

export function ghInstallCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'winget install --id GitHub.cli'
  if (platform === 'linux') return 'https://cli.github.com'
  return 'brew install gh'
}

export function ghInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return 'Install GitHub CLI with `winget install --id GitHub.cli` (macOS: `brew install gh`; other platforms: https://cli.github.com), then sign in with `gh auth login`.'
  }
  if (platform === 'linux') {
    return 'Install GitHub CLI from https://cli.github.com (macOS: `brew install gh`; Windows: `winget install --id GitHub.cli`), then sign in with `gh auth login`.'
  }
  return 'Install GitHub CLI with `brew install gh` (Windows: `winget install --id GitHub.cli`; other platforms: https://cli.github.com), then sign in with `gh auth login`.'
}

export function requireGh(configured?: string, platform: NodeJS.Platform = process.platform): string {
  const found = findGh(configured)
  if (found !== undefined) return found
  throw new StudioError(
    `GitHub CLI (gh) is required to publish to GitHub Pages and was not found on this computer. ${ghInstallHint(platform)}`,
    'NO_GH',
  )
}

function tailLines(text: string, lines = 10): string {
  return text.replace(ANSI, '').trim().split(/\r?\n/u).map(line => line.trim()).filter(Boolean).slice(-lines).join(' | ').slice(0, 800)
}

interface GhApiError extends Error {
  status?: number
  stderr: string
  stdout: string
  exitCode: number | null
}

const GH_RETRY_DELAYS_MS = [1_000, 3_000]

export function isRetryableGhEndpoint(method: string, endpoint: string): boolean {
  if (method === 'GET') return true
  if (method === 'POST' && /^repos\/[^/]+\/[^/]+\/git\/(blobs|trees|commits)$/u.test(endpoint)) return true
  if (method === 'PATCH' && /^repos\/[^/]+\/[^/]+\/git\/refs\//u.test(endpoint)) return true
  return false
}

export function isTransientGhError(error: unknown): boolean {
  if (error instanceof StudioError) return false
  const ghErr = error as Partial<GhApiError>
  const status = ghErr.status
  if (status === 502 || status === 503 || status === 504) return true
  if (status !== undefined && status >= 400 && status < 500) return false
  const combined = `${ghErr.stderr ?? ''}\n${ghErr.stdout ?? ''}\n${error instanceof Error ? error.message : String(error)}`
  return /\bEOF\b|connection reset|ECONNRESET|ETIMEDOUT|TLS handshake|i\/o timeout|timed out|socket hang up|unexpected EOF|net\/http: TLS|stream error|HTTP (502|503|504)/iu.test(combined)
}

async function ghApiOnce<T = any>(
  gh: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  endpoint: string,
  input?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (!isExecutable(gh)) {
    throw new StudioError(
      `GitHub CLI (gh) is required to publish to GitHub Pages and was not found on this computer. ${ghInstallHint()}`,
      'NO_GH',
    )
  }
  let tempFile: string | undefined
  if (input !== undefined) {
    tempFile = join(tmpdir(), `dsh-gh-${process.pid}-${randomBytes(6).toString('hex')}.json`)
    await writeFile(tempFile, JSON.stringify(input), 'utf8')
  }
  const args = ['api']
  if (method !== 'GET') args.push('-X', method)
  args.push(endpoint)
  if (tempFile !== undefined) args.push('--input', tempFile)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
  }
  delete env.FORCE_COLOR

  try {
    return await new Promise<T>((resolve, reject) => {
      const child = spawn(gh, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let settled = false

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        fn()
      }

      const onAbort = () => {
        finish(() => {
          try { child.kill('SIGTERM') } catch { /* already gone */ }
          reject(new StudioError('GitHub publish was cancelled.', 'CANCELLED'))
        })
      }

      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout?.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk) })
      child.stderr?.on('data', (chunk: Buffer) => { stderrChunks.push(chunk) })

      child.once('error', (err: NodeJS.ErrnoException) => {
        finish(() => {
          if (err.code === 'ENOENT') {
            reject(new StudioError(
              `GitHub CLI (gh) was not found at ${gh}. ${ghInstallHint()}`,
              'NO_GH',
            ))
            return
          }
          reject(new StudioError(`Could not run gh: ${err.message}`, 'GH_FAILED'))
        })
      })

      child.once('close', (code) => {
        finish(() => {
          const stdout = Buffer.concat(stdoutChunks).toString('utf8').replace(ANSI, '').trim()
          const stderr = Buffer.concat(stderrChunks).toString('utf8').replace(ANSI, '').trim()
          if (code === 0) {
            if (!stdout) {
              resolve({} as T)
              return
            }
            try {
              resolve(JSON.parse(stdout) as T)
            } catch {
              reject(new StudioError(`gh api ${endpoint} returned invalid JSON: ${tailLines(stdout, 5)}`, 'GH_FAILED'))
            }
            return
          }
          const combined = `${stderr}\n${stdout}`
          let status: number | undefined
          const statusMatch = /HTTP (\d{3})/iu.exec(combined)
          if (statusMatch) status = Number(statusMatch[1])
          if (status === undefined) {
            try {
              const parsed = JSON.parse(stdout) as { status?: unknown; message?: unknown }
              if (typeof parsed?.status === 'number') status = parsed.status
              else if (typeof parsed?.status === 'string' && /^\d{3}$/u.test(parsed.status)) status = Number(parsed.status)
              else if (parsed?.message === 'Not Found') status = 404
            } catch { /* ignore */ }
          }
          if (status === undefined && /\b404\b|Not Found/iu.test(combined)) status = 404
          if (status === undefined && /\b409\b|Conflict|already exists/iu.test(combined)) status = 409
          if (status === undefined && /\b422\b|Unprocessable/iu.test(combined)) status = 422
          const detail = tailLines(stderr || stdout, 10)
          const error = Object.assign(
            new Error(`gh api ${method} ${endpoint} failed (exit ${code ?? 'null'})${detail ? `: ${detail}` : ''}`),
            { status, stderr, stdout, exitCode: code },
          ) as GhApiError
          reject(error)
        })
      })
    })
  } finally {
    if (tempFile !== undefined) {
      await rm(tempFile, { force: true }).catch(() => undefined)
    }
  }
}

async function ghApi<T = any>(
  gh: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  endpoint: string,
  input?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const retryable = isRetryableGhEndpoint(method, endpoint)
  let attempt = 0
  for (;;) {
    try {
      return await ghApiOnce<T>(gh, method, endpoint, input, signal)
    } catch (error) {
      if (!retryable || attempt >= GH_RETRY_DELAYS_MS.length || !isTransientGhError(error)) {
        throw error
      }
      const delayMs = GH_RETRY_DELAYS_MS[attempt]!
      attempt += 1
      await sleep(delayMs, signal)
    }
  }
}

export async function ghLogin(gh: string): Promise<string> {
  if (!gh || !isExecutable(gh)) {
    throw new StudioError(
      `GitHub CLI (gh) is required to publish to GitHub Pages and was not found on this computer. ${ghInstallHint()}`,
      'NO_GH',
    )
  }
  try {
    const user = await ghApi<{ login?: unknown }>(gh, 'GET', 'user')
    if (typeof user?.login === 'string' && user.login.trim().length > 0) {
      return user.login.trim()
    }
    throw new StudioError('GitHub CLI (gh) is not signed in. Run `gh auth login` in your terminal first.', 'GH_NOT_LOGGED_IN')
  } catch (error) {
    if (error instanceof StudioError) throw error
    const ghErr = error as Partial<GhApiError>
    const combined = `${ghErr.stderr ?? ''}\n${ghErr.stdout ?? ''}\n${error instanceof Error ? error.message : String(error)}`
    if (ghErr.status === 401 || /gh auth login|not logged in|bad credentials|HTTP 401/iu.test(combined)) {
      throw new StudioError('GitHub CLI (gh) is not signed in. Run `gh auth login` in your terminal first.', 'GH_NOT_LOGGED_IN')
    }
    const detail = tailLines(ghErr.stderr || ghErr.stdout || (error instanceof Error ? error.message : String(error)), 6)
    throw new StudioError(
      `Could not connect to GitHub via gh${detail ? `: ${detail}` : ''}`,
      'GH_FAILED',
    )
  }
}

export async function repoExists(
  gh: string,
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<{ exists: boolean; defaultBranch: string }> {
  try {
    const data = await ghApi<{ default_branch?: unknown }>(gh, 'GET', `repos/${owner}/${repo}`, undefined, signal)
    const defaultBranch = typeof data?.default_branch === 'string' && data.default_branch.trim()
      ? data.default_branch.trim()
      : 'main'
    return { exists: true, defaultBranch }
  } catch (error) {
    if ((error as Partial<GhApiError>).status === 404) return { exists: false, defaultBranch: 'main' }
    if (error instanceof StudioError) throw error
    throw new StudioError(error instanceof Error ? error.message : String(error), 'GH_FAILED')
  }
}

export async function createRepo(
  gh: string,
  repo: string,
  signal?: AbortSignal,
): Promise<{ defaultBranch: string }> {
  try {
    const data = await ghApi<{ default_branch?: unknown }>(gh, 'POST', 'user/repos', {
      name: repo,
      description: 'Games made with DSH Game Studio',
      private: false,
      auto_init: true,
      has_issues: false,
      has_wiki: false,
      has_projects: false,
    }, signal)
    const defaultBranch = typeof data?.default_branch === 'string' && data.default_branch.trim()
      ? data.default_branch.trim()
      : 'main'
    return { defaultBranch }
  } catch (error) {
    if (error instanceof StudioError) throw error
    throw new StudioError(error instanceof Error ? error.message : String(error), 'GH_FAILED')
  }
}

function repoNotOursError(owner: string, repo: string): StudioError {
  const err = new StudioError(
    `Repository ${owner}/${repo} already exists and was not created by dsh-game-studio (missing ${REPO_MARKER_FILE} marker). `
    + 'Set githubRepo in the plugin config to a different repository name.',
    'REPO_NOT_OURS',
  )
  ;(err as StudioError & { repo?: string }).repo = `${owner}/${repo}`
  return err
}

export function verifyRepoMarker(manifest: unknown, owner: string, repo: string): StudioRepoManifest {
  if (!manifest || typeof manifest !== 'object' || (manifest as { tool?: unknown }).tool !== 'dsh-game-studio') {
    throw repoNotOursError(owner, repo)
  }
  const raw = manifest as Partial<StudioRepoManifest>
  const games = raw.games && typeof raw.games === 'object' && !Array.isArray(raw.games) ? { ...raw.games } : {}
  const wall = raw.wall && typeof raw.wall === 'object' && typeof raw.wall.publishedAt === 'string' && typeof raw.wall.games === 'number'
    ? { publishedAt: raw.wall.publishedAt, games: raw.wall.games }
    : null
  return { tool: 'dsh-game-studio', version: 1, games, wall }
}

export async function loadRepoManifest(
  gh: string,
  owner: string,
  repo: string,
  branch = 'main',
  signal?: AbortSignal,
): Promise<StudioRepoManifest> {
  try {
    const ref = await ghApi<{ object?: { sha?: string }; sha?: string }>(gh, 'GET', `repos/${owner}/${repo}/git/ref/heads/${branch}`, undefined, signal)
    const commitSha = ref.object?.sha ?? ref.sha
    if (!commitSha) throw repoNotOursError(owner, repo)
    const commit = await ghApi<{ tree?: { sha?: string } }>(gh, 'GET', `repos/${owner}/${repo}/git/commits/${commitSha}`, undefined, signal)
    const baseTreeSha = commit.tree?.sha
    if (!baseTreeSha) throw repoNotOursError(owner, repo)
    const tree = await ghApi<{ tree?: Array<{ path?: string; type?: string; sha?: string }> }>(
      gh, 'GET', `repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`, undefined, signal,
    )
    const entry = (tree.tree ?? []).find(item => item.path === REPO_MARKER_FILE && item.type !== 'tree' && typeof item.sha === 'string')
    if (!entry?.sha) throw repoNotOursError(owner, repo)
    const blob = await ghApi<{ content?: string }>(gh, 'GET', `repos/${owner}/${repo}/git/blobs/${entry.sha}`, undefined, signal)
    if (typeof blob.content !== 'string') throw repoNotOursError(owner, repo)
    const text = Buffer.from(blob.content.replace(/\s+/gu, ''), 'base64').toString('utf8')
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw repoNotOursError(owner, repo) }
    return verifyRepoMarker(parsed, owner, repo)
  } catch (error) {
    if (error instanceof StudioError) throw error
    if ((error as Partial<GhApiError>).status === 404) throw repoNotOursError(owner, repo)
    throw new StudioError(error instanceof Error ? error.message : String(error), 'GH_FAILED')
  }
}

export function emptyRepoManifest(): StudioRepoManifest {
  return { tool: 'dsh-game-studio', version: 1, games: {}, wall: null }
}

export function projectSourceId(dir: string): string {
  return sha256(dir).slice(0, 16)
}

export function slugFromDir(dir: string): string {
  const cleaned = basename(dir).toLowerCase().replace(/[^a-z0-9-]/gu, '').replace(/^-+|-+$/gu, '')
  return cleaned || 'game'
}

export function pickGameSlug(dir: string, games: Record<string, StudioRepoGame>): string {
  const source = projectSourceId(dir)
  for (const [slug, info] of Object.entries(games)) {
    if (info.source === source) return slug
  }
  const base = slugFromDir(dir)
  if (games[base] === undefined) return base
  let index = 2
  while (games[`${base}-${index}`] !== undefined) index += 1
  return `${base}-${index}`
}

function matchesRemovePrefix(filePath: string, prefix: string): boolean {
  const clean = prefix.replace(/^\/+|\/+$/gu, '')
  if (!clean) return false
  return filePath === clean || filePath.startsWith(`${clean}/`)
}

const INITIAL_REF_RETRY_INTERVAL_MS = 1_000
const INITIAL_REF_RETRY_TIMEOUT_MS = 15_000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StudioError('GitHub publish was cancelled.', 'CANCELLED'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new StudioError('GitHub publish was cancelled.', 'CANCELLED'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function readBranchRef(
  gh: string,
  owner: string,
  repo: string,
  branch: string,
  retryInitialRef: boolean,
  signal?: AbortSignal,
): Promise<{ object?: { sha?: string }; sha?: string }> {
  const deadline = Date.now() + INITIAL_REF_RETRY_TIMEOUT_MS
  for (;;) {
    try {
      return await ghApi<{ object?: { sha?: string }; sha?: string }>(
        gh, 'GET', `repos/${owner}/${repo}/git/ref/heads/${branch}`, undefined, signal,
      )
    } catch (error) {
      const status = (error as Partial<GhApiError>).status
      if (retryInitialRef && (status === 404 || status === 409) && Date.now() < deadline) {
        await sleep(INITIAL_REF_RETRY_INTERVAL_MS, signal)
        continue
      }
      throw error
    }
  }
}

export async function publishFiles(opts: {
  gh: string
  owner: string
  repo: string
  branch?: string
  retryInitialRef?: boolean
  files: Array<{ path: string; content: Buffer }>
  remove?: string[]
  message: string
  signal?: AbortSignal
}): Promise<{ commit: string }> {
  const { gh, owner, repo, branch = 'main', retryInitialRef = false, files, remove, message, signal } = opts
  try {
    const ref = await readBranchRef(gh, owner, repo, branch, retryInitialRef, signal)
    const currentCommit = ref.object?.sha ?? ref.sha
    if (!currentCommit) throw new StudioError(`Could not read ${branch} branch of ${owner}/${repo}`, 'GH_FAILED')

    const commitData = await ghApi<{ tree?: { sha?: string } }>(gh, 'GET', `repos/${owner}/${repo}/git/commits/${currentCommit}`, undefined, signal)
    const baseTree = commitData.tree?.sha
    if (!baseTree) throw new StudioError(`Could not read base tree of ${owner}/${repo}`, 'GH_FAILED')

    const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> = []
    const uploadedPaths = new Set<string>()

    for (const file of files) {
      const path = file.path.replace(/^\/+/gu, '')
      const blob = await ghApi<{ sha?: string }>(gh, 'POST', `repos/${owner}/${repo}/git/blobs`, {
        content: file.content.toString('base64'),
        encoding: 'base64',
      }, signal)
      if (!blob.sha) throw new StudioError(`Could not create blob for ${path}`, 'GH_FAILED')
      uploadedPaths.add(path)
      treeEntries.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
    }

    if (remove && remove.length > 0) {
      const fullTree = await ghApi<{ tree?: Array<{ path?: string; type?: string }> }>(
        gh, 'GET', `repos/${owner}/${repo}/git/trees/${baseTree}?recursive=1`, undefined, signal,
      )
      for (const item of fullTree.tree ?? []) {
        if (!item.path || item.type === 'tree' || uploadedPaths.has(item.path)) continue
        if (remove.some(prefix => matchesRemovePrefix(item.path!, prefix))) {
          treeEntries.push({ path: item.path, mode: '100644', type: 'blob', sha: null })
        }
      }
    }

    const createdTree = await ghApi<{ sha?: string }>(gh, 'POST', `repos/${owner}/${repo}/git/trees`, {
      base_tree: baseTree,
      tree: treeEntries,
    }, signal)
    if (!createdTree.sha) throw new StudioError(`Could not create git tree in ${owner}/${repo}`, 'GH_FAILED')

    const createdCommit = await ghApi<{ sha?: string }>(gh, 'POST', `repos/${owner}/${repo}/git/commits`, {
      message,
      tree: createdTree.sha,
      parents: [currentCommit],
    }, signal)
    if (!createdCommit.sha) throw new StudioError(`Could not create git commit in ${owner}/${repo}`, 'GH_FAILED')

    try {
      await ghApi(gh, 'PATCH', `repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        sha: createdCommit.sha,
        force: false,
      }, signal)
    } catch (error) {
      if ((error as Partial<GhApiError>).status === 422) {
        const latestRef = await readBranchRef(gh, owner, repo, branch, false, signal).catch(() => undefined)
        const latestSha = latestRef?.object?.sha ?? latestRef?.sha
        if (latestSha === createdCommit.sha) {
          return { commit: createdCommit.sha }
        }
      }
      throw error
    }

    return { commit: createdCommit.sha }
  } catch (error) {
    if (error instanceof StudioError) throw error
    throw new StudioError(error instanceof Error ? error.message : String(error), 'GH_FAILED')
  }
}

export async function ensurePages(
  gh: string,
  owner: string,
  repo: string,
  branch = 'main',
  signal?: AbortSignal,
): Promise<{ url: string }> {
  try {
    await ghApi(gh, 'POST', `repos/${owner}/${repo}/pages`, {
      build_type: 'legacy',
      source: { branch, path: '/' },
    }, signal)
  } catch (error) {
    if (error instanceof StudioError) throw error
    if ((error as Partial<GhApiError>).status !== 409) {
      throw new StudioError(error instanceof Error ? error.message : String(error), 'GH_FAILED')
    }
  }
  try {
    const pages = await ghApi<{ html_url?: string }>(gh, 'GET', `repos/${owner}/${repo}/pages`, undefined, signal)
    const raw = typeof pages?.html_url === 'string' && pages.html_url.trim()
      ? pages.html_url.trim()
      : `https://${owner}.github.io/${repo}/`
    return { url: raw.endsWith('/') ? raw : `${raw}/` }
  } catch (error) {
    if (error instanceof StudioError) throw error
    throw new StudioError(error instanceof Error ? error.message : String(error), 'GH_FAILED')
  }
}

export async function waitForPages(
  gh: string,
  owner: string,
  repo: string,
  sinceCommit: string,
  timeoutMs = DEFAULT_PAGES_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<'built' | 'building' | 'errored'> {
  const pollMs = Math.min(DEFAULT_PAGES_POLL_MS, Math.max(20, Math.floor(timeoutMs / 3)))
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (true) {
    if (signal?.aborted) throw new StudioError('GitHub publish was cancelled.', 'CANCELLED')
    try {
      const latest = await ghApi<{ status?: string; commit?: string; error?: { message?: string } }>(
        gh, 'GET', `repos/${owner}/${repo}/pages/builds/latest`, undefined, signal,
      )
      if (latest?.status === 'errored' && (!latest.commit || latest.commit === sinceCommit)) {
        return 'errored'
      }
      if (latest?.commit === sinceCommit && latest?.status === 'built') {
        return 'built'
      }
    } catch (error) {
      if (error instanceof StudioError && error.code === 'CANCELLED') throw error
      // Transient 404 right after enabling Pages is normal while the first build queues.
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return 'building'
    const wait = Math.min(pollMs, remaining)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, wait)
      const onAbort = () => {
        clearTimeout(timer)
        reject(new StudioError('GitHub publish was cancelled.', 'CANCELLED'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function guessDirectoryLang(manifest: StudioRepoManifest, fallback?: 'zh' | 'en'): 'zh' | 'en' {
  if (fallback === 'zh' || fallback === 'en') return fallback
  const titles = Object.values(manifest.games).map(game => game.title)
  return titles.some(title => /[\u3400-\u9fff]/u.test(title)) ? 'zh' : 'en'
}

export function renderDirectoryPage(manifest: StudioRepoManifest, lang: 'zh' | 'en'): string {
  const isZh = lang === 'zh'
  const title = isZh ? 'DSH 游戏工坊 · 已发布游戏' : 'DSH Game Studio · Published Games'
  const subtitle = isZh ? '用 DSH 游戏工坊制作并发布的网页小游戏，点开即可游玩。' : 'Web games made and published with DSH Game Studio. Click any game to play.'
  const emptyText = isZh ? '还没有已发布的游戏。' : 'No published games yet.'
  const entries = Object.entries(manifest.games).sort((a, b) => b[1].publishedAt.localeCompare(a[1].publishedAt))

  const wallBlock = manifest.wall
    ? `<a class="card wall" href="./wall/"><strong>${isZh ? `游戏墙（${manifest.wall.games} 款）` : `Game wall (${manifest.wall.games} games)`}</strong><span>${escapeHtml(manifest.wall.publishedAt.slice(0, 10))}</span></a>`
    : ''

  const gameItems = entries.map(([slug, game]) => (
    `<a class="card" href="./${encodeURIComponent(slug)}/"><strong>${escapeHtml(game.title)}</strong><span>${escapeHtml(game.publishedAt.slice(0, 10))}</span></a>`
  )).join('\n')

  return [
    '<!doctype html>',
    `<html lang="${isZh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
    `<title>${title}</title>`,
    '<style>',
    ':root{color-scheme:dark;--bg:#111317;--fg:#f2f3f5;--muted:#9aa0aa;--card:#1d1f24;--border:#2a2d33}',
    '*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}',
    'main{max-width:760px;margin:0 auto;padding:32px 16px}',
    'h1{margin:0 0 6px;font-size:24px}p.sub{margin:0 0 24px;color:var(--muted)}',
    '.list{display:flex;flex-direction:column;gap:10px}',
    '.card{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;border-radius:10px;background:var(--card);border:1px solid var(--border);color:var(--fg);text-decoration:none}',
    '.card:hover,.card:focus-visible{border-color:#4c8bf5;outline:none}',
    '.card.wall{border-color:#3b5998}',
    '.card span{color:var(--muted);font-size:12px;flex:none}',
    '</style></head><body><main>',
    `<h1>${title}</h1><p class="sub">${subtitle}</p>`,
    wallBlock || gameItems ? `<div class="list">\n${[wallBlock, gameItems].filter(Boolean).join('\n')}\n</div>` : `<p class="sub">${emptyText}</p>`,
    '</main></body></html>',
    '',
  ].join('\n')
}

export function renderGamesFeed(manifest: StudioRepoManifest, owner: string, fallbackLang?: 'zh' | 'en'): GamesFeed {
  const lang = guessDirectoryLang(manifest, fallbackLang)
  const isZh = lang === 'zh'
  const name = isZh ? `${owner} 的小游戏` : `${owner}'s games`
  const entries = Object.entries(manifest.games).sort((a, b) => b[1].publishedAt.localeCompare(a[1].publishedAt))
  let updatedAt = manifest.wall?.publishedAt ?? ''
  const games: GamesFeedItem[] = entries.map(([slug, game]) => {
    if (game.publishedAt > updatedAt) updatedAt = game.publishedAt
    return {
      slug,
      title: game.title,
      url: `${encodeURIComponent(slug)}/`,
      cover: typeof game.cover === 'string' && game.cover ? game.cover : null,
      ...(game.dimension === '2d' || game.dimension === '3d' ? { dimension: game.dimension } : {}),
      orientation: game.orientation === 'landscape' ? 'landscape' : 'portrait',
      publishedAt: game.publishedAt,
    }
  })
  return {
    format: 'dsh-games-feed',
    version: 1,
    name,
    author: owner,
    updatedAt: updatedAt || new Date().toISOString(),
    games,
    wall: manifest.wall ? 'wall/' : null,
  }
}
