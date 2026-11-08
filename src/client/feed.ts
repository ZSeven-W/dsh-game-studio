/**
 * Online game sources for the Game Wall: normalize source inputs, probe up to
 * one parent directory for `games.json` (with `.dsh-game-studio.json` fallback),
 * stream-read with a 256 KB cap and 15 s timeout, validate that every game and
 * cover URL stays under the feed's directory, and cache in `localStorage`.
 */
import type { ShelfGame } from './shelf.ts'

export const SOURCES_STORAGE_KEY = 'dsh-game-studio:sources:v1'
export const FEED_CACHE_STORAGE_KEY = 'dsh-game-studio:feed-cache:v1'
export const WORKSPACE_SOURCES_FILE = '.dsh-game-studio/sources.json'

export const MAX_SOURCES = 20
export const MAX_GAMES_PER_SOURCE = 200
export const MAX_FEED_BYTES = 256 * 1024
export const FETCH_TIMEOUT_MS = 15_000
export const AUTO_REFRESH_INTERVAL_MS = 30 * 60 * 1_000
export const AUTO_REFRESH_COOLDOWN_MS = 2 * 60 * 1_000

const COVER_EXT = /\.(jpe?g|png|webp|svg)$/iu
const SHORTHAND_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u

export class FeedError extends Error {
  code: 'INVALID_SOURCE' | 'HTTPS_ONLY' | 'FEED_TOO_LARGE' | 'TIMEOUT' | 'NOT_FOUND' | 'BAD_FEED' | 'MAX_SOURCES' | 'NETWORK'
  constructor(message: string, code: FeedError['code']) {
    super(message)
    this.code = code
  }
}

export interface SubscribedSource {
  /** Canonical base directory URL (always https://... ending with '/'). */
  id: string
  /** Display label such as 'finiking/dsh-games' or host/path. */
  label: string
  /** Optional explicit feed JSON URL when not `<id>games.json`. */
  feedUrl?: string
  /** True when loaded read-only from `.dsh-game-studio/sources.json` in the workspace. */
  fromWorkspace?: boolean
}

export interface OnlineGame {
  slug: string
  title: string
  url: string
  cover?: string
  dimension?: '2d' | '3d'
  orientation: 'portrait' | 'landscape'
  publishedAt: string
  sourceId: string
  sourceName: string
  sourceHost: string
}

export interface ParsedFeed {
  sourceId: string
  name: string
  author?: string
  updatedAt: string
  wall: string | null
  games: OnlineGame[]
  droppedCrossOrigin: number
}

export interface SourceFetchState {
  sourceId: string
  name: string
  author?: string
  updatedAt: string
  fetchedAt: string
  games: OnlineGame[]
  droppedCrossOrigin: number
  status: 'ok' | 'error'
  error?: string
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultLabelFromBaseDir(baseDir: URL): string {
  const host = baseDir.hostname.toLowerCase()
  const parts = baseDir.pathname.split('/').filter(Boolean)
  if (host.endsWith('.github.io')) {
    const owner = host.slice(0, -'.github.io'.length)
    if (parts.length >= 1) return `${owner}/${parts[0]}`
    return `${owner}/${host}`
  }
  return `${baseDir.host}${baseDir.pathname.replace(/\/+$/u, '')}`
}

function githubPagesBaseUrl(owner: string, repo: string): string {
  const cleanOwner = owner.trim().toLowerCase()
  const cleanRepo = repo.trim().replace(/\.git$/iu, '')
  if (cleanRepo.toLowerCase() === `${cleanOwner}.github.io`) {
    return `https://${cleanOwner}.github.io/`
  }
  return `https://${cleanOwner}.github.io/${encodeURIComponent(cleanRepo)}/`
}

export interface SourceCandidate {
  /** Canonical directory URL ending with '/'. */
  baseDir: string
  /** Primary feed URL (`games.json` or explicit `.json`). */
  feedUrl: string
  /** Legacy marker fallback URL (`.dsh-game-studio.json`), if applicable. */
  legacyUrl?: string
  label: string
}

/**
 * Resolve any user input (`owner/repo`, `https://github.com/owner/repo/...`,
 * Pages root, `wall/` URL, single game URL, or `games.json` URL) into at most
 * two candidate base directories to probe (current directory and at most one
 * parent directory). `wall/` is never treated as a single game.
 */
export function resolveSourceCandidates(rawInput: string): SourceCandidate[] {
  const input = String(rawInput ?? '').trim()
  if (!input) throw new FeedError('Enter a repository (e.g. finiking/dsh-games) or an https:// URL', 'INVALID_SOURCE')

  // Shorthand: owner/repo
  if (!input.includes('://') && !input.startsWith('http:') && !input.startsWith('https:')) {
    const match = SHORTHAND_REPO.exec(input)
    if (!match) {
      throw new FeedError('Enter a repository as owner/repo or a full https:// URL', 'INVALID_SOURCE')
    }
    const baseDir = githubPagesBaseUrl(match[1]!, match[2]!)
    return [{
      baseDir,
      feedUrl: `${baseDir}games.json`,
      legacyUrl: `${baseDir}.dsh-game-studio.json`,
      label: `${match[1]}/${match[2]}`,
    }]
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new FeedError('Invalid URL', 'INVALID_SOURCE')
  }
  if (parsed.protocol !== 'https:') {
    throw new FeedError('Only https:// game sources are supported', 'HTTPS_ONLY')
  }
  parsed.hash = ''
  parsed.search = ''

  const host = parsed.hostname.toLowerCase()
  if (host === 'github.com' || host === 'www.github.com') {
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length < 2) {
      throw new FeedError('GitHub URL must include owner and repository (https://github.com/owner/repo)', 'INVALID_SOURCE')
    }
    const owner = segments[0]!
    const repo = segments[1]!.replace(/\.git$/iu, '')
    const baseDir = githubPagesBaseUrl(owner, repo)
    return [{
      baseDir,
      feedUrl: `${baseDir}games.json`,
      legacyUrl: `${baseDir}.dsh-game-studio.json`,
      label: `${owner}/${repo}`,
    }]
  }

  // Direct JSON feed or marker URL
  if (/\.json$/iu.test(parsed.pathname)) {
    const base = new URL('./', parsed)
    const isMarker = parsed.pathname.endsWith('/.dsh-game-studio.json')
    return [{
      baseDir: base.href,
      feedUrl: isMarker ? `${base.href}games.json` : parsed.href,
      legacyUrl: `${base.href}.dsh-game-studio.json`,
      label: defaultLabelFromBaseDir(base),
    }]
  }

  // Normalize HTML file or directory path to a directory URL ending with '/'
  let dirUrl: URL
  if (/\.html?$/iu.test(parsed.pathname)) {
    dirUrl = new URL('./', parsed)
  } else if (parsed.pathname.endsWith('/')) {
    dirUrl = new URL(parsed.href)
  } else {
    dirUrl = new URL(`${parsed.href}/`)
  }

  const makeCandidate = (dir: URL): SourceCandidate => ({
    baseDir: dir.href,
    feedUrl: `${dir.href}games.json`,
    legacyUrl: `${dir.href}.dsh-game-studio.json`,
    label: defaultLabelFromBaseDir(dir),
  })

  const parentDir = new URL('../', dirUrl)
  const hasDistinctParent = parentDir.origin === dirUrl.origin && parentDir.href !== dirUrl.href

  // If the URL points at `<site>/wall/`, it is the wall page of its parent source, never a standalone game.
  if (/\/wall\/$/iu.test(dirUrl.pathname) && hasDistinctParent) {
    return [makeCandidate(parentDir), makeCandidate(dirUrl)]
  }

  // Probe the given directory first, then at most 1 parent directory up (`../games.json`).
  const candidates = [makeCandidate(dirUrl)]
  if (hasDistinctParent) {
    candidates.push(makeCandidate(parentDir))
  }
  return candidates
}

/**
 * Resolve a relative `url` or `cover` inside a feed and verify that it stays
 * on the same `https:` origin AND inside the feed's own directory (`baseDir`).
 */
export function resolveUnderFeedDir(
  relativeUrl: unknown,
  baseDir: URL,
  kind: 'game' | 'cover' | 'wall',
): string | undefined {
  if (typeof relativeUrl !== 'string') return undefined
  const trimmed = relativeUrl.trim()
  if (!trimmed || trimmed.startsWith('//') || /[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined

  let resolved: URL
  try {
    resolved = new URL(trimmed, baseDir)
  } catch {
    return undefined
  }
  if (resolved.protocol !== 'https:') return undefined
  if (resolved.origin !== baseDir.origin) return undefined
  // Must remain strictly within the feed's directory prefix (`baseDir.pathname`, which ends with '/').
  if (!resolved.pathname.startsWith(baseDir.pathname)) return undefined

  if (kind === 'cover') {
    if (!COVER_EXT.test(resolved.pathname)) return undefined
    return resolved.href
  }

  if (kind === 'game') {
    const subPath = resolved.pathname.slice(baseDir.pathname.length).replace(/\/+$/u, '')
    if (!subPath || subPath === 'index.html' || subPath === 'wall' || subPath === 'wall/index.html') {
      return undefined
    }
  }

  return resolved.href
}

/**
 * Parse and validate a `games.json` feed object. Forward-compatible with
 * `version >= 1`. Games whose `url` or `cover` leave the feed's directory or
 * origin are dropped and counted in `droppedCrossOrigin`.
 */
export function parseGamesFeed(raw: unknown, feedUrl: string, fallbackLabel?: string): ParsedFeed {
  let parsedFeedUrl: URL
  try {
    parsedFeedUrl = new URL(feedUrl)
  } catch {
    throw new FeedError('Invalid feed URL', 'INVALID_SOURCE')
  }
  if (parsedFeedUrl.protocol !== 'https:') {
    throw new FeedError('Only https:// game sources are supported', 'HTTPS_ONLY')
  }
  const baseDir = new URL('./', parsedFeedUrl)
  const sourceId = baseDir.href
  const sourceHost = baseDir.host

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FeedError('Feed is not a JSON object', 'BAD_FEED')
  }
  const obj = raw as Record<string, unknown>
  if (obj.format !== 'dsh-games-feed' || !Array.isArray(obj.games)) {
    throw new FeedError('Not a dsh-games-feed document', 'BAD_FEED')
  }
  if (obj.version !== undefined && (typeof obj.version !== 'number' || obj.version < 1)) {
    throw new FeedError('Unsupported feed version', 'BAD_FEED')
  }

  const author = typeof obj.author === 'string' && obj.author.trim() ? obj.author.trim().slice(0, 80) : undefined
  const defaultName = fallbackLabel || defaultLabelFromBaseDir(baseDir)
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 120) : defaultName
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : ''
  const wall = typeof obj.wall === 'string' ? (resolveUnderFeedDir(obj.wall, baseDir, 'wall') ?? null) : null

  const games: OnlineGame[] = []
  let droppedCrossOrigin = 0

  for (const entry of obj.games) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const item = entry as Record<string, unknown>
    const slug = typeof item.slug === 'string' && item.slug.trim() ? item.slug.trim().slice(0, 80) : ''
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 120) : slug
    if (!slug || !title) continue

    const resolvedUrl = resolveUnderFeedDir(item.url, baseDir, 'game')
    if (!resolvedUrl) {
      droppedCrossOrigin += 1
      continue
    }

    let resolvedCover: string | undefined
    if (item.cover !== undefined && item.cover !== null && item.cover !== '') {
      resolvedCover = resolveUnderFeedDir(item.cover, baseDir, 'cover')
      if (!resolvedCover) {
        droppedCrossOrigin += 1
        continue
      }
    }

    if (games.length >= MAX_GAMES_PER_SOURCE) continue

    const dimension = item.dimension === '2d' || item.dimension === '3d' ? item.dimension : undefined
    const orientation = item.orientation === 'landscape' ? 'landscape' : 'portrait'
    const publishedAt = typeof item.publishedAt === 'string' ? item.publishedAt : updatedAt

    games.push({
      slug,
      title,
      url: resolvedUrl,
      ...(resolvedCover ? { cover: resolvedCover } : {}),
      ...(dimension ? { dimension } : {}),
      orientation,
      publishedAt,
      sourceId,
      sourceName: name,
      sourceHost,
    })
  }

  return {
    sourceId,
    name,
    ...(author ? { author } : {}),
    updatedAt,
    wall,
    games,
    droppedCrossOrigin,
  }
}

/**
 * Fallback parser for older repositories that only have `.dsh-game-studio.json`
 * and have not yet generated `games.json`.
 */
export function parseLegacyManifest(raw: unknown, markerUrl: string, fallbackLabel?: string): ParsedFeed {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(markerUrl)
  } catch {
    throw new FeedError('Invalid marker URL', 'INVALID_SOURCE')
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new FeedError('Only https:// game sources are supported', 'HTTPS_ONLY')
  }
  const baseDir = new URL('./', parsedUrl)
  const sourceId = baseDir.href
  const sourceHost = baseDir.host

  if (!raw || typeof raw !== 'object' || (raw as { tool?: unknown }).tool !== 'dsh-game-studio') {
    throw new FeedError('Not a dsh-game-studio repository', 'BAD_FEED')
  }
  const obj = raw as {
    games?: Record<string, {
      title?: unknown
      publishedAt?: unknown
      dimension?: unknown
      orientation?: unknown
      cover?: unknown
    }>
    wall?: { publishedAt?: unknown } | null
  }
  const rawGames = obj.games && typeof obj.games === 'object' && !Array.isArray(obj.games) ? obj.games : {}
  const entries = Object.entries(rawGames).sort((a, b) => {
    const ta = typeof a[1]?.publishedAt === 'string' ? a[1].publishedAt : ''
    const tb = typeof b[1]?.publishedAt === 'string' ? b[1].publishedAt : ''
    return tb.localeCompare(ta)
  })

  const name = fallbackLabel || defaultLabelFromBaseDir(baseDir)
  const games: OnlineGame[] = []
  let droppedCrossOrigin = 0
  let newestAt = typeof obj.wall?.publishedAt === 'string' ? obj.wall.publishedAt : ''

  for (const [slug, info] of entries) {
    if (!slug || !info || typeof info !== 'object') continue
    const resolvedUrl = resolveUnderFeedDir(`${encodeURIComponent(slug)}/`, baseDir, 'game')
    if (!resolvedUrl) {
      droppedCrossOrigin += 1
      continue
    }
    let resolvedCover: string | undefined
    if (info.cover !== undefined && info.cover !== null && info.cover !== '') {
      resolvedCover = resolveUnderFeedDir(info.cover, baseDir, 'cover')
      if (!resolvedCover) {
        droppedCrossOrigin += 1
        continue
      }
    }
    if (games.length >= MAX_GAMES_PER_SOURCE) continue
    const title = typeof info.title === 'string' && info.title.trim() ? info.title.trim().slice(0, 120) : slug
    const publishedAt = typeof info.publishedAt === 'string' ? info.publishedAt : ''
    if (publishedAt > newestAt) newestAt = publishedAt
    const dimension = info.dimension === '2d' || info.dimension === '3d' ? info.dimension : undefined
    const orientation = info.orientation === 'landscape' ? 'landscape' : 'portrait'
    games.push({
      slug,
      title,
      url: resolvedUrl,
      ...(resolvedCover ? { cover: resolvedCover } : {}),
      ...(dimension ? { dimension } : {}),
      orientation,
      publishedAt,
      sourceId,
      sourceName: name,
      sourceHost,
    })
  }

  return {
    sourceId,
    name,
    updatedAt: newestAt,
    wall: obj.wall ? `${baseDir.href}wall/` : null,
    games,
    droppedCrossOrigin,
  }
}

export interface FetchFeedOptions {
  fetchImpl?: typeof fetch
  maxBytes?: number
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Fetch a JSON document over HTTPS with a hard streaming byte ceiling (default
 * 256 KB) and a timeout (default 15 s). Returns `{ status: 404 }` on 404 so the
 * caller can fall back to `.dsh-game-studio.json` or the parent directory.
 */
export async function fetchJsonWithLimit(
  url: string,
  options: FetchFeedOptions = {},
): Promise<{ status: 200; data: unknown } | { status: 404 }> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') {
    throw new FeedError('Only https:// game sources are supported', 'HTTPS_ONLY')
  }
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const maxBytes = options.maxBytes ?? MAX_FEED_BYTES
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS

  const controller = new AbortController()
  let timedOut = false
  let byteLimitExceeded = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onExternalAbort = () => { controller.abort() }
  if (options.signal?.aborted) {
    clearTimeout(timer)
    throw new FeedError('Request was cancelled', 'NETWORK')
  }
  options.signal?.addEventListener('abort', onExternalAbort, { once: true })

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.status === 404) {
      return { status: 404 }
    }
    if (!response.ok) {
      throw new FeedError(`HTTP ${response.status}`, 'NETWORK')
    }

    const contentLengthHeader = response.headers?.get?.('content-length')
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader)
      if (Number.isFinite(declared) && declared > maxBytes) {
        byteLimitExceeded = true
        controller.abort()
        throw new FeedError(`Feed exceeds maximum size of ${Math.round(maxBytes / 1024)} KB`, 'FEED_TOO_LARGE')
      }
    }

    let text: string
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          total += value.byteLength
          if (total > maxBytes) {
            byteLimitExceeded = true
            await reader.cancel().catch(() => undefined)
            controller.abort()
            throw new FeedError(`Feed exceeds maximum size of ${Math.round(maxBytes / 1024)} KB`, 'FEED_TOO_LARGE')
          }
          chunks.push(value)
        }
      }
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      text = new TextDecoder().decode(merged)
    } else {
      text = await response.text()
      if (new TextEncoder().encode(text).byteLength > maxBytes) {
        throw new FeedError(`Feed exceeds maximum size of ${Math.round(maxBytes / 1024)} KB`, 'FEED_TOO_LARGE')
      }
    }

    try {
      return { status: 200, data: JSON.parse(text) }
    } catch {
      throw new FeedError('Feed returned invalid JSON', 'BAD_FEED')
    }
  } catch (error) {
    if (byteLimitExceeded) {
      throw new FeedError(`Feed exceeds maximum size of ${Math.round(maxBytes / 1024)} KB`, 'FEED_TOO_LARGE')
    }
    if (error instanceof FeedError) throw error
    if (timedOut) {
      throw new FeedError('Request timed out', 'TIMEOUT')
    }
    throw new FeedError(error instanceof Error ? error.message : String(error), 'NETWORK')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * Probe a user-entered source (up to 1 parent directory up) and return the
 * resolved `SubscribedSource` plus its initial `ParsedFeed`.
 */
export async function discoverAndFetchSource(
  rawInput: string,
  options: FetchFeedOptions = {},
): Promise<{ source: SubscribedSource; feed: ParsedFeed }> {
  const candidates = resolveSourceCandidates(rawInput)
  let lastError: FeedError | undefined

  for (const candidate of candidates) {
    try {
      const primary = await fetchJsonWithLimit(candidate.feedUrl, options)
      if (primary.status === 200) {
        const feed = parseGamesFeed(primary.data, candidate.feedUrl, candidate.label)
        const source: SubscribedSource = {
          id: candidate.baseDir,
          label: feed.name || candidate.label,
          ...(candidate.feedUrl !== `${candidate.baseDir}games.json` ? { feedUrl: candidate.feedUrl } : {}),
        }
        return { source, feed }
      }
    } catch (error) {
      if (error instanceof FeedError && (error.code === 'FEED_TOO_LARGE' || error.code === 'HTTPS_ONLY' || error.code === 'TIMEOUT')) {
        throw error
      }
      lastError = error instanceof FeedError ? error : new FeedError(String(error), 'NETWORK')
    }

    if (candidate.legacyUrl) {
      try {
        const legacy = await fetchJsonWithLimit(candidate.legacyUrl, options)
        if (legacy.status === 200) {
          const feed = parseLegacyManifest(legacy.data, candidate.legacyUrl, candidate.label)
          const source: SubscribedSource = {
            id: candidate.baseDir,
            label: feed.name || candidate.label,
          }
          return { source, feed }
        }
      } catch (error) {
        if (error instanceof FeedError && (error.code === 'FEED_TOO_LARGE' || error.code === 'HTTPS_ONLY' || error.code === 'TIMEOUT')) {
          throw error
        }
        lastError = error instanceof FeedError ? error : new FeedError(String(error), 'NETWORK')
      }
    }
  }

  throw lastError ?? new FeedError('No games.json feed found at this address', 'NOT_FOUND')
}

/** Refresh a known subscribed source. Never throws; returns a `SourceFetchState`. */
export async function refreshSubscribedSource(
  source: SubscribedSource,
  previous?: SourceFetchState,
  options: FetchFeedOptions = {},
): Promise<SourceFetchState> {
  const now = new Date().toISOString()
  const feedUrl = source.feedUrl ?? `${source.id}games.json`
  const legacyUrl = `${source.id}.dsh-game-studio.json`

  try {
    const primary = await fetchJsonWithLimit(feedUrl, options)
    if (primary.status === 200) {
      const parsed = parseGamesFeed(primary.data, feedUrl, source.label)
      return {
        sourceId: source.id,
        name: parsed.name || source.label,
        ...(parsed.author ? { author: parsed.author } : {}),
        updatedAt: parsed.updatedAt,
        fetchedAt: now,
        games: parsed.games,
        droppedCrossOrigin: parsed.droppedCrossOrigin,
        status: 'ok',
      }
    }
    const legacy = await fetchJsonWithLimit(legacyUrl, options)
    if (legacy.status === 200) {
      const parsed = parseLegacyManifest(legacy.data, legacyUrl, source.label)
      return {
        sourceId: source.id,
        name: parsed.name || source.label,
        updatedAt: parsed.updatedAt,
        fetchedAt: now,
        games: parsed.games,
        droppedCrossOrigin: parsed.droppedCrossOrigin,
        status: 'ok',
      }
    }
    throw new FeedError('games.json not found (404)', 'NOT_FOUND')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      sourceId: source.id,
      name: previous?.name ?? source.label,
      ...(previous?.author ? { author: previous.author } : {}),
      updatedAt: previous?.updatedAt ?? '',
      fetchedAt: previous?.fetchedAt ?? '',
      games: previous?.games ?? [],
      droppedCrossOrigin: previous?.droppedCrossOrigin ?? 0,
      status: 'error',
      error: message.slice(0, 200),
    }
  }
}

export function onlineGameToShelfGame(game: OnlineGame): ShelfGame {
  return {
    project: `online:${game.sourceId}:${game.slug}`,
    title: game.title,
    dimension: game.dimension,
    orientation: game.orientation,
    built: true,
    versions: 0,
    updatedAt: game.publishedAt,
    cover: game.cover,
    online: {
      url: game.url,
      sourceId: game.sourceId,
      sourceName: game.sourceName,
      sourceHost: game.sourceHost,
      slug: game.slug,
    },
  }
}

export function shouldAutoRefresh(
  lastRefreshAtMs: number | undefined,
  nowMs = Date.now(),
  cooldownMs = AUTO_REFRESH_COOLDOWN_MS,
): boolean {
  if (lastRefreshAtMs === undefined || !Number.isFinite(lastRefreshAtMs)) return true
  return nowMs - lastRefreshAtMs >= cooldownMs
}

function normalizeStoredSourceEntry(raw: unknown, fromWorkspace = false): SubscribedSource | undefined {
  try {
    if (typeof raw === 'string') {
      const [first] = resolveSourceCandidates(raw)
      if (!first) return undefined
      return {
        id: first.baseDir,
        label: first.label,
        ...(first.feedUrl !== `${first.baseDir}games.json` ? { feedUrl: first.feedUrl } : {}),
        ...(fromWorkspace ? { fromWorkspace: true } : {}),
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const item = raw as Record<string, unknown>
    const input = typeof item.id === 'string' ? item.id : typeof item.url === 'string' ? item.url : typeof item.source === 'string' ? item.source : ''
    if (!input) return undefined
    const [first] = resolveSourceCandidates(input)
    if (!first) return undefined
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 120) : first.label
    const feedUrl = typeof item.feedUrl === 'string' && item.feedUrl.startsWith('https://') ? item.feedUrl : undefined
    return {
      id: first.baseDir,
      label,
      ...(feedUrl ? { feedUrl } : {}),
      ...(fromWorkspace ? { fromWorkspace: true } : {}),
    }
  } catch {
    return undefined
  }
}

export function loadStoredSources(storage?: StorageLike | null): SubscribedSource[] {
  try {
    const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
    if (!target) return []
    const text = target.getItem(SOURCES_STORAGE_KEY)
    if (!text) return []
    const parsed = JSON.parse(text) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { sources?: unknown }).sources)
        ? (parsed as { sources: unknown[] }).sources
        : [])
    const out: SubscribedSource[] = []
    const seen = new Set<string>()
    for (const entry of list) {
      const normalized = normalizeStoredSourceEntry(entry, false)
      if (!normalized || seen.has(normalized.id)) continue
      seen.add(normalized.id)
      out.push(normalized)
      if (out.length >= MAX_SOURCES) break
    }
    return out
  } catch {
    return []
  }
}

export function saveStoredSources(sources: SubscribedSource[], storage?: StorageLike | null): void {
  try {
    const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
    if (!target) return
    const clean = sources
      .filter(s => !s.fromWorkspace)
      .slice(0, MAX_SOURCES)
      .map(s => ({ id: s.id, label: s.label, ...(s.feedUrl ? { feedUrl: s.feedUrl } : {}) }))
    target.setItem(SOURCES_STORAGE_KEY, JSON.stringify({ version: 1, sources: clean }))
  } catch {
    // Ignore localStorage quota or private-browsing errors.
  }
}

export function parseWorkspaceSources(text: string): SubscribedSource[] {
  try {
    const parsed = JSON.parse(text) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { sources?: unknown }).sources)
        ? (parsed as { sources: unknown[] }).sources
        : [])
    const out: SubscribedSource[] = []
    const seen = new Set<string>()
    for (const entry of list) {
      const normalized = normalizeStoredSourceEntry(entry, true)
      if (!normalized || seen.has(normalized.id)) continue
      seen.add(normalized.id)
      out.push(normalized)
      if (out.length >= MAX_SOURCES) break
    }
    return out
  } catch {
    return []
  }
}

export function mergeSources(localSources: SubscribedSource[], workspaceSources: SubscribedSource[]): SubscribedSource[] {
  const merged: SubscribedSource[] = []
  const seen = new Set<string>()
  for (const item of localSources) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
    if (merged.length >= MAX_SOURCES) return merged
  }
  for (const item of workspaceSources) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push({ ...item, fromWorkspace: true })
    if (merged.length >= MAX_SOURCES) return merged
  }
  return merged
}

export function loadFeedCache(storage?: StorageLike | null): Record<string, SourceFetchState> {
  try {
    const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
    if (!target) return {}
    const text = target.getItem(FEED_CACHE_STORAGE_KEY)
    if (!text) return {}
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const entries = (parsed as { feeds?: unknown }).feeds ?? parsed
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {}
    const out: Record<string, SourceFetchState> = {}
    for (const [id, state] of Object.entries(entries as Record<string, unknown>)) {
      if (!state || typeof state !== 'object' || Array.isArray(state)) continue
      const st = state as Partial<SourceFetchState>
      if (typeof st.sourceId !== 'string' || !Array.isArray(st.games)) continue
      out[id] = {
        sourceId: st.sourceId,
        name: typeof st.name === 'string' ? st.name : id,
        ...(typeof st.author === 'string' ? { author: st.author } : {}),
        updatedAt: typeof st.updatedAt === 'string' ? st.updatedAt : '',
        fetchedAt: typeof st.fetchedAt === 'string' ? st.fetchedAt : '',
        games: st.games.slice(0, MAX_GAMES_PER_SOURCE),
        droppedCrossOrigin: typeof st.droppedCrossOrigin === 'number' ? st.droppedCrossOrigin : 0,
        status: st.status === 'error' ? 'error' : 'ok',
        ...(typeof st.error === 'string' ? { error: st.error } : {}),
      }
    }
    return out
  } catch {
    return {}
  }
}

export function saveFeedCache(cache: Record<string, SourceFetchState>, storage?: StorageLike | null): void {
  try {
    const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
    if (!target) return
    const trimmed: Record<string, SourceFetchState> = {}
    for (const [id, state] of Object.entries(cache).slice(0, MAX_SOURCES)) {
      trimmed[id] = {
        sourceId: state.sourceId,
        name: state.name,
        ...(state.author ? { author: state.author } : {}),
        updatedAt: state.updatedAt,
        fetchedAt: state.fetchedAt,
        games: state.games.slice(0, MAX_GAMES_PER_SOURCE).map(g => ({
          slug: g.slug,
          title: g.title,
          url: g.url,
          ...(g.cover ? { cover: g.cover } : {}),
          ...(g.dimension ? { dimension: g.dimension } : {}),
          orientation: g.orientation,
          publishedAt: g.publishedAt,
          sourceId: g.sourceId,
          sourceName: g.sourceName,
          sourceHost: g.sourceHost,
        })),
        droppedCrossOrigin: state.droppedCrossOrigin,
        status: state.status,
        ...(state.error ? { error: state.error } : {}),
      }
    }
    target.setItem(FEED_CACHE_STORAGE_KEY, JSON.stringify({ version: 1, feeds: trimmed }))
  } catch {
    // Ignore localStorage quota or private-browsing errors.
  }
}
