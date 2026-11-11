/**
 * dsh-game-studio Host plugin: agent tools and one `/game-studio` command that
 * share the same operations, so the sidebar buttons and the agent do exactly
 * the same thing.
 */
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  applyCandidate, generateCandidates, prepareGeneration, revertSlot, withProjectLock, writeState,
  type CandidateMeta, type Generation, type ImageGenerator,
} from './assets.ts'
import { buildProject } from './build.ts'
import { commerceCheck, embedCommerce, loadCommerce, updateCommerce } from './commerce.ts'
import { writeWechatCi } from './ci.ts'
import { devtoolsDoctor, findWechatExport, openInDevtools, previewInDevtools, uploadFromDevtools } from './devtools.ts'
import { loadRelease, markMaterialsWritten, markReleaseDone, markReviewWritten, markUploaded, releaseFilePresence, releaseFreshness, releaseMaterials, releasePlan, releaseStatus, updateRelease } from './release.ts'
import { reviewGuide } from './review.ts'
import { exportWechat } from './wechat.ts'
import { runCodexBatch, type CodexBatch } from './generation.ts'
import {
  createRepo, DEFAULT_GITHUB_REPO, DEFAULT_PAGES_TIMEOUT_MS, emptyRepoManifest, ensurePages,
  GAMES_FEED_FILE, GH_AUTH_AGENT_HINT, ghInstallCommand, ghLogin, guessDirectoryLang, loadRepoManifest,
  NO_GH_AGENT_HINT, pickGameSlug, projectSourceId, publishFiles, renderDirectoryPage, renderGamesFeed,
  REPO_MARKER_FILE, repoExists, requireGh, waitForPages, type PublishedRecord, type StudioRepoManifest,
} from './github.ts'
import { openaiCost } from './pricing.ts'
import { describePlaytest, GAME_STATE_CONTRACT, playtest, RENDERS_CONTRACT } from './playtest.ts'
import { loadReference, type ReferenceImage } from './reference.ts'
import { startShare, stopAllShares, stopShare, type ShareScope } from './share.ts'
import { askToShare, askToSpend, spendNotice } from './spend.ts'
import { cloudflaredInstallCommand, NO_TUNNEL_AGENT_HINT, requireCloudflared } from './tunnel.ts'
import { listVersions, restoreFiles } from './versions.ts'
import { describeProject, exportWall, isPlainFile, listGames, readCoverAsset, renderOnlineWallPage, type CoverAsset, type WallLang } from './wall.ts'
import type { ShelfGame } from './client/shelf.ts'
import { createProject, loadManifest, ORIENTATIONS, paths, TEMPLATES, unnamedSlots, type SlotRequest } from './project.ts'
import { CODEX_EFFORTS, resolveCodex, type CodexEffort } from './providers/codex.ts'
import { OPENAI_DEFAULT_MODEL, openaiGenerate } from './providers/openai.ts'
import { readJson, resolveInside, sha256, shortId, StudioError, writeJson } from './util.ts'

/** The wizard note for an upload: what was sent, and what the IDE said. */
function uploadNote(version: string, result: { info?: unknown; output?: string }): string {
  const parts = [`uploaded ${version}`]
  const size = Number((result.info as { mainPackage?: unknown } | null | undefined)?.mainPackage)
  if (Number.isFinite(size) && size > 0) parts.push(`主包 ${Math.round(size / 1024)} KB`)
  const lastLine = String(result.output ?? '').trim().split('\n').filter(Boolean).pop()
  if (lastLine) parts.push(lastLine.slice(0, 60))
  return parts.join(' · ')
}

/** Told to the agent so it never goes looking for how the asset ledger works. */
const EDIT_SLOT_FILES = 'You may draw a slot\'s picture yourself by overwriting its file in assets/ (e.g. write your own SVG); '
  + 'the studio notices on the next build and records it as your edit, so leave assets/ASSETS.json alone.'

const SLOTS_EXAMPLE = '{"hero": "小鸡", "enemy": "狐狸", "card": {"label": "卡面", "size": [256, 384]}, "pickup": null}'

/** The slots argument of game_studio_create, as a JSON string or an object. */
function parseSlots(value: unknown): Record<string, SlotRequest> | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let parsed: unknown = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) }
    catch { throw new StudioError(`slots must be a JSON object, e.g. ${SLOTS_EXAMPLE}`, 'BAD_SLOTS') }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StudioError(`slots must be a JSON object, e.g. ${SLOTS_EXAMPLE}`, 'BAD_SLOTS')
  }
  return parsed as Record<string, SlotRequest>
}

function namingHint(slots: string[]): string {
  return `The sidebar still calls ${slots.join(', ')} by the template's generic names; set slots.<slot>.label in game.json `
    + 'to the user\'s characters, in their language (e.g. "小鸡"), so the sidebar names them.'
}

export const name = 'dsh-game-studio'
export const inject = ['tools', 'workingDirectory']

export interface Config {
  /** OpenAI image model; pin it so results stay comparable. */
  openaiModel?: string
  /** OpenAI-compatible base URL, e.g. a company gateway. */
  openaiBaseUrl?: string
  /** Name of the credential (or environment variable) holding the API key. */
  openaiCredential?: string
  /** Image service: `auto` uses OpenAI when its key is set and otherwise the Codex CLI. */
  imageProvider?: 'auto' | 'openai' | 'codex'
  /** Codex CLI executable; found on PATH or through the login shell when unset. */
  codexPath?: string
  /** Model for Codex image runs; Codex's own default when unset. */
  codexModel?: string
  /** Reasoning effort for Codex image runs. Default low: the run only calls the image tool. */
  codexReasoningEffort?: CodexEffort
  /** Give up on one Codex image after this many minutes. Default 15. */
  codexTimeoutMinutes?: number
  /** Ask the user to approve each generation (service, image count, expected cost) before it runs. Default true. */
  confirmSpending?: boolean
  /** cloudflared executable for public share links; found on PATH or standard install locations when unset. */
  cloudflaredPath?: string
  /** GitHub CLI (gh) executable for publishing to GitHub Pages; found on PATH or standard install locations when unset. */
  ghPath?: string
  /** Public GitHub repository name (under the signed-in user) for GitHub Pages publishing. Default dsh-games. */
  githubRepo?: string
  /** Maximum time in milliseconds to wait for a GitHub Pages deployment to finish building. Default 180000 (3 minutes). */
  pagesTimeoutMs?: number
}

const QUALITIES = ['low', 'medium', 'high'] as const

const PROVIDERS = ['openai', 'codex'] as const
type Provider = typeof PROVIDERS[number]

function candidateSummary(item: CandidateMeta) {
  return { number: item.number, id: item.id, file: item.file, pass: item.checks.pass, problems: item.checks.problems, model: item.model }
}

/** Shape the sidebar reads from tool presentation metadata. */
function presentation(kind: string, project: string, extra: Record<string, unknown> = {}) {
  return { studio: 1, kind, project, ...extra } as any
}

/** The sidebar command is the first surface an agent or user types into. */
const COMMAND_ACTIONS: Array<[string, string]> = [
  ['apply', 'put a generated candidate into its slot'],
  ['revert', 'restore the previous art of a slot'],
  ['build', 'rebuild the game and refresh the preview'],
  ['export', 'export the playable HTML build'],
  ['export-wechat', 'export the WeChat mini-game project (optional "appid")'],
  ['wechat-devtools', 'op: open | preview | upload | doctor'],
  ['wechat-release', 'op: status | update | materials | review'],
  ['wechat-commerce', 'op: status | configure (ad units, IAP, analytics)'],
  ['wechat-ci', 'write the CI upload kit (optional version/desc)'],
  ['restore', 'go back to an earlier build'],
  ['share', 'open a play link (optional minutes, scope "public")'],
  ['unshare', 'close the play link'],
  ['status', 'what is in this game folder'],
  ['wall', 'export one HTML page with every built game'],
  ['publish', 'publish to GitHub Pages'],
  ['unpublish', 'remove the published copy'],
]
const COMMAND_HELP = [
  'Game Studio actions — send /game-studio <action> {"project": "...", ...}',
  '',
  ...COMMAND_ACTIONS.map(([action, what]) => `  ${action.padEnd(15)} ${what}`),
  '',
  'Examples:',
  '  /game-studio export-wechat {"project": "moon-garden", "appid": "wx1234567890abcdef"}',
  '  /game-studio wechat-release {"project": "moon-garden", "op": "materials"}',
  '  /game-studio wechat-devtools {"project": "moon-garden", "op": "preview"}',
].join('\n')

export function apply(ctx: any, config: Config = {}): void {
  const model = config.openaiModel ?? OPENAI_DEFAULT_MODEL
  const credentialName = config.openaiCredential ?? 'OPENAI_API_KEY'
  let credentials: any
  let jobs: any
  let approval: any
  let attachments: any

  ctx.inject(['credentials'], (child: any) => {
    credentials = child.credentials
    child.effect(() => () => { credentials = undefined })
  })
  ctx.inject(['jobs'], (child: any) => {
    jobs = child.jobs
    child.effect(() => () => { jobs = undefined })
  })
  ctx.inject(['approval'], (child: any) => {
    approval = child.approval
    child.effect(() => () => { approval = undefined })
  })

  ctx.inject(['attachments'], (child: any) => {
    attachments = child.attachments
    child.effect(() => () => { attachments = undefined })
  })

  ctx.effect(() => () => { stopAllShares() })

  /** Whether the model behind this call can look at images (the same check DSH's read_image makes). */
  async function seesImages(exec: any): Promise<boolean> {
    try {
      const routed = exec.agent?.session?.requestHeader?.()?.config
      const provider = routed?.provider ?? exec.agent?.options?.provider
      const model = routed?.model ?? exec.agent?.options?.model
      const llm = ctx.get?.('llm')
      if (provider === undefined || model === undefined || llm === undefined) return false
      const info = await llm.resolveModelInfo(provider, model, exec.signal)
      return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
    } catch {
      return false
    }
  }

  async function confirmSpend(exec: any, provider: Provider, generation: Generation, count: number, quality: string, reference?: ReferenceImage): Promise<void> {
    if (config.confirmSpending === false) return
    const notice = spendNotice({
      provider, model, label: generation.spec.label, wide: !generation.spec.transparent, count, quality,
      ...(reference ? { reference: reference.name, ...(reference.fromChat ? { referenceFromChat: true } : {}) } : {}),
    })
    await askToSpend(approval, exec, 'game_studio_generate_asset', notice)
  }

  async function apiKey(): Promise<string> {
    try {
      const hit = await credentials?.resolve(credentialName)
      if (typeof hit?.value === 'string' && hit.value.length > 0) return hit.value
    } catch { /* fall through to the environment */ }
    const value = process.env[credentialName]
    if (value) return value
    throw new StudioError(
      `No image-generation key: store a credential named ${credentialName} in DSH, or start DSH with ${credentialName} set. `
      + 'The game still runs with its bundled art without a key.', 'NO_KEY')
  }

  async function hasOpenAIKey(): Promise<boolean> {
    try { await apiKey(); return true } catch { return false }
  }

  async function chooseProvider(requested?: Provider): Promise<Provider> {
    const wanted = requested ?? config.imageProvider ?? 'auto'
    if (wanted !== 'auto') return wanted
    if (await hasOpenAIKey()) return 'openai'
    try { await resolveCodex(config.codexPath); return 'codex' } catch { /* neither is set up */ }
    throw new StudioError(
      `No image service is set up. Store an OpenAI key as ${credentialName} (fast, billed per image), `
      + 'or install and sign in to the Codex CLI (uses your Codex plan, minutes per image). '
      + 'The game still runs with its bundled art without one.', 'NO_PROVIDER')
  }

  async function codexBatch(count: number): Promise<CodexBatch> {
    const effort = config.codexReasoningEffort ?? 'low'
    if (!CODEX_EFFORTS.includes(effort)) throw new StudioError(`codexReasoningEffort must be one of ${CODEX_EFFORTS.join(', ')}`, 'BAD_CONFIG')
    return {
      command: await resolveCodex(config.codexPath), count, effort,
      ...(config.codexModel ? { model: config.codexModel } : {}),
      timeoutMs: Math.max(1, config.codexTimeoutMinutes ?? 15) * 60_000,
    }
  }

  /** Run Codex as an owned background job; the agent gets a completion notice with the candidate ids. */
  function startCodexJob(dir: string, generation: Generation, batch: CodexBatch, exec: any): string {
    return jobs.start({
      kind: 'game-studio',
      label: `Codex: ${batch.count} ${generation.slot} image${batch.count === 1 ? '' : 's'} for ${basename(dir)}`,
      owner: exec.agent.id,
      ...(exec.callId !== undefined ? { toolCall: { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId } } : {}),
      run: (job: any) => {
        const controller = new AbortController()
        const done = runCodexBatch(dir, generation, batch, String(job.id), controller.signal, (line) => { job.updateProgress(line) })
          .then(result => ({
            status: result.status,
            ...(result.errors.length > 0 ? { detail: result.errors[0]!.slice(0, 300) } : {}),
            result: JSON.stringify({
              project: dir, slot: generation.slot,
              candidates: result.candidates.sort((a, b) => a.number - b.number)
                .map(item => ({ number: item.number, id: item.id, pass: item.checks.pass, problems: item.checks.problems })),
              errors: result.errors,
              next: 'The candidates are in the Game Studio sidebar, labelled by number. Apply one with game_studio_apply_asset after the user picks it.',
            }),
          }), (error: unknown) => ({ status: 'failed' as const, detail: error instanceof Error ? error.message : String(error) }))
        return { cancel: (reason?: string) => { controller.abort(reason) }, done }
      },
    })
  }

  function generator(signal: AbortSignal): ImageGenerator {
    return async (request) => {
      const response = await openaiGenerate({ ...request, apiKey: await apiKey(), baseUrl: config.openaiBaseUrl, model, signal })
      return { ...response, provider: 'openai' }
    }
  }

  async function projectDir(exec: any, path: string): Promise<string> {
    if (exec.agent === undefined) throw new StudioError('This tool needs an agent session', 'NO_SESSION')
    const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    return resolveInside(cwd, path)
  }

  async function restoreVersion(dir: string, version: number) {
    const restored = await withProjectLock(dir, () => restoreFiles(dir, version))
    const build = await buildProject(dir, `Back to version ${restored.number}`)
    await writeState(dir, build)
    return { restored: restored.number, note: restored.note, buildId: build.buildId }
  }

  async function shareGame(dir: string, minutes: number, scope: ShareScope = 'lan', signal?: AbortSignal) {
    const info = await startShare(dir, minutes, {
      scope,
      cloudflaredPath: config.cloudflaredPath,
      signal,
      onStopped: () => { void writeState(dir).catch(() => undefined) },
    })
    await writeState(dir)
    return { url: info.url, expiresAt: info.expiresAt, scope: info.scope }
  }

  async function exportGame(dir: string, fileName?: string) {
    const manifest = await loadManifest(dir)
    const build = await buildProject(dir, 'Exported')
    await writeState(dir, build)
    const slug = (fileName ?? manifest.title).normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '').toLowerCase() || 'game'
    const target = join(paths.exportDir(dir), `${slug}.html`)
    await mkdir(paths.exportDir(dir), { recursive: true })
    await copyFile(build.artifact, target)
    return { file: target, bytes: (await stat(target)).size, buildId: build.buildId }
  }

  async function publishToPages(opts: {
    cwd: string
    dir?: string
    wall?: boolean
    projects?: string[]
    remove?: boolean
    lang?: WallLang
    exec?: any
    signal?: AbortSignal
  }) {
    const { cwd, dir, wall = false, projects, remove = false, lang, exec, signal } = opts
    const gh = requireGh(config.ghPath)
    const owner = await ghLogin(gh)
    const repo = (config.githubRepo ?? DEFAULT_GITHUB_REPO).trim() || DEFAULT_GITHUB_REPO

    let titleEn = 'Game wall'
    let titleZh = '游戏墙'
    let artifactBytes: Buffer | undefined
    let buildId = ''
    let singleProjectInfo: ShelfGame | undefined
    let singleCoverAsset: CoverAsset | undefined
    let wallBuiltGames: Array<{ game: ShelfGame; artifactBytes: Buffer; buildId: string; source: string }> = []

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

    // Read the remote manifest before approval (read-only GETs) so wall publish can list
    // which unpublished or updated games will be uploaded along with the wall.
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

    if (exec !== undefined) {
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
      await askToShare(approval, exec, 'game_studio_publish', notice)
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
    const status = await waitForPages(gh, owner, repo, commit, config.pagesTimeoutMs ?? DEFAULT_PAGES_TIMEOUT_MS, signal)
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

  const projectParam = { type: 'string', required: true, description: 'Game project folder, relative to the working directory.' } as const
  const slotParam = { type: 'string', required: true, description: 'Asset slot name from game.json (the template\'s hero, enemy, pickup, background, or one the game added).' } as const
  const json = { type: 'json' } as const

  ctx.tools.register(defineTool({
    name: 'game_studio_create',
    description: 'Create a playable small web game from a built-in template, build it, and show it in the Game Studio sidebar. '
      + 'Templates: "collector" (default) is a 60-second 2D top-down collect-and-dodge game; "voxel" is the same loop in a 3D voxel world '
      + '(Three.js, WebGL), whose characters are voxel models until the user applies their own art, which then shows as camera-facing sprites. '
      + 'When you reshape the voxel models, edit the boxes listed in MODELS in game.js and keep MODELS and window.__renderSlots. '
      + RENDERS_CONTRACT + ' ' + GAME_STATE_CONTRACT + ' ' + EDIT_SLOT_FILES + ' '
      + 'The new folder contains game.json (title, art style, asset slots, rules; rules are free-form: add any key and read it in game.js '
      + 'as window.GAME.rules.<key>, builds do not check rule names), '
      + 'game.js (the game code you may edit), and assets/. After this, offer to generate the user\'s own art with game_studio_generate_asset.',
    parameters: {
      path: { ...projectParam, description: 'New, empty folder for the game, relative to the working directory.' },
      title: { type: 'string', required: true, description: 'Game title shown on the title screen.' },
      style: { type: 'string', description: 'Art direction shared by all generated assets, e.g. "watercolor storybook, warm palette".' },
      template: { type: 'string', enum: TEMPLATES, description: 'Which template to start from. Default collector; use voxel when the user asks for 3D.' },
      orientation: { type: 'string', enum: ORIENTATIONS, description: 'How the game is held: portrait (default, phone upright) or landscape '
        + '(side-scrollers, wide tracks or boards). Playtests and the sidebar preview follow it; it is saved as "orientation" in game.json.' },
      slots: { type: 'json', description: 'The game\'s art slots, as the sidebar shows them and AI art is made for: an object by slot name. '
        + 'A string renames a template slot after the user\'s character, in the user\'s language; '
        + 'an object {label, transparent (default true; false for a full-screen picture), size [w, h]} adds a new slot, or redraws a template slot to that shape '
        + '(e.g. a full portrait background), with a plain placeholder picture; '
        + 'null drops a template slot the game does not need. Give each kind of picture the game really draws its own slot '
        + '(cards, gems, towers, customers) instead of forcing them into hero / enemy / pickup. '
        + `Each slot's picture reaches game.js as window.GAME.assets.<slot> (a data: URL). E.g. ${SLOTS_EXAMPLE}.` },
    },
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => presentation('preview', value.project, { buildId: value.build.buildId }),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      const manifest = await createProject(dir, {
        title: args.title, style: args.style, template: args.template ?? 'collector', slots: parseSlots(args.slots),
        ...(args.orientation !== undefined ? { orientation: args.orientation } : {}),
      })
      const build = await buildProject(dir, `Created from the ${args.template ?? 'collector'} template`)
      await writeState(dir, build)
      const unnamed = await unnamedSlots(manifest)
      return {
        project: dir, title: manifest.title, orientation: manifest.orientation ?? 'portrait',
        slots: Object.fromEntries(Object.entries(manifest.slots).map(([slot, spec]) => [slot, spec.label])), rules: manifest.rules,
        build: { buildId: build.buildId, bytes: build.bytes },
        note: 'Playable now with bundled art. Read game.json and game.js before you edit them (files you have not read cannot be edited), '
          + 'change rules in game.json or code in game.js, then call game_studio_build.'
          + (unnamed.length > 0 ? ` ${namingHint(unnamed)}` : ''),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_build',
    description: 'Rebuild the game after editing game.json or game.js, and refresh the Game Studio sidebar preview. '
      + 'Always call it after code or rule changes; check `node --check game.js` first if you edited the script. '
      + 'Every build that changed the game is kept as a version the user can go back to; pass a short note saying what changed. '
      + 'To check that the change works, call game_studio_playtest. ' + RENDERS_CONTRACT + ' ' + EDIT_SLOT_FILES,
    parameters: {
      path: projectParam,
      note: { type: 'string', description: 'A few words on what changed, shown in the version list (e.g. "Shield every 5 lanterns").' },
    },
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => presentation('preview', value.project, { buildId: value.buildId }),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      const build = await buildProject(dir, args.note ?? 'Rebuilt')
      await writeState(dir, build)
      const unnamed = await unnamedSlots(await loadManifest(dir))
      return {
        project: dir, buildId: build.buildId, bytes: build.bytes, artifact: build.artifact,
        ...(unnamed.length > 0 ? { note: namingHint(unnamed) } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_generate_asset',
    description: 'Generate candidate art for one asset slot. Two image services: openai (GPT Image API, about a minute, '
      + 'billed per image to the user\'s API key) and codex (the local Codex CLI and the user\'s Codex sign-in, no API key, '
      + 'several minutes per image, runs in the background and you get a completion notice). Omit provider to use the configured default. '
      + 'Before anything is spent the user is asked to approve the service, image count and expected cost; if they decline, ask what they want instead. '
      + 'Each candidate in a batch is a different take. Sprites must come back transparent; every image is checked for transparency '
      + 'and framing and fitted to the slot. Candidates are numbered per slot (#1, #2, …) in the sidebar and in this result; '
      + 'talk about them by those numbers, and apply one with game_studio_apply_asset only after the user picks it or asked you to choose.',
    parameters: {
      path: projectParam,
      slot: slotParam,
      prompt: { type: 'string', required: true, description: 'What the asset should depict, in the user\'s words plus any detail you add. The art style from game.json is added automatically.' },
      count: { type: 'integer', description: 'Number of candidates, 1-4. Default 2.' },
      quality: { type: 'string', enum: QUALITIES, description: 'Image quality for openai. Default medium. Ignored by codex.' },
      provider: { type: 'string', enum: PROVIDERS, description: 'Image service for this call. Omit to use the configured default.' },
      reference: { type: 'string', description: 'Optional reference picture the art should follow (design, colours, style): a path in the working directory or of an image the user attached in chat.' },
    },
    // Only reached when Codex has to run inside the call (no background jobs in this host).
    timeoutMs: 1_800_000,
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (args: any, value: any) => presentation('candidates', value.project, {
        slot: args.slot, provider: value.provider, count: value.count, job: value.job ?? null,
        candidates: value.candidates.map((item: any) => ({ id: item.id, file: item.file, pass: item.pass })),
      }),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      const count = Math.min(4, Math.max(1, Math.trunc(args.count ?? 2)))
      const provider = await chooseProvider(args.provider)
      const quality = provider === 'openai' ? (args.quality ?? 'medium') : 'auto'
      const generation = await prepareGeneration(dir, args.slot, args.prompt, quality)
      const reference = args.reference ? await loadReference(await ctx.workingDirectory.ensure(exec.agent, exec.signal), String(args.reference)) : undefined
      const batch = provider === 'codex' ? { ...await codexBatch(count), ...(reference ? { reference } : {}) } : undefined
      await confirmSpend(exec, provider, generation, count, quality, reference)
      if (batch === undefined) {
        const { candidates, errors } = await generateCandidates(dir, args.slot, args.prompt, { count, quality, ...(reference ? { reference } : {}) }, generator(exec.signal))
        const cost = candidates.reduce((sum, item) => sum + (openaiCost(item.model, item.usage) ?? 0), 0)
        return {
          project: dir, slot: args.slot, provider, count, candidates: candidates.map(candidateSummary), errors,
          costUsd: Math.round(cost * 10_000) / 10_000,
        }
      }
      let job: string | undefined
      // start() refuses when no job controller serves this agent; Codex then runs inside the call.
      try { job = jobs === undefined ? undefined : startCodexJob(dir, generation, batch, exec) } catch { job = undefined }
      if (job !== undefined) {
        return {
          project: dir, slot: args.slot, provider, count, job, status: 'running', candidates: [], usage: null,
          note: `Codex is drawing ${count} image${count === 1 ? '' : 's'} in the background, usually 3-6 minutes. `
            + 'Each candidate shows up in the Game Studio sidebar as soon as it is ready, and you will get a completion notice with the ids. '
            + 'Tell the user it is running; do not wait or poll.',
        }
      }
      const result = await runCodexBatch(dir, generation, batch, `codex-${shortId()}`, exec.signal)
      if (result.candidates.length === 0) throw new StudioError(`Codex produced no image: ${result.errors[0] ?? 'unknown error'}`, 'PROVIDER')
      return { project: dir, slot: args.slot, provider, count, candidates: result.candidates.map(candidateSummary), errors: result.errors, usage: null }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_apply_asset',
    description: 'Put one generated candidate into the game for its slot, rebuild, and refresh the preview. '
      + 'The previous asset is kept and can be restored with game_studio_revert_asset.',
    parameters: {
      path: projectParam, slot: slotParam,
      candidate: { type: 'string', required: true, description: 'The candidate\'s number as shown in the sidebar ("2" or "#2"), or its id.' },
    },
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => presentation('preview', value.project, { buildId: value.buildId }),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      const { record, candidate, build } = await applyCandidate(dir, args.slot, String(args.candidate))
      return { project: dir, slot: args.slot, number: candidate.number, file: record.file, buildId: build.buildId, license: record.license }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_revert_asset',
    description: 'Restore the previous asset of a slot, rebuild, and refresh the preview.',
    parameters: { path: projectParam, slot: slotParam },
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => presentation('preview', value.project, { buildId: value.buildId }),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      const { restored, build } = await revertSlot(dir, args.slot)
      return { project: dir, slot: args.slot, restored, buildId: build.buildId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_list',
    description: 'List the games in the working directory (every folder with game.json and .studio/, up to two levels down), '
      + 'most recently changed first, with title, 2D/3D, whether it is built, and how many versions it has. '
      + 'Use it to find the game the user means ("the penguin game") before editing it, instead of searching the folders yourself. '
      + 'The user sees the same games on the Game wall in the sidebar (+ → Game Studio · My games).',
    parameters: {},
    output: { schema: json, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args: any, exec: any) {
      const cwd = await projectDir(exec, '.')
      const scan = await listGames(cwd, exec.signal)
      return {
        games: scan.games.map(game => ({
          path: relative(cwd, game.project) || '.', title: game.title, dimension: game.dimension ?? 'unknown',
          built: game.built, versions: game.versions, updatedAt: game.updatedAt,
        })),
        ...(scan.partial ? { note: 'The workspace is large; only part of it was searched. Ask the user for the folder if the game is missing.' } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_export_wall',
    description: 'Export the game wall: one offline HTML page with a tile for every built game in the working directory (or the ones '
      + 'listed), where clicking a tile plays that game full-window. Good for sending to friends or putting on a static host. '
      + 'Written to export/<name>.html in the working directory. Games are not rebuilt; ones never built are left out and reported.',
    parameters: {
      games: { type: 'string', description: 'Optional JSON array of game folders (relative paths from game_studio_list) in display order. Default: every game, newest first.' },
      name: { type: 'string', description: 'File name without extension. Default game-wall.' },
      lang: { type: 'string', enum: ['zh', 'en'], description: 'Page language. Default: zh when the game titles are Chinese, else en.' },
    },
    output: { schema: json, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args: any, exec: any) {
      const cwd = await projectDir(exec, '.')
      let projects: string[] | undefined
      if (typeof args.games === 'string' && args.games.trim() !== '') {
        let parsed: unknown
        try { parsed = JSON.parse(args.games) } catch { throw new StudioError('games must be a JSON array of folder paths', 'BAD_GAMES') }
        if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new StudioError('games must be a JSON array of folder paths', 'BAD_GAMES')
        projects = parsed
      }
      const result = await exportWall({ root: cwd, projects, name: args.name, lang: args.lang as WallLang | undefined, signal: exec.signal })
      return { ...result, file: relative(cwd, result.file) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_export',
    description: 'Export the game as one self-contained HTML file (no network, works offline, opens in any browser or on a static host) '
      + 'into the project\'s export/ folder.',
    parameters: { path: projectParam, name: { type: 'string', description: 'File name without extension. Defaults to the game title.' } },
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => presentation('export', value.project, { file: value.file }),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      return { project: dir, ...(await exportGame(dir, args.name)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_export_wechat',
    description: 'Export the game as a WeChat mini-game project (game.js/game.json/project.config.json + wx runtime) '
      + 'into the project\'s export/wechat/<slug>/ folder. The user imports that folder in WeChat DevTools; '
      + 'this is not a web page. 2D canvas and 3D three.js/voxel games are supported: the engine is inlined, WebGL '
      + 'frames are composited onto the screen canvas and the HUD is redrawn from __gameState. SVG art is rasterised to PNG.',
    parameters: {
      path: projectParam,
      appid: { type: 'string', description: 'WeChat mini-game AppID. Defaults to touristappid; use the user\'s AppID for preview/upload.' },
      subpackage: { type: 'boolean', description: 'Put the slot art in an assets subpackage. Defaults to on when the art passes 1.5 MB; the export downloads it before the game starts.' },
    },
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => presentation('export', value.project, { file: value.dir, wechat: true }),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      const result = await exportWechat(dir, { appid: args.appid, subpackage: typeof args.subpackage === 'boolean' ? args.subpackage : undefined })
      await markReleaseDone(dir, 'export', `wechat export: ${result.dir}`).catch(() => undefined)
      return { project: dir, ...result }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_wechat_devtools',
    description: 'Drive WeChat DevTools for the exported mini-game: "open" imports the export folder into the IDE, '
      + '"preview" saves a device QR code next to the export, "upload" submits a version. Preview and upload also return '
      + 'the IDE\'s compiled package sizes (--info-output) when the IDE writes them. Requires WeChat DevTools and its '
      + 'service port (工具 → 设置 → 安全设置 → 服务端口). The plugin never changes that setting; a closed port comes back '
      + 'as DEVTOOLS_PORT_CLOSED with the steps to open it.',
    parameters: {
      path: projectParam,
      action: { type: 'string', enum: ['open', 'preview', 'upload', 'doctor'], description: 'What to do in the IDE. "doctor" only checks the environment (CLI, service port, AppID) and returns what to fix. Defaults to open.' },
      version: { type: 'string', description: 'Upload version, e.g. "1.0.0". Defaults to 1.0.0.' },
      desc: { type: 'string', description: 'Upload description shown in the WeChat admin version list.' },
      cli: { type: 'string', description: 'Path to the WeChat DevTools CLI, for a non-standard install. Defaults to the usual locations.' },
    },
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => presentation('export', value.project, { file: value.project, wechat: true }),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      const action = String(args.action ?? 'open')
      const cli = typeof args.cli === 'string' && args.cli !== '' ? args.cli : undefined
      if (action === 'doctor') {
        const exportDir = findWechatExport(dir)
        if (!exportDir) throw new StudioError('No WeChat mini-game export found; run the WeChat export first.', 'NO_WECHAT_EXPORT')
        return { project: dir, ...(await devtoolsDoctor(exportDir, { configuredCli: cli })) }
      }
      if (action === 'open') {
        const result = await openInDevtools(dir, { cli })
        await markReleaseDone(dir, 'devtools', 'opened in WeChat DevTools').catch(() => undefined)
        return { project: dir, ...result }
      }
      if (action === 'preview') return { project: dir, ...(await previewInDevtools(dir, { cli })) }
      if (action === 'upload') {
        const result = await uploadFromDevtools(dir, { version: args.version, desc: args.desc, cli })
        await markUploaded(dir, args.version ?? '1.0.0', uploadNote(args.version ?? '1.0.0', result)).catch(() => undefined)
        return { project: dir, ...result }
      }
      throw new StudioError(`Unknown DevTools action "${action}"; use open, preview, upload or doctor.`, 'BAD_ACTION')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_wechat_ci',
    description: 'Write a CI upload kit for the exported mini-game into the export folder: ci/upload.mjs (miniprogram-ci), '
      + '.github/workflows/wechat-upload.yml and ci/README.md. Needs the real AppID; the user adds WECHAT_APPID and '
      + 'WECHAT_PRIVATE_KEY as CI secrets. This only uploads a version - submitting for review still happens in the '
      + 'WeChat console.',
    parameters: {
      path: projectParam,
      version: { type: 'string', description: 'Default version written into the workflow, e.g. 1.0.0.' },
      desc: { type: 'string', description: 'Default version description.' },
    },
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => presentation('export', value.project, { file: value.dir, wechat: true }),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      const exportDir = findWechatExport(dir)
      if (!exportDir) throw new StudioError('No WeChat mini-game export found; run the WeChat export first.', 'NO_WECHAT_EXPORT')
      const result = await writeWechatCi(exportDir, { version: args.version, desc: args.desc })
      return { project: dir, ...result }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_wechat_commerce',
    description: 'WeChat monetization: store the ad unit IDs from the mini-game console (流量主 → 广告位管理), switch ads '
      + 'and analytics on or off, and report what the next export will do. Ads are never forced: one interstitial between '
      + 'two rounds, and a rewarded video only when the player taps 看广告复活. Needs the 流量主 capability first; the '
      + 'plugin never claims that a game is allowed to monetize.',
    parameters: {
      path: projectParam,
      action: { type: 'string', enum: ['status', 'configure'], description: 'Defaults to status.' },
      enabled: { type: 'boolean', description: 'Turn ads on or off.' },
      interstitial: { type: 'string', description: '插屏广告位 ID (adunit-...), empty string to clear.' },
      rewarded: { type: 'string', description: '激励视频广告位 ID (adunit-...), empty string to clear.' },
      analytics: { type: 'boolean', description: 'Report round/round-end/ad events through wx.reportEvent.' },
      iapEnabled: { type: 'boolean', description: 'Switch in-app purchases on. Requires a game licence number and a WeChat Pay merchant ID.' },
      licenseNumber: { type: 'string', description: '游戏版号 / 审批文号. Required for IAP.' },
      merchantId: { type: 'string', description: '微信支付商户号. Required for IAP.' },
      payUrl: { type: 'string', description: 'https endpoint that returns the signed parameters (signData/paySig/signature) for wx.requestMidasPaymentGameItem. Without it IAP runs in demo mode.' },
    },
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => presentation('export', value.project, { wechat: true }),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      if (String(args.action ?? 'status') === 'configure') {
        const state = await updateCommerce(dir, {
          enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
          interstitial: typeof args.interstitial === 'string' ? args.interstitial : undefined,
          rewarded: typeof args.rewarded === 'string' ? args.rewarded : undefined,
          analytics: typeof args.analytics === 'boolean' ? args.analytics : undefined,
          iapEnabled: typeof args.iapEnabled === 'boolean' ? args.iapEnabled : undefined,
          licenseNumber: typeof args.licenseNumber === 'string' ? args.licenseNumber : undefined,
          merchantId: typeof args.merchantId === 'string' ? args.merchantId : undefined,
          payUrl: typeof args.payUrl === 'string' ? args.payUrl : undefined,
        })
        return { project: dir, ...state, check: commerceCheck(state), embedded: embedCommerce(state) }
      }
      const state = await loadCommerce(dir)
      return { project: dir, ...state, check: commerceCheck(state), embedded: embedCommerce(state) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_wechat_release',
    description: 'The WeChat mini-game release wizard: every step from registering the mini-game to publishing it, with '
      + 'who does it (WeChat console / the plugin / the user), what it unblocks, and copy-paste materials. '
      + '"status" returns the checklist and the next 3 things to do; "update" records a step and the AppID, name, '
      + 'category, age rating and monetization choice; "materials" writes RELEASE.md next to the export with the texts '
      + 'to paste into the console. Steps marked "需在微信后台完成" cannot be automated by the plugin.',
    parameters: {
      path: projectParam,
      action: { type: 'string', enum: ['status', 'update', 'materials', 'review'], description: 'status, update a step, write the release materials, or write the review-risk guide.' },
      step: { type: 'string', description: 'Step id for update: register, verify, appid, basic-info, category, age-rating, privacy, record, export, devtools, upload, submit, publish, analytics, iaa, iap.' },
      status: { type: 'string', enum: ['todo', 'done', 'skipped'], description: 'New status for the step; defaults to done.' },
      note: { type: 'string', description: 'Short note stored with the step (certificate number, rejection reason, ...).' },
      appid: { type: 'string', description: 'The real mini-game AppID from the WeChat console.' },
      gameName: { type: 'string', description: 'Name registered in the WeChat console.' },
      category: { type: 'string', description: 'Service category chosen in the console.' },
      ageRating: { type: 'string', enum: ['8+', '12+', '16+'], description: 'Age rating for the 适龄提示.' },
      monetization: { type: 'string', enum: ['none', 'iaa', 'iap', 'both'], description: 'none, iaa (ads), iap (in-app purchases) or both.' },
    },
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => presentation('export', value.project, { file: value.file ?? value.game, wechat: true }),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      const action = String(args.action ?? 'status')
      if (action === 'review') {
        const guide = await reviewGuide(dir)
        await markReviewWritten(dir)
        return { project: dir, file: guide.file, risks: guide.risks, markdown: guide.markdown }
      }
      if (action === 'materials') {
        const manifest = await loadManifest(dir)
        const materials = await releaseMaterials(dir, {
          exportDir: findWechatExport(dir),
          manifestTitle: manifest.title,
          style: manifest.style,
          orientation: manifest.orientation,
          slots: Object.keys(manifest.slots).length,
        })
        await markMaterialsWritten(dir)
        return { project: dir, file: materials.file, markdown: materials.markdown }
      }
      if (action === 'update') {
        const result = await updateRelease(dir, {
          step: args.step, status: args.status, note: args.note, appid: args.appid,
          gameName: args.gameName, category: args.category, ageRating: args.ageRating, monetization: args.monetization,
        })
        return { project: dir, ...result.status }
      }
      const state = await loadRelease(dir)
      const presence = await releaseFilePresence(dir)
      const freshness = await releaseFreshness(dir, state)
      return { project: dir, ...releaseStatus(dir, state, releasePlan(state.monetization ?? 'none')), materialsPresent: presence.materials, reviewPresent: presence.review, materialsStale: freshness.materialsStale, reviewStale: freshness.reviewStale }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_versions',
    description: 'List the saved versions of the game, newest first. Every build that changed the game is a version '
      + '(code, rules and art together); the user can go back to any of them with game_studio_restore_version.',
    parameters: { path: projectParam },
    output: { schema: json, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      const versions = await listVersions(dir)
      return {
        project: dir,
        versions: versions.slice(0, 20).map(v => ({ version: v.number, note: v.note, createdAt: v.createdAt, buildId: v.buildId })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_restore_version',
    description: 'Go back to an earlier version of the whole game (code, rules and art), rebuild, and refresh the preview. '
      + 'The current state stays in the list, so going back can be undone the same way.',
    parameters: { path: projectParam, version: { type: 'integer', required: true, description: 'Version number from game_studio_versions or the sidebar.' } },
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => presentation('preview', value.project, { buildId: value.buildId }),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      return { project: dir, ...(await restoreVersion(dir, Math.trunc(args.version))) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_playtest',
    description: 'Play the latest game code in a headless Chrome or Edge on this computer and report what happened: '
      + 'phase changes (title → playing → won/lost), best score, hearts, frame rate, script errors, whether the hero stayed in view, '
      + 'and screenshots of the title, mid-game and end screens, plus close-ups of characters the game draws in code. '
      + GAME_STATE_CONTRACT + ' Use this instead of writing your own browser or screenshot scripts. '
      + 'Pass `rules` to change rules for this run only (e.g. {"duration": 3} to reach the win screen, {"hearts": 1} to test losing); '
      + 'the project, its build and its version history are not changed. '
      + 'While reshaping a character, pass characters: true to get only the close-ups, one image per slot, in a few seconds; '
      + 'do not write your own render scripts.',
    parameters: {
      path: projectParam,
      characters: { type: 'boolean', description: 'Only draw the close-ups of code-drawn characters (no play): fast, one image per slot. Default false.' },
      seconds: { type: 'integer', description: 'How long the autopilot plays, 1-60. Default 15.' },
      rules: { type: 'string', description: 'JSON object of rule overrides from game.json for this run only, e.g. {"duration": 3}.' },
      portrait: { type: 'boolean', description: 'true plays on a phone-shaped 390×844 touch screen, false at 960×540 landscape. '
        + 'Default follows "orientation" in game.json (portrait unless it says landscape); set that instead of passing this every time.' },
    },
    timeoutMs: 180_000,
    output: {
      schema: json,
      render: (_args: any, value: any) => [
        { type: 'text', text: value.summary },
        ...(value.images ?? []).flatMap((image: any) => [
          { type: 'text', text: `${image.name}:` },
          { type: 'image', attachment: image.attachment },
        ]),
      ],
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      let rules: Record<string, unknown> | undefined
      if (args.rules !== undefined && String(args.rules).trim() !== '') {
        try { rules = typeof args.rules === 'string' ? JSON.parse(args.rules) : args.rules }
        catch { throw new StudioError('rules must be a JSON object, e.g. {"duration": 3}', 'BAD_RULES') }
        if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) throw new StudioError('rules must be a JSON object, e.g. {"duration": 3}', 'BAD_RULES')
      }
      const report = await playtest(dir, {
        ...(args.seconds !== undefined ? { seconds: Number(args.seconds) } : {}),
        ...(rules ? { rules } : {}),
        ...(typeof args.portrait === 'boolean' ? { portrait: args.portrait } : {}),
        ...(args.characters === true ? { charactersOnly: true } : {}),
        signal: exec.signal,
      })
      let summary = describePlaytest(report).replaceAll(`${dir}/`, '')
      const images: Array<{ name: string; attachment: unknown }> = []
      if (attachments !== undefined && await seesImages(exec)) {
        // One tool result is one message; keep its images inside the per-message byte limit.
        const limits = attachments.imageLimits ?? {}
        let budget = Math.min(limits.maxImageBytes ?? Infinity, limits.maxMessageImageBytes ?? Infinity)
        const order = ['characters', 'mid', 'end', 'title']
        for (const shot of [...report.shots].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))) {
          const data = await readFile(shot.file)
          if (data.byteLength > budget) continue
          try {
            images.push({ name: shot.name, attachment: await attachments.saveImage({ data: new Uint8Array(data), mediaType: shot.mediaType, name: basename(shot.file) }) })
            budget -= data.byteLength
          } catch { /* the file path in the summary still points at it */ }
        }
      } else {
        summary += '\nThis model cannot view images here; open the screenshots with read_image if it can, or describe them from the numbers above.'
      }
      return {
        project: dir, summary, finalPhase: report.finalPhase, bestScore: report.bestScore,
        errors: report.errors.length, runDir: relative(dir, report.runDir), images,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_share',
    description: 'Let a phone on the same Wi-Fi (or a friend on any network) play the game: opens a temporary read-only link '
      + 'that serves only this game\'s latest build, and shows its QR code in the Game Studio sidebar. '
      + 'By default the link is on the local network only; pass `public: true` to open a temporary public link via a Cloudflare Quick Tunnel '
      + '(`trycloudflare.com`) that anyone on any network can open. Public links require `cloudflared` on the user\'s computer; '
      + 'when it is missing, this tool returns the install command — tell the user and do not download or install `cloudflared` yourself. '
      + 'The user approves opening the link first. It stops after `minutes` (default 30) or with stop: true. Rebuilds show up after a refresh.',
    parameters: {
      path: projectParam,
      minutes: { type: 'integer', description: 'How long the link stays open, 1-240. Default 30.' },
      public: { type: 'boolean', description: 'Open a temporary public link via Cloudflare Quick Tunnel (requires cloudflared). Default false (local Wi-Fi only).' },
      stop: { type: 'boolean', description: 'Close the link now instead.' },
    },
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => presentation('share', value.project, {}),
    },
    async execute(args: any, exec: any) {
      const dir = await projectDir(exec, args.path)
      if (args.stop === true) {
        const stopped = stopShare(dir)
        await writeState(dir)
        return { project: dir, stopped }
      }
      const minutes = Math.min(240, Math.max(1, Math.trunc(args.minutes ?? 30)))
      const isPublic = args.public === true
      try {
        if (isPublic) requireCloudflared(config.cloudflaredPath)
      } catch (error) {
        if (error instanceof StudioError && error.code === 'NO_TUNNEL') {
          throw new StudioError(`${error.message} ${NO_TUNNEL_AGENT_HINT}`, 'NO_TUNNEL')
        }
        throw error
      }
      const title = (await loadManifest(dir)).title
      await askToShare(approval, exec, 'game_studio_share', isPublic ? {
        en: `Open a temporary public link for ${minutes} minutes: anyone with the link can play "${title}", and traffic goes through Cloudflare's servers. Only this game's latest build is served.`,
        zh: `开一个公网临时试玩链接 ${minutes} 分钟：拿到链接的任何人都能玩《${title}》，流量经过 Cloudflare 的服务器。只提供这个游戏最新的构建文件。`,
      } : {
        en: `Open a temporary link on your local network for ${minutes} minutes so a phone on the same Wi-Fi can play "${title}". Only this game's latest build is served.`,
        zh: `在局域网开放一个临时试玩链接 ${minutes} 分钟，让同一 Wi-Fi 下的手机能玩《${title}》。只提供这个游戏最新的构建文件。`,
      })
      try {
        return { project: dir, ...(await shareGame(dir, minutes, isPublic ? 'public' : 'lan', exec.signal)), note: 'The QR code is in the Game Studio sidebar.' }
      } catch (error) {
        if (error instanceof StudioError && error.code === 'NO_TUNNEL') {
          throw new StudioError(`${error.message} ${NO_TUNNEL_AGENT_HINT}`, 'NO_TUNNEL')
        }
        throw error
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'game_studio_publish',
    description: 'Publish the built game (or the whole game wall) to GitHub Pages for a permanent public link (`https://<user>.github.io/<repo>/<game>/`) '
      + 'that works even after the user closes their computer. Requires the GitHub CLI (`gh`) installed and signed in (`gh auth login`) on this computer; '
      + 'when `gh` is missing or not signed in, tell the user how to install and sign in — do not download, install, or run `gh auth login` yourself. '
      + 'Uploads only the built self-contained HTML file to a public repository under the user\'s GitHub account (default `dsh-games`), so published game files are public. '
      + 'Refuses to write to any existing repository that does not carry its `.dsh-game-studio.json` marker. '
      + 'Asks the user for approval before publishing or removing. Pass `remove: true` to delete a published game (or the wall) from the repository.',
    parameters: {
      path: { type: 'string', description: 'Game project folder, relative to the working directory. Required unless wall is true.' },
      wall: { type: 'boolean', description: 'Publish (or remove) the whole game wall instead of a single game; path may be omitted. Default false.' },
      games: { type: 'string', description: 'When wall is true: optional JSON array of game folders (relative paths from game_studio_list) in display order. Default: every built game, newest first.' },
      remove: { type: 'boolean', description: 'Remove this game (or the game wall) from the GitHub Pages repository and regenerate the directory page. Default false.' },
    },
    timeoutMs: 240_000,
    output: {
      schema: json,
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => value.project ? presentation('publish', value.project, { url: value.url }) : undefined,
    },
    async execute(args: any, exec: any) {
      const cwd = await projectDir(exec, '.')
      const isWall = args.wall === true
      const isRemove = args.remove === true
      let projects: string[] | undefined
      if (isWall && typeof args.games === 'string' && args.games.trim() !== '') {
        let parsed: unknown
        try { parsed = JSON.parse(args.games) } catch { throw new StudioError('games must be a JSON array of folder paths', 'BAD_GAMES') }
        if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new StudioError('games must be a JSON array of folder paths', 'BAD_GAMES')
        projects = parsed
      }
      const dir = isWall
        ? (typeof args.path === 'string' && args.path.trim() !== '' ? await projectDir(exec, args.path) : undefined)
        : await projectDir(exec, String(args.path ?? ''))
      try {
        return await publishToPages({
          cwd,
          ...(dir ? { dir } : {}),
          wall: isWall,
          ...(projects ? { projects } : {}),
          remove: isRemove,
          exec,
          signal: exec.signal,
        })
      } catch (error) {
        if (error instanceof StudioError && error.code === 'NO_GH') {
          throw new StudioError(`${error.message} ${NO_GH_AGENT_HINT}`, 'NO_GH')
        }
        if (error instanceof StudioError && error.code === 'GH_NOT_LOGGED_IN') {
          throw new StudioError(`${error.message} ${GH_AUTH_AGENT_HINT}`, 'GH_NOT_LOGGED_IN')
        }
        throw error
      }
    },
  }))

  // The sidebar's buttons call the same operations through this command.
  // Input: `<action> <json>`, where json carries an absolute project path.
  ctx.inject(['commands'], (child: any) => {
    child.commands.register({
      name: 'game-studio',
      description: 'Game Studio sidebar actions (apply, revert, build, export, export-wechat, wechat-devtools, wechat-release, wechat-commerce, wechat-ci, restore, share, unshare, status, wall, publish, unpublish)',
      input: { hint: '<apply|revert|build|export|export-wechat|wechat-devtools|wechat-release|wechat-commerce|wechat-ci|restore|share|unshare|status|wall|publish|unpublish> {"project": "...", ...}' },
      async handler({ agent, rawInput }: any) {
        try {
          // The Harness passes everything after `/game-studio`, leading whitespace included.
          const input = String(rawInput).trim()
          const space = input.search(/\s/u)
          const action = space < 0 ? input : input.slice(0, space)
          if (!action) return { kind: 'success', text: COMMAND_HELP }
          const payload = space < 0 ? {} : JSON.parse(input.slice(space + 1))
          const cwd = await ctx.workingDirectory.ensure(agent)
          if (action === 'wall') {
            const projects = Array.isArray(payload.projects) ? payload.projects.filter((item: unknown) => typeof item === 'string') : undefined
            const lang = payload.lang === 'zh' || payload.lang === 'en' ? payload.lang : undefined
            const wall = await exportWall({ root: cwd, projects, lang })
            return { kind: 'success', text: JSON.stringify(wall) }
          }
          if (action === 'publish' || action === 'unpublish' || action === 'publish-wall') {
            const isWall = action === 'publish-wall' || payload.wall === true || payload.wall === 'true'
            const isRemove = action === 'unpublish' || payload.remove === true || payload.remove === 'true'
            const projects = Array.isArray(payload.projects) ? payload.projects.filter((item: unknown) => typeof item === 'string') : undefined
            const lang = payload.lang === 'zh' || payload.lang === 'en' ? payload.lang : undefined
            const dir = isWall ? undefined : resolveInside(cwd, String(payload.project ?? ''))
            // The user pressed the button themselves, so no further approval is asked.
            const published = await publishToPages({
              cwd,
              ...(dir ? { dir } : {}),
              wall: isWall,
              ...(projects ? { projects } : {}),
              remove: isRemove,
              ...(lang ? { lang } : {}),
            })
            return { kind: 'success', text: JSON.stringify(published) }
          }
          const dir = resolveInside(cwd, String(payload.project ?? ''))
          let result: unknown
          if (action === 'apply') result = await applyCandidate(dir, String(payload.slot), String(payload.candidate))
          else if (action === 'revert') result = await revertSlot(dir, String(payload.slot))
          else if (action === 'build') { const build = await buildProject(dir, 'Rebuilt from the sidebar'); await writeState(dir, build); result = build }
          else if (action === 'export') result = await exportGame(dir)
          else if (action === 'export-wechat') {
            result = await exportWechat(dir, {
              appid: typeof payload.appid === 'string' ? payload.appid : undefined,
              subpackage: typeof payload.subpackage === 'boolean' ? payload.subpackage : undefined,
            })
            await markReleaseDone(dir, 'export', 'exported from the sidebar').catch(() => undefined)
          }
          else if (action === 'wechat-devtools') {
            const op = String(payload.op ?? 'open')
            if (!['open', 'preview', 'upload', 'doctor'].includes(op)) throw new StudioError(`Unknown DevTools action "${op}". Use open, preview, upload or doctor.`, 'BAD_ACTION')
            const cli = typeof payload.cli === 'string' && payload.cli !== '' ? payload.cli : undefined
            if (op === 'doctor') {
              const exportDir = findWechatExport(dir)
              if (!exportDir) throw new StudioError('No WeChat mini-game export found; run the WeChat export first.', 'NO_WECHAT_EXPORT')
              result = await devtoolsDoctor(exportDir, { configuredCli: cli })
            }
            else if (op === 'preview') result = await previewInDevtools(dir, { cli })
            else if (op === 'upload') {
              const version = String(payload.version ?? '1.0.0')
              result = await uploadFromDevtools(dir, { version, desc: typeof payload.desc === 'string' ? payload.desc : undefined, cli })
              await markUploaded(dir, version, uploadNote(version, result)).catch(() => undefined)
            } else {
              result = await openInDevtools(dir, { cli })
              await markReleaseDone(dir, 'devtools', 'opened in WeChat DevTools').catch(() => undefined)
            }
          }
          else if (action === 'wechat-ci') {
            const exportDir = findWechatExport(dir)
            if (!exportDir) throw new StudioError('No WeChat mini-game export found; run the WeChat export first.', 'NO_WECHAT_EXPORT')
            result = await writeWechatCi(exportDir, {
              version: typeof payload.version === 'string' ? payload.version : undefined,
              desc: typeof payload.desc === 'string' ? payload.desc : undefined,
            })
          }
          else if (action === 'wechat-commerce') {
            const commerceOp = String(payload.op ?? 'status')
            // A misspelt "configure" used to fall back to status, so the user
            // believed the ad units were saved when they were not.
            if (!['status', 'configure'].includes(commerceOp)) throw new StudioError(`Unknown commerce action "${commerceOp}". Use status or configure.`, 'BAD_ACTION')
            const state = commerceOp === 'configure'
              ? await updateCommerce(dir, {
                enabled: typeof payload.enabled === 'boolean' ? payload.enabled : undefined,
                interstitial: typeof payload.interstitial === 'string' ? payload.interstitial : undefined,
                rewarded: typeof payload.rewarded === 'string' ? payload.rewarded : undefined,
                analytics: typeof payload.analytics === 'boolean' ? payload.analytics : undefined,
                iapEnabled: typeof payload.iapEnabled === 'boolean' ? payload.iapEnabled : undefined,
                licenseNumber: typeof payload.licenseNumber === 'string' ? payload.licenseNumber : undefined,
                merchantId: typeof payload.merchantId === 'string' ? payload.merchantId : undefined,
                payUrl: typeof payload.payUrl === 'string' ? payload.payUrl : undefined,
              })
              : await loadCommerce(dir)
            result = { ...state, check: commerceCheck(state), embedded: embedCommerce(state) }
          }
          else if (action === 'wechat-release') {
            const op = String(payload.op ?? 'status')
            if (!['status', 'update', 'materials', 'review'].includes(op)) throw new StudioError(`Unknown release action "${op}". Use status, update, materials or review.`, 'BAD_ACTION')
            if (op === 'review') {
              const guide = await reviewGuide(dir)
              await markReviewWritten(dir)
              result = { file: guide.file, risks: guide.risks }
            } else if (op === 'materials') {
              const manifest = await loadManifest(dir)
              const materials = await releaseMaterials(dir, { exportDir: findWechatExport(dir), manifestTitle: manifest.title, style: manifest.style, orientation: manifest.orientation })
              await markMaterialsWritten(dir)
              result = materials
            } else if (op === 'update') {
              const updated = await updateRelease(dir, {
                step: typeof payload.step === 'string' ? payload.step : undefined,
                status: typeof payload.status === 'string' ? payload.status as any : undefined,
                note: typeof payload.note === 'string' ? payload.note : undefined,
                appid: typeof payload.appid === 'string' ? payload.appid : undefined,
                gameName: typeof payload.gameName === 'string' ? payload.gameName : undefined,
                category: typeof payload.category === 'string' ? payload.category : undefined,
                ageRating: typeof payload.ageRating === 'string' ? payload.ageRating as any : undefined,
                monetization: typeof payload.monetization === 'string' ? payload.monetization as any : undefined,
              })
              result = updated.status
            } else {
              const state = await loadRelease(dir)
              const presence = await releaseFilePresence(dir)
              const freshness = await releaseFreshness(dir, state)
              result = { ...releaseStatus(dir, state, releasePlan(state.monetization ?? 'none')), materialsPresent: presence.materials, reviewPresent: presence.review, materialsStale: freshness.materialsStale, reviewStale: freshness.reviewStale }
            }
          }
          else if (action === 'restore') result = await restoreVersion(dir, Math.trunc(Number(payload.version)))
          // The user pressed the button themselves, so no further approval is asked.
          else if (action === 'share') result = await shareGame(dir, Number(payload.minutes ?? 30), payload.scope === 'public' ? 'public' : 'lan')
          else if (action === 'unshare') { stopShare(dir); await writeState(dir); result = { stopped: true } }
          else if (action === 'status') { const state = await writeState(dir); result = { share: state.share } }
          else return {
            kind: 'error',
            text: `Unknown action "${action}". Valid actions: ${COMMAND_ACTIONS.map(([name]) => name).join(', ')}. Send /game-studio with no action for details.`,
          }
          return { kind: 'success', text: JSON.stringify(result) }
        } catch (error) {
          if (error instanceof StudioError && error.code === 'NO_TUNNEL') {
            return {
              kind: 'error',
              text: JSON.stringify({
                code: 'NO_TUNNEL',
                platform: process.platform,
                install: cloudflaredInstallCommand(process.platform),
                message: error.message,
              }),
            }
          }
          if (error instanceof StudioError && error.code === 'NO_GH') {
            return {
              kind: 'error',
              text: JSON.stringify({
                code: 'NO_GH',
                platform: process.platform,
                install: ghInstallCommand(process.platform),
                message: error.message,
              }),
            }
          }
          if (error instanceof StudioError && error.code === 'GH_NOT_LOGGED_IN') {
            return {
              kind: 'error',
              text: JSON.stringify({
                code: 'GH_NOT_LOGGED_IN',
                message: error.message,
              }),
            }
          }
          if (error instanceof StudioError && error.code === 'REPO_NOT_OURS') {
            return {
              kind: 'error',
              text: JSON.stringify({
                code: 'REPO_NOT_OURS',
                repo: (error as StudioError & { repo?: string }).repo ?? (config.githubRepo ?? DEFAULT_GITHUB_REPO),
                message: error.message,
              }),
            }
          }
          if (error instanceof StudioError && error.code === 'GH_FAILED') {
            return {
              kind: 'error',
              text: JSON.stringify({
                code: 'GH_FAILED',
                message: error.message,
              }),
            }
          }
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  })
}










