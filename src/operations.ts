/**
 * Host-agnostic studio operations shared by both the DSH plugin (`src/index.ts`)
 * and the standalone stdio MCP server (`src/mcp-server.ts`).
 */
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { withProjectLock, writeState } from './assets.ts'
import { buildProject } from './build.ts'
import type { ShelfGame } from './client/shelf.ts'
import {
  createRepo, DEFAULT_GITHUB_REPO, DEFAULT_PAGES_TIMEOUT_MS, emptyRepoManifest, ensurePages,
  GAMES_FEED_FILE, ghLogin, guessDirectoryLang, loadRepoManifest, pickGameSlug, projectSourceId,
  publishFiles, renderDirectoryPage, renderGamesFeed, REPO_MARKER_FILE, repoExists, requireGh,
  waitForPages, type PublishedRecord, type StudioRepoManifest,
} from './github.ts'
import { loadManifest, paths } from './project.ts'
import { startShare, type ShareScope } from './share.ts'
import { restoreFiles } from './versions.ts'
import { describeProject, isPlainFile, listGames, readCoverAsset, renderOnlineWallPage, type CoverAsset, type WallLang } from './wall.ts'
import { resolveInside, sha256, StudioError, writeJson } from './util.ts'

export async function restoreProjectVersion(dir: string, version: number) {
  const restored = await withProjectLock(dir, () => restoreFiles(dir, version))
  const build = await buildProject(dir, `Back to version ${restored.number}`)
  await writeState(dir, build)
  return { restored: restored.number, note: restored.note, buildId: build.buildId }
}

export async function shareProjectGame(
  dir: string,
  minutes: number,
  scope: ShareScope = 'lan',
  options: { cloudflaredPath?: string; signal?: AbortSignal } = {},
) {
  const info = await startShare(dir, minutes, {
    scope,
    cloudflaredPath: options.cloudflaredPath,
    signal: options.signal,
    onStopped: () => { void writeState(dir).catch(() => undefined) },
  })
  await writeState(dir)
  return { url: info.url, expiresAt: info.expiresAt, scope: info.scope }
}

export async function exportProjectHtml(dir: string, fileName?: string) {
  const manifest = await loadManifest(dir)
  const build = await buildProject(dir, 'Exported')
  await writeState(dir, build)
  const slug = (fileName ?? manifest.title).normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '').toLowerCase() || 'game'
  const target = join(paths.exportDir(dir), `${slug}.html`)
  await mkdir(paths.exportDir(dir), { recursive: true })
  await copyFile(build.artifact, target)
  return { file: target, bytes: (await stat(target)).size, buildId: build.buildId }
}

export interface PublishToPagesOptions {
  cwd: string
  dir?: string
  wall?: boolean
  projects?: string[]
  remove?: boolean
  lang?: WallLang
  ghPath?: string
  githubRepo?: string
  pagesTimeoutMs?: number
  onApprove?: (notice: { en: string; zh: string }) => Promise<void>
  signal?: AbortSignal
}

export async function publishProjectToPages(opts: PublishToPagesOptions) {
  const {
    cwd,
    dir,
    wall = false,
    projects,
    remove = false,
    lang,
    ghPath,
    githubRepo,
    pagesTimeoutMs,
    onApprove,
    signal,
  } = opts
  const gh = requireGh(ghPath)
  const owner = await ghLogin(gh)
  const repo = (githubRepo ?? DEFAULT_GITHUB_REPO).trim() || DEFAULT_GITHUB_REPO

  let titleEn = 'Game wall'
  let titleZh = '游戏墙'
  let artifactBytes: Buffer | undefined
  let buildId = ''
  let singleProjectInfo: ShelfGame | undefined
  let singleCoverAsset: CoverAsset | undefined
  const wallBuiltGames: Array<{ game: ShelfGame; artifactBytes: Buffer; buildId: string; source: string }> = []

  if (wall) {
    if (!remove) {
      const scan = await listGames(cwd, signal)
      const byPath = new Map(scan.games.map(game => [game.project, game]))
      let chosen: ShelfGame[]
      if (projects && projects.length > 0) {
        chosen = []
        for (const path of projects) {
          const resolved = resolveInside(cwd, path)
          const game = byPath.get(resolved)
          if (game) chosen.push(game)
        }
      } else {
        chosen = scan.games
      }
      for (const game of chosen) {
        const artifact = paths.artifact(game.project)
        if (!(await isPlainFile(artifact))) continue
        const bytes = await readFile(artifact)
        wallBuiltGames.push({
          game,
          artifactBytes: bytes,
          buildId: sha256(bytes).slice(0, 12),
          source: projectSourceId(game.project),
        })
      }
      if (wallBuiltGames.length === 0) {
        throw new StudioError('No built games to put on the wall', 'NOTHING_TO_EXPORT')
      }
    }
  } else {
    if (!dir) throw new StudioError('path is required unless wall is true.', 'BAD_PATH')
    const manifest = await loadManifest(dir)
    titleEn = manifest.title
    titleZh = manifest.title
    if (!remove) {
      try {
        artifactBytes = await readFile(paths.artifact(dir))
      } catch {
        throw new StudioError('Build the game with game_studio_build before publishing it.', 'NO_BUILD')
      }
      buildId = sha256(artifactBytes).slice(0, 12)
      singleProjectInfo = await describeProject(dir, signal)
      singleCoverAsset = await readCoverAsset(singleProjectInfo.cover)
    }
  }

  const repoInfo = await repoExists(gh, owner, repo, signal)
  const { exists } = repoInfo
  let branch = repoInfo.defaultBranch

  let repoManifest: StudioRepoManifest = exists
    ? await loadRepoManifest(gh, owner, repo, branch, signal)
    : emptyRepoManifest()

  interface PlannedWallGame {
    game: ShelfGame
    slug: string
    source: string
    buildId: string
    artifactBytes: Buffer
    hadExisting: boolean
    needsUpload: boolean
  }
  const wallPlan: PlannedWallGame[] = []
  if (wall && !remove) {
    const plannedGames = { ...repoManifest.games }
    for (const item of wallBuiltGames) {
      const slug = pickGameSlug(item.game.project, plannedGames)
      const existing = plannedGames[slug]
      const hadExisting = existing !== undefined
      const needsUpload = !existing || existing.buildId !== item.buildId
      plannedGames[slug] = existing ?? {
        title: item.game.title,
        source: item.source,
        publishedAt: '',
        buildId: item.buildId,
      }
      wallPlan.push({ ...item, slug, hadExisting, needsUpload })
    }
  }

  if (onApprove !== undefined) {
    const toUpload = wallPlan.filter(item => item.needsUpload)
    const listEn = toUpload.map(item => `"${item.game.title}"`).join(', ')
    const listZh = toUpload.map(item => `《${item.game.title}》`).join('、')
    const notice = remove ? {
      en: `Remove "${titleEn}" from ${owner}/${repo}; its GitHub Pages link will stop working.`,
      zh: `从 ${owner}/${repo} 删除《${titleZh}》，它的 GitHub Pages 链接将失效。`,
    } : wall ? {
      en: `Publish "${titleEn}" to GitHub Pages`
        + (toUpload.length > 0 ? ` (along with ${listEn})` : '')
        + `: uploads to your public repository ${owner}/${repo}, where anyone can open and view the game files, and the link stays live until you remove it.`
        + (!exists ? ` Will first create a new public repository ${owner}/${repo} under your GitHub account.` : ''),
      zh: `把《${titleZh}》`
        + (toUpload.length > 0 ? `（连同${listZh}）` : '')
        + `发布到 GitHub Pages：上传到你的公开仓库 ${owner}/${repo}，任何人都能打开和查看游戏文件，链接长期有效，直到你删除。`
        + (!exists ? `会先在你的 GitHub 账号下新建公开仓库 ${owner}/${repo}。` : ''),
    } : {
      en: `Publish "${titleEn}" to GitHub Pages: uploads to your public repository ${owner}/${repo}, where anyone can open and view the game files, and the link stays live until you remove it.`
        + (!exists ? ` Will first create a new public repository ${owner}/${repo} under your GitHub account.` : ''),
      zh: `把《${titleZh}》发布到 GitHub Pages：上传到你的公开仓库 ${owner}/${repo}，任何人都能打开和查看游戏文件，链接长期有效，直到你删除。`
        + (!exists ? `会先在你的 GitHub 账号下新建公开仓库 ${owner}/${repo}。` : ''),
    }
    await onApprove(notice)
  }

  if (!exists) {
    if (remove) {
      if (!wall && dir) await rm(paths.published(dir), { force: true }).catch(() => undefined)
      throw new StudioError(
        wall
          ? `The game wall is not published in ${owner}/${repo} (游戏墙没有发布在 ${owner}/${repo}).`
          : `This game is not published in ${owner}/${repo} (这个游戏没有发布在 ${owner}/${repo}).`,
        'NOT_PUBLISHED',
      )
    }
    const created = await createRepo(gh, repo, signal)
    branch = created.defaultBranch
    repoManifest = emptyRepoManifest()
  }

  const now = new Date().toISOString()
  let slug: string
  let commit: string

  if (wall) {
    slug = 'wall'
    if (remove) {
      if (!repoManifest.wall) {
        throw new StudioError(`The game wall is not published in ${owner}/${repo} (游戏墙没有发布在 ${owner}/${repo}).`, 'NOT_PUBLISHED')
      }
      repoManifest.wall = null
      const pageLang = guessDirectoryLang(repoManifest, lang)
      const indexHtml = renderDirectoryPage(repoManifest, pageLang)
      const gamesFeed = renderGamesFeed(repoManifest, owner, pageLang)
      ;({ commit } = await publishFiles({
        gh, owner, repo, branch,
        files: [
          { path: '.nojekyll', content: Buffer.alloc(0) },
          { path: REPO_MARKER_FILE, content: Buffer.from(`${JSON.stringify(repoManifest, undefined, 2)}\n`, 'utf8') },
          { path: GAMES_FEED_FILE, content: Buffer.from(`${JSON.stringify(gamesFeed, undefined, 2)}\n`, 'utf8') },
          { path: 'index.html', content: Buffer.from(indexHtml, 'utf8') },
        ],
        remove: ['wall'],
        message: 'Remove game wall',
        signal,
      }))
    } else {
      const gameFiles: Array<{ path: string; content: Buffer }> = []
      const removePrefixes: string[] = []
      for (const item of wallPlan) {
        const existing = repoManifest.games[item.slug]
        const coverAsset = item.needsUpload || !existing?.cover ? await readCoverAsset(item.game.cover) : undefined
        const coverPath = coverAsset ? `${item.slug}/cover.${coverAsset.ext}` : (existing?.cover ?? null)
        if (item.needsUpload) {
          gameFiles.push({ path: `${item.slug}/index.html`, content: item.artifactBytes })
          if (coverAsset) {
            gameFiles.push({ path: `${item.slug}/cover.${coverAsset.ext}`, content: coverAsset.bytes })
          }
          if (item.hadExisting) {
            removePrefixes.push(item.slug)
          }
        } else if (coverAsset && !existing?.cover) {
          gameFiles.push({ path: `${item.slug}/cover.${coverAsset.ext}`, content: coverAsset.bytes })
        }
        repoManifest.games[item.slug] = {
          title: item.game.title,
          source: item.source,
          publishedAt: item.needsUpload ? now : (existing?.publishedAt ?? now),
          buildId: item.buildId,
          ...(item.game.dimension ? { dimension: item.game.dimension } : {}),
          orientation: item.game.orientation,
          cover: coverPath,
        }
      }
      repoManifest.wall = { publishedAt: now, games: Object.keys(repoManifest.games).length }
      const pageLang = guessDirectoryLang(repoManifest, lang)
      const indexHtml = renderDirectoryPage(repoManifest, pageLang)
      const gamesFeed = renderGamesFeed(repoManifest, owner, pageLang)
      const wallHtml = renderOnlineWallPage(pageLang)
      ;({ commit } = await publishFiles({
        gh, owner, repo, branch, retryInitialRef: !exists,
        files: [
          { path: '.nojekyll', content: Buffer.alloc(0) },
          { path: REPO_MARKER_FILE, content: Buffer.from(`${JSON.stringify(repoManifest, undefined, 2)}\n`, 'utf8') },
          { path: GAMES_FEED_FILE, content: Buffer.from(`${JSON.stringify(gamesFeed, undefined, 2)}\n`, 'utf8') },
          { path: 'index.html', content: Buffer.from(indexHtml, 'utf8') },
          { path: 'wall/index.html', content: Buffer.from(wallHtml, 'utf8') },
          ...gameFiles,
        ],
        ...(removePrefixes.length > 0 ? { remove: removePrefixes } : {}),
        message: 'Publish game wall',
        signal,
      }))
    }
  } else {
    const source = projectSourceId(dir!)
    if (remove) {
      const matched = Object.entries(repoManifest.games).find(([, g]) => g.source === source)?.[0]
      if (!matched) {
        await rm(paths.published(dir!), { force: true }).catch(() => undefined)
        throw new StudioError(`This game is not published in ${owner}/${repo} (这个游戏没有发布在 ${owner}/${repo}).`, 'NOT_PUBLISHED')
      }
      slug = matched
      delete repoManifest.games[slug]
      if (repoManifest.wall) {
        repoManifest.wall = { ...repoManifest.wall, games: Object.keys(repoManifest.games).length }
      }
      const pageLang = guessDirectoryLang(repoManifest, lang)
      const indexHtml = renderDirectoryPage(repoManifest, pageLang)
      const gamesFeed = renderGamesFeed(repoManifest, owner, pageLang)
      ;({ commit } = await publishFiles({
        gh, owner, repo, branch,
        files: [
          { path: '.nojekyll', content: Buffer.alloc(0) },
          { path: REPO_MARKER_FILE, content: Buffer.from(`${JSON.stringify(repoManifest, undefined, 2)}\n`, 'utf8') },
          { path: GAMES_FEED_FILE, content: Buffer.from(`${JSON.stringify(gamesFeed, undefined, 2)}\n`, 'utf8') },
          { path: 'index.html', content: Buffer.from(indexHtml, 'utf8') },
        ],
        remove: [slug],
        message: `Remove ${titleEn}`,
        signal,
      }))
      await rm(paths.published(dir!), { force: true }).catch(() => undefined)
    } else {
      slug = pickGameSlug(dir!, repoManifest.games)
      const hadExisting = repoManifest.games[slug] !== undefined
      const coverPath = singleCoverAsset ? `${slug}/cover.${singleCoverAsset.ext}` : null
      repoManifest.games[slug] = {
        title: titleEn,
        source,
        publishedAt: now,
        buildId,
        ...(singleProjectInfo?.dimension ? { dimension: singleProjectInfo.dimension } : {}),
        orientation: singleProjectInfo?.orientation ?? 'portrait',
        cover: coverPath,
      }
      if (repoManifest.wall) {
        repoManifest.wall = { ...repoManifest.wall, games: Object.keys(repoManifest.games).length }
      }
      const pageLang = lang ?? (/[\u3400-\u9fff]/u.test(titleEn) ? 'zh' : guessDirectoryLang(repoManifest))
      const indexHtml = renderDirectoryPage(repoManifest, pageLang)
      const gamesFeed = renderGamesFeed(repoManifest, owner, pageLang)
      ;({ commit } = await publishFiles({
        gh, owner, repo, branch, retryInitialRef: !exists,
        files: [
          { path: '.nojekyll', content: Buffer.alloc(0) },
          { path: REPO_MARKER_FILE, content: Buffer.from(`${JSON.stringify(repoManifest, undefined, 2)}\n`, 'utf8') },
          { path: GAMES_FEED_FILE, content: Buffer.from(`${JSON.stringify(gamesFeed, undefined, 2)}\n`, 'utf8') },
          { path: 'index.html', content: Buffer.from(indexHtml, 'utf8') },
          { path: `${slug}/index.html`, content: artifactBytes! },
          ...(singleCoverAsset ? [{ path: `${slug}/cover.${singleCoverAsset.ext}`, content: singleCoverAsset.bytes }] : []),
        ],
        ...(hadExisting ? { remove: [slug] } : {}),
        message: `Publish ${titleEn}`,
        signal,
      }))
    }
  }

  const pages = await ensurePages(gh, owner, repo, branch, signal)
  const siteUrl = pages.url
  const url = `${siteUrl}${slug}/`
  const status = await waitForPages(gh, owner, repo, commit, pagesTimeoutMs ?? DEFAULT_PAGES_TIMEOUT_MS, signal)
  if (status === 'errored') {
    throw new StudioError(`GitHub Pages failed to build ${owner}/${repo} (status: errored).`, 'PAGES_ERRORED')
  }

  if (!wall && !remove && dir) {
    const record: PublishedRecord = {
      url, siteUrl, repo: `${owner}/${repo}`, slug, publishedAt: now, buildId, status,
    }
    await writeJson(paths.published(dir), record)
  } else if (wall && !remove) {
    for (const item of wallPlan) {
      const record: PublishedRecord = {
        url: `${siteUrl}${item.slug}/`,
        siteUrl,
        repo: `${owner}/${repo}`,
        slug: item.slug,
        publishedAt: repoManifest.games[item.slug]?.publishedAt ?? now,
        buildId: item.buildId,
        status,
      }
      await writeJson(paths.published(item.game.project), record)
    }
  }

  return {
    ...(dir ? { project: dir } : {}),
    url,
    siteUrl,
    repo: `${owner}/${repo}`,
    slug,
    status,
    ...(remove ? { removed: true } : {}),
    ...(status === 'building' ? { note: 'GitHub Pages is still deploying; the link may take a minute or two to open.' } : {}),
  }
}
