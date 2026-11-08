/**
 * "My games": find the game projects in a session's workspace and describe
 * each one for the shelf, using only workspace reads (no agent, no model).
 *
 * A game project is a folder holding `game.json` and a `.studio/` folder. The
 * scan looks at the workspace root and up to two levels below it, skips
 * dependency, build and hidden folders, and stops after a fixed number of
 * directory listings so a large workspace cannot stall the sidebar.
 */

export interface DirEntry { name: string; type: string }
export interface Listing { entries: DirEntry[]; truncated: boolean }
export type ListDir = (path: string, signal: AbortSignal) => Promise<Listing>
export type ReadText = (path: string, signal: AbortSignal) => Promise<string>

export interface OnlineShelfMeta {
  url: string
  sourceId: string
  sourceName: string
  sourceHost: string
  slug: string
}

export interface ShelfGame {
  /** Absolute project folder (or unique online identifier for online games). */
  project: string
  title: string
  /** `2d`, `3d`, or undefined when the manifest names no known template. */
  dimension: '2d' | '3d' | undefined
  orientation: 'portrait' | 'landscape'
  built: boolean
  versions: number
  /** ISO time of the last studio change; empty when unknown. */
  updatedAt: string
  /** Workspace path (or https URL for online games) of the cover picture, if the project has one. */
  cover: string | undefined
  /** Present when the tile comes from a subscribed online game source. */
  online?: OnlineShelfMeta
}

export interface ShelfScan { games: ShelfGame[]; partial: boolean }

/** Folders that never hold a game project of their own. */
const SKIP = new Set(['node_modules', 'dist', 'assets', 'build', 'out', 'vendor', 'target'])
const IMAGE = /\.(png|jpe?g|webp|svg)$/iu
const DEFAULTS = { maxDepth: 2, maxLists: 80, concurrency: 4 }

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/u, '')}/${name}`
}

function isDir(entry: DirEntry): boolean { return entry.type === 'directory' }

/** Breadth-first search for project folders; a project's own subfolders are not searched. */
export async function findGameDirs(list: ListDir, root: string, signal: AbortSignal, options: Partial<typeof DEFAULTS> = {}): Promise<{ dirs: string[]; partial: boolean }> {
  const { maxDepth, maxLists } = { ...DEFAULTS, ...options }
  const dirs: string[] = []
  let partial = false
  let lists = 0
  let level = [root]
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      if (signal.aborted) return { dirs, partial: true }
      if (lists >= maxLists) { partial = true; break }
      lists += 1
      let listing: Listing
      try { listing = await list(dir, signal) } catch { continue }
      if (listing.truncated) partial = true
      const names = new Map(listing.entries.map(entry => [entry.name, entry]))
      const manifest = names.get('game.json')
      const studio = names.get('.studio')
      if (manifest && !isDir(manifest) && studio && isDir(studio)) { dirs.push(dir); continue }
      if (depth === maxDepth) continue
      for (const entry of listing.entries) {
        if (isDir(entry) && !entry.name.startsWith('.') && !SKIP.has(entry.name)) next.push(joinPath(dir, entry.name))
      }
    }
    if (lists >= maxLists && next.length > 0) partial = true
    level = next.sort()
  }
  return { dirs, partial }
}

interface ManifestLike { title?: unknown; template?: unknown; orientation?: unknown; slots?: Record<string, { file?: unknown }> }
interface StateLike { title?: unknown; build?: unknown; versions?: unknown[]; updatedAt?: unknown; orientation?: unknown }

async function readJson<T>(read: ReadText, path: string, signal: AbortSignal): Promise<T | undefined> {
  try { return JSON.parse(await read(path, signal)) as T } catch { return undefined }
}

async function listNames(list: ListDir, path: string, signal: AbortSignal): Promise<DirEntry[]> {
  try { return (await list(path, signal)).entries } catch { return [] }
}

/**
 * The cover: the picture the last playtest saved as `.studio/cover.jpg`, else
 * the mid-game (or title) screenshot of the newest playtest run, else the
 * hero's current art.
 */
export async function pickCover(list: ListDir, project: string, manifest: ManifestLike | undefined, signal: AbortSignal): Promise<string | undefined> {
  const studio = joinPath(project, '.studio')
  const studioEntries = await listNames(list, studio, signal)
  if (studioEntries.some(entry => entry.name === 'cover.jpg' && !isDir(entry))) return joinPath(studio, 'cover.jpg')
  if (studioEntries.some(entry => entry.name === 'playtest' && isDir(entry))) {
    const playtests = joinPath(studio, 'playtest')
    const runs = (await listNames(list, playtests, signal)).filter(entry => isDir(entry) && entry.name.startsWith('run-'))
      .map(entry => entry.name).sort().reverse()
    for (const run of runs.slice(0, 3)) {
      const shots = new Set((await listNames(list, joinPath(playtests, run), signal)).map(entry => entry.name))
      for (const shot of ['mid.jpg', 'title.jpg', 'end.jpg']) if (shots.has(shot)) return joinPath(joinPath(playtests, run), shot)
    }
  }
  const slots = manifest?.slots ?? {}
  const hero = slots.hero ?? Object.values(slots)[0]
  const file = typeof hero?.file === 'string' ? hero.file : undefined
  return file && IMAGE.test(file) && !file.startsWith('/') && !file.includes('..') ? joinPath(project, file) : undefined
}

export async function describeGame(list: ListDir, read: ReadText, project: string, signal: AbortSignal): Promise<ShelfGame> {
  const [manifest, state] = await Promise.all([
    readJson<ManifestLike>(read, joinPath(project, 'game.json'), signal),
    readJson<StateLike>(read, joinPath(project, '.studio/state.json'), signal),
  ])
  const title = [state?.title, manifest?.title].find(value => typeof value === 'string' && value.trim() !== '') as string | undefined
  const template = manifest?.template
  const orientation = (state?.orientation ?? manifest?.orientation) === 'landscape' ? 'landscape' : 'portrait'
  const versions = Array.isArray(state?.versions) ? state.versions : []
  const newest = versions[0] as { createdAt?: unknown } | undefined
  const updatedAt = typeof state?.updatedAt === 'string' ? state.updatedAt : typeof newest?.createdAt === 'string' ? newest.createdAt : ''
  return {
    project,
    title: title ?? project.split(/[\\/]/u).filter(Boolean).at(-1) ?? project,
    dimension: template === 'voxel' ? '3d' : template === 'collector' ? '2d' : undefined,
    orientation,
    built: state?.build !== null && state?.build !== undefined,
    versions: versions.length,
    updatedAt,
    cover: await pickCover(list, project, manifest, signal),
  }
}

/** Every game in the workspace, most recently changed first. */
export async function scanShelf(list: ListDir, read: ReadText, root: string, signal: AbortSignal, options: Partial<typeof DEFAULTS> = {}): Promise<ShelfScan> {
  const { concurrency } = { ...DEFAULTS, ...options }
  const found = await findGameDirs(list, root, signal, options)
  const games: ShelfGame[] = []
  for (let i = 0; i < found.dirs.length; i += concurrency) {
    if (signal.aborted) break
    games.push(...await Promise.all(found.dirs.slice(i, i + concurrency).map(dir => describeGame(list, read, dir, signal))))
  }
  games.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))
  return { games, partial: found.partial }
}

export type ShelfFilter = 'all' | '2d' | '3d'
export type ShelfSort = 'recent' | 'versions' | 'name'

const collator = new Intl.Collator(['zh-Hans-CN', 'en'], { numeric: true, sensitivity: 'base' })

/** Merge workspace games and subscribed online games, most recent first when online games are present. */
export function mergeShelfGames(localGames: ShelfGame[], onlineGames: ShelfGame[]): ShelfGame[] {
  if (onlineGames.length === 0) return localGames
  return [...localGames, ...onlineGames].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || collator.compare(a.title, b.title))
}

/** The games the wall shows for a filter and an order; the scan already gives most recent first. */
export function viewGames(games: ShelfGame[], filter: ShelfFilter, sort: ShelfSort, onlineOnly = false): ShelfGame[] {
  const shown = games.filter(game => (!onlineOnly || Boolean(game.online)) && (filter === 'all' || game.dimension === filter))
  if (sort === 'versions') return [...shown].sort((a, b) => b.versions - a.versions || b.updatedAt.localeCompare(a.updatedAt))
  if (sort === 'name') return [...shown].sort((a, b) => collator.compare(a.title, b.title))
  return shown
}

export function dimensionCounts(games: ShelfGame[], onlineOnly = false): Record<ShelfFilter, number> {
  const pool = onlineOnly ? games.filter(game => Boolean(game.online)) : games
  return {
    all: pool.length,
    '2d': pool.filter(game => game.dimension === '2d').length,
    '3d': pool.filter(game => game.dimension === '3d').length,
  }
}

/** Local project folders to pass to exportWall or publishWall (online games are never copied or republished). */
export function localWallProjects(games: ShelfGame[]): string[] {
  return games.filter(game => !game.online).map(game => game.project)
}

/** Number of built local games in the list; determines whether Export wall / Publish wall buttons are enabled. */
export function builtLocalGamesCount(games: ShelfGame[]): number {
  return games.filter(game => !game.online && game.built).length
}
