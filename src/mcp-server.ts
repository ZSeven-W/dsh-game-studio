/**
 * Standalone stdio Model Context Protocol (MCP) server for `@zseven-w/dsh-game-studio`.
 *
 * Powers Codex (`codex plugin add dsh-game-studio@zseven-game-studio`), Claude Code
 * (`claude plugin install dsh-game-studio@dsh-game-studio`), Antigravity, and Grok CLI
 * using the exact same game templates, build pipeline, headless Chrome playtester,
 * AI sprite generator, GitHub Pages publisher, and WeChat Mini Game exporter as the DSH plugin.
 */
import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import {
  applyCandidate, generateCandidates, prepareGeneration, revertSlot, writeState,
  type CandidateMeta, type ImageGenerator,
} from './assets.ts'
import { buildProject } from './build.ts'
import { runCodexBatch, type CodexBatch } from './generation.ts'
import { GH_AUTH_AGENT_HINT, NO_GH_AGENT_HINT } from './github.ts'
import {
  exportProjectHtml, publishProjectToPages, restoreProjectVersion, shareProjectGame,
} from './operations.ts'
import { openaiCost } from './pricing.ts'
import {
  describePlaytest, GAME_STATE_CONTRACT, launchBrowser, playtest, PLAYTEST_PLATFORMS,
  RENDERS_CONTRACT, type PlaytestPlatform,
} from './playtest.ts'
import { createProject, loadManifest, ORIENTATIONS, TEMPLATES, unnamedSlots, type SlotRequest, type TemplateId, type Orientation } from './project.ts'
import { CODEX_EFFORTS, resolveCodex, type CodexEffort } from './providers/codex.ts'
import { OPENAI_DEFAULT_MODEL, openaiGenerate } from './providers/openai.ts'
import { loadReference } from './reference.ts'
import { stopAllShares, stopShare } from './share.ts'
import { findCloudflared, NO_TUNNEL_AGENT_HINT, requireCloudflared } from './tunnel.ts'
import { resolveInside, shortId, StudioError } from './util.ts'
import { listVersions } from './versions.ts'
import { exportWall, listGames, type WallLang } from './wall.ts'
import { exportWechatProject, findWechatCli, NO_WECHAT_CLI_HINT, uploadWechatProject } from './wechat.ts'
import { findGh } from './github.ts'

export const MCP_SERVER_NAME = 'dsh-game-studio'
export const MCP_SERVER_VERSION = '0.1.0-rc.6'
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024
const MAX_MCP_IMAGE_BUDGET_BYTES = 12 * 1024 * 1024

const EDIT_SLOT_FILES = 'You may draw a slot\'s picture yourself by overwriting its file in assets/ (e.g. write your own SVG or PNG); '
  + 'the studio notices on the next build and records it as your edit, so leave assets/ASSETS.json alone.'

const SLOTS_EXAMPLE = '{"hero": "小鸡", "enemy": "狐狸", "card": {"label": "卡面", "size": [256, 384]}, "pickup": null}'

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
  return `Slots ${slots.join(', ')} still use generic template labels; set slots.<slot>.label in game.json `
    + 'to the user\'s characters in their language (e.g. "小鸡").'
}

function candidateSummary(item: CandidateMeta) {
  return { number: item.number, id: item.id, file: item.file, pass: item.checks.pass, problems: item.checks.problems, model: item.model }
}

export interface McpToolSchema {
  name: string
  title?: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

const workspaceDirProperty = {
  type: 'string',
  description: 'Absolute path to the user\'s active workspace directory (pass your current working directory so relative `path` resolves inside the user\'s workspace).',
}

const projectPathProperty = {
  type: 'string',
  description: 'Game project folder path (relative to `workspaceDir`, or an absolute path inside the user\'s workspace).',
}

const slotProperty = {
  type: 'string',
  description: 'Asset slot name from `game.json` (e.g. `hero`, `enemy`, `pickup`, `background`, or a custom slot).',
}

export const MCP_GAME_STUDIO_TOOLS: McpToolSchema[] = [
  {
    name: 'game_studio_create',
    title: 'Create Game Project',
    description:
      'Create a playable 2D or 3D web game from a built-in template ("collector" 2D Canvas or "voxel" 3D Three.js WebGL) '
      + 'and build its self-contained `dist/index.html`. '
      + RENDERS_CONTRACT + ' ' + GAME_STATE_CONTRACT + ' ' + EDIT_SLOT_FILES,
    inputSchema: {
      type: 'object',
      properties: {
        path: { ...projectPathProperty, description: 'New, empty folder for the game (relative to `workspaceDir` or absolute).' },
        title: { type: 'string', description: 'Game title shown on the title screen (use pure simplified Chinese if targeting WeChat Mini Games).' },
        style: { type: 'string', description: 'Art direction shared across generated assets, e.g. "plump glossy 3D vinyl toy, warm pastel studio lighting".' },
        template: { type: 'string', enum: [...TEMPLATES], description: 'Starter template: "collector" (default, 2D) or "voxel" (3D Three.js).' },
        orientation: { type: 'string', enum: [...ORIENTATIONS], description: '"portrait" (default, phone upright) or "landscape".' },
        slots: {
          type: 'string',
          description: `Optional JSON object string defining or renaming art slots (or null to drop a slot), e.g. '${SLOTS_EXAMPLE}'.`,
        },
        workspaceDir: workspaceDirProperty,
      },
      required: ['path', 'title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'game_studio_build',
    title: 'Build Game HTML',
    description:
      'Rebuild the game into a single self-contained offline `dist/index.html` after editing `game.json`, `game.js`, or `assets/`, '
      + 'and save a restorable version snapshot. Check `node --check game.js` before building when editing `game.js`. '
      + RENDERS_CONTRACT + ' ' + EDIT_SLOT_FILES,
    inputSchema: {
      type: 'object',
      properties: {
        path: projectPathProperty,
        note: { type: 'string', description: 'Short description of what changed for version history.' },
        workspaceDir: workspaceDirProperty,
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'game_studio_playtest',
    title: 'Headless Playtest & Screenshots',
    description:
      'Play the latest game code in headless Chrome/Edge, verify phases (`title -> playing -> won/lost`), FPS, console/page errors, '
      + 'zero external network requests, and return screenshots (`title`, `mid`, `end`, plus code-drawn `characters`). '
      + 'Pass `platform: "wechat"` to simulate a WeChat Mini Game phone (`390×844` portrait or `844×390` landscape, `window.wx` APIs, '
      + 'single-WebGL check, and a visible top-right WeChat capsule overlay on screenshots to catch HUD collisions). '
      + GAME_STATE_CONTRACT,
    inputSchema: {
      type: 'object',
      properties: {
        path: projectPathProperty,
        characters: { type: 'boolean', description: 'Only render close-ups of code-drawn characters without playing a round. Default false.' },
        seconds: { type: 'integer', description: 'How many seconds the autopilot plays (1–60). Default 15.' },
        rules: { type: 'string', description: 'JSON object string of temporary rule overrides for this run only, e.g. \'{"duration": 3}\'.' },
        portrait: { type: 'boolean', description: 'Override orientation (`true` = 390×844 touch, `false` = landscape). Defaults to `game.json` orientation.' },
        platform: {
          type: 'string',
          enum: [...PLAYTEST_PLATFORMS],
          description: '"web" (default) or "wechat" (WeChat Mini Game capsule overlay + `wx.*` mock + single-WebGL check).',
        },
        workspaceDir: workspaceDirProperty,
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'game_studio_generate_asset',
    title: 'Generate AI Sprite / Background Candidates',
    description:
      'Generate 1–4 AI art candidates for an asset slot using either `openai` (`OPENAI_API_KEY`, fast transparent PNGs) '
      + 'or `codex` (local Codex CLI sign-in, no API key needed). Automatically checks sprite alpha transparency, crops & centers sprites, '
      + 'and numbers candidates (`#1`, `#2`, …) for `game_studio_apply_asset`.',
    inputSchema: {
      type: 'object',
      properties: {
        path: projectPathProperty,
        slot: slotProperty,
        prompt: { type: 'string', description: 'What the asset depicts; `style` from `game.json` is prepended automatically.' },
        count: { type: 'integer', description: 'Number of candidates (1–4). Default 2.' },
        quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Quality for `openai` provider. Default "medium".' },
        provider: { type: 'string', enum: ['openai', 'codex'], description: 'Image provider ("openai" or "codex"). Auto-detected when omitted.' },
        reference: { type: 'string', description: 'Optional path to a reference image inside the workspace.' },
        workspaceDir: workspaceDirProperty,
      },
      required: ['path', 'slot', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'game_studio_apply_asset',
    title: 'Apply Generated Asset Candidate',
    description: 'Apply a generated candidate (`"1"`, `"#1"`, or candidate id) to its slot, rebuild the game, and keep the previous art revertible.',
    inputSchema: {
      type: 'object',
      properties: {
        path: projectPathProperty,
        slot: slotProperty,
        candidate: { type: 'string', description: 'Candidate number (e.g. "1" or "#1") or candidate id.' },
        workspaceDir: workspaceDirProperty,
      },
      required: ['path', 'slot', 'candidate'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'game_studio_revert_asset',
    title: 'Revert Slot Asset',
    description: 'Restore the previous asset version of a slot and rebuild the game.',
    inputSchema: {
      type: 'object',
      properties: {
        path: projectPathProperty,
        slot: slotProperty,
        workspaceDir: workspaceDirProperty,
      },
      required: ['path', 'slot'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'game_studio_list',
    title: 'List Workspace Games',
    description: 'List all `dsh-game-studio` projects in `workspaceDir` (up to two levels deep), sorted most-recently-updated first.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceDir: workspaceDirProperty,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'game_studio_export_wall',
    title: 'Export Offline Game Wall HTML',
    description: 'Pack all built games in `workspaceDir` (or a chosen list) into a single offline `export/<name>.html` arcade wall.',
    inputSchema: {
      type: 'object',
      properties: {
        games: { type: 'string', description: 'Optional JSON array string of relative project paths in display order.' },
        name: { type: 'string', description: 'Output file name without `.html`. Default "game-wall".' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Wall UI language ("zh" or "en").' },
        workspaceDir: workspaceDirProperty,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'game_studio_export',
    title: 'Export Single-File Web HTML',
    description: 'Export the game as a standalone zero-network `.html` file inside `<project>/export/`.',
    inputSchema: {
      type: 'object',
      properties: {
        path: projectPathProperty,
        name: { type: 'string', description: 'Optional file name without `.html` (defaults to slugified game title).' },
        workspaceDir: workspaceDirProperty,
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'game_studio_export_wechat',
    title: 'Export WeChat Mini Game Package',
    description:
      'Export the game as a `< 4.00 MB` WeChat Mini Game directory (`<project>/wx-minigame/`) from the single-source `game.js` and `game.json`. '
      + 'Generates `project.config.json`, `game.json`, universal `weapp-adapter.js` (WebGL2 + Canvas2D + pointer/touch + `localStorage` + WebAudio + `window.GAME.safeArea`), '
      + '`wx-config.js` + `window.GAME.watchRewardedAd()` (zero-interstitial IAA helper with pre-100 UV free fallback), '
      + 'rasterizes `.svg` slots to `.png` for real iOS/Android compatibility, and writes `WECHAT_SUBMISSION_DRAFT.md` (5 qualification system descriptions + CADPA `8+` checklist).',
    inputSchema: {
      type: 'object',
      properties: {
        path: projectPathProperty,
        appid: { type: 'string', description: 'WeChat Mini Game AppID (e.g. "wx1234567890abcdef"). Preserves existing AppID on rebuild; defaults to "touristappid".' },
        shareTitle: { type: 'string', description: 'Optional default title for WeChat friend/Moments share cards.' },
        adUnitId: { type: 'string', description: 'Optional Rewarded Video Ad Unit ID ("adunit-..."). Keep empty before reaching 100 cumulative UV.' },
        workspaceDir: workspaceDirProperty,
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'game_studio_upload_wechat',
    title: 'Upload WeChat Mini Game Experience Build',
    description:
      'Upload an exported `<project>/wx-minigame/` package to WeChat Mini Game backend via the local WeChat DevTools CLI (`wechatide` or WeChat DevTools `cli`). '
      + 'Requires user intent, a real `wx...` AppID, and semver `version` (e.g. `"1.0.0"`).',
    inputSchema: {
      type: 'object',
      properties: {
        path: projectPathProperty,
        version: { type: 'string', description: 'Release version string, e.g. "1.0.0".' },
        desc: { type: 'string', description: 'Player-facing Chinese release summary shown to WeChat reviewers (avoid git commit jargon).' },
        appid: { type: 'string', description: 'Optional WeChat Mini Game AppID override ("wx...").' },
        confirmToken: { type: 'string', description: 'Optional `confirmation_upload_...` token returned by a first-time `wechatide` prompt.' },
        workspaceDir: workspaceDirProperty,
      },
      required: ['path', 'version'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'game_studio_versions',
    title: 'List Saved Game Versions',
    description: 'List up to 20 saved build versions of the game (newest first) so any earlier state can be restored.',
    inputSchema: {
      type: 'object',
      properties: {
        path: projectPathProperty,
        workspaceDir: workspaceDirProperty,
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'game_studio_restore_version',
    title: 'Restore Earlier Game Version',
    description: 'Restore `game.js`, `game.json`, and `assets/` from an earlier version number and rebuild.',
    inputSchema: {
      type: 'object',
      properties: {
        path: projectPathProperty,
        version: { type: 'integer', description: 'Version number from `game_studio_versions`.' },
        workspaceDir: workspaceDirProperty,
      },
      required: ['path', 'version'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'game_studio_share',
    title: 'Open Local / Tunnel Preview Link',
    description:
      'Start a temporary read-only HTTP server serving the game\'s latest `dist/index.html` on LAN Wi-Fi (or publicly via Cloudflare Quick Tunnel when `public: true` and `cloudflared` is installed). '
      + 'Use this in Codex / Claude Code / Antigravity when the user wants a live browser or phone URL to play right away.',
    inputSchema: {
      type: 'object',
      properties: {
        path: projectPathProperty,
        minutes: { type: 'integer', description: 'How many minutes to keep the link open (1–240). Default 30.' },
        public: { type: 'boolean', description: 'Open a public `trycloudflare.com` tunnel (requires `cloudflared`). Default false (local LAN URL).' },
        stop: { type: 'boolean', description: 'Stop the active share server for this project.' },
        workspaceDir: workspaceDirProperty,
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'game_studio_publish',
    title: 'Publish to GitHub Pages',
    description:
      'Publish the built game (or the whole game wall when `wall: true`) to a permanent public GitHub Pages URL (`https://<user>.github.io/dsh-games/<slug>/`) '
      + 'using the signed-in `gh` CLI. Only call when the user explicitly asks to publish or unpublish (`remove: true`).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { ...projectPathProperty, description: 'Game project folder (required unless `wall: true`).' },
        wall: { type: 'boolean', description: 'Publish or remove the entire game wall instead of one game. Default false.' },
        games: { type: 'string', description: 'Optional JSON array string of relative project paths when `wall: true`.' },
        remove: { type: 'boolean', description: 'Remove the published game or wall from GitHub Pages. Default false.' },
        workspaceDir: workspaceDirProperty,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
]

export function isPluginCacheDir(dir: string): boolean {
  const normalized = dir.replace(/\\/gu, '/')
  return (
    normalized.includes('/.codex/plugins/')
    || normalized.includes('/.claude/plugins/')
    || normalized.endsWith('/plugins/game-studio')
    || normalized.includes('/plugins/game-studio/')
  )
}

export function resolveEffectiveWorkspaceDir(options: {
  workspaceDir?: unknown
  candidatePath?: unknown
  fallbackCwd?: string
  requireWorkspaceWhenCached?: boolean
}): string {
  const fallback = options.fallbackCwd ?? process.cwd()
  if (typeof options.workspaceDir === 'string' && options.workspaceDir.trim() !== '') {
    return resolve(fallback, options.workspaceDir.trim())
  }
  if (typeof options.candidatePath === 'string' && options.candidatePath.trim() !== '' && isAbsolute(options.candidatePath.trim())) {
    const abs = resolve(options.candidatePath.trim())
    if (isPluginCacheDir(fallback)) {
      return dirname(abs)
    }
  }
  const envWorkspace = process.env.DSH_GAME_STUDIO_WORKSPACE || process.env.CODEX_WORKSPACE_DIR
  if (isPluginCacheDir(fallback) && typeof envWorkspace === 'string' && envWorkspace.trim() !== '') {
    return resolve(envWorkspace.trim())
  }
  if (isPluginCacheDir(fallback) && options.requireWorkspaceWhenCached !== false) {
    throw new StudioError(
      'Pass `workspaceDir` (the user\'s active workspace folder, e.g. "/path/to/workspace") or an absolute `path` so game files are stored in the user\'s workspace instead of the plugin cache directory.',
      'MISSING_WORKSPACE_DIR',
    )
  }
  return fallback
}

export function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } }
}

function formatToolResult(value: unknown, extraContent: Array<Record<string, unknown>> = [], leadingText?: string) {
  const structured = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value }
  const textBody = leadingText
    ? `${leadingText}\n\n${JSON.stringify(value, null, 2)}`
    : JSON.stringify(value, null, 2)
  return {
    content: [
      { type: 'text', text: textBody },
      ...extraContent,
    ],
    structuredContent: structured,
  }
}

export interface GameStudioMcpServerOptions {
  defaultCwd?: string
  openaiModel?: string
  openaiBaseUrl?: string
  openaiCredential?: string
  imageProvider?: 'auto' | 'openai' | 'codex'
  codexPath?: string
  codexModel?: string
  codexReasoningEffort?: CodexEffort
  codexTimeoutMinutes?: number
  cloudflaredPath?: string
  ghPath?: string
  githubRepo?: string
  pagesTimeoutMs?: number
  wechatCliPath?: string
}

export class GameStudioMcpServer {
  private readonly defaultCwd: string
  private readonly options: GameStudioMcpServerOptions

  constructor(options: GameStudioMcpServerOptions = {}) {
    this.defaultCwd = options.defaultCwd ?? process.cwd()
    this.options = options
  }

  private apiKey(): string {
    const envName = this.options.openaiCredential ?? 'OPENAI_API_KEY'
    const val = process.env[envName]
    if (val && val.trim()) return val.trim()
    throw new StudioError(
      `No OpenAI key found in environment variable ${envName}. Set ${envName} or use provider: "codex" (local Codex CLI).`,
      'NO_KEY',
    )
  }

  private async chooseProvider(requested?: 'openai' | 'codex'): Promise<'openai' | 'codex'> {
    const wanted = requested ?? this.options.imageProvider ?? 'auto'
    if (wanted !== 'auto') return wanted
    try { this.apiKey(); return 'openai' } catch { /* fall through */ }
    try { await resolveCodex(this.options.codexPath); return 'codex' } catch { /* neither */ }
    throw new StudioError(
      'No image service is configured. Either set OPENAI_API_KEY or install & sign in to the `codex` CLI.',
      'NO_PROVIDER',
    )
  }

  private async codexBatch(count: number): Promise<CodexBatch> {
    const effort = this.options.codexReasoningEffort ?? 'low'
    if (!CODEX_EFFORTS.includes(effort)) {
      throw new StudioError(`codexReasoningEffort must be one of ${CODEX_EFFORTS.join(', ')}`, 'BAD_CONFIG')
    }
    return {
      command: await resolveCodex(this.options.codexPath),
      count,
      effort,
      ...(this.options.codexModel ? { model: this.options.codexModel } : {}),
      timeoutMs: Math.max(1, this.options.codexTimeoutMinutes ?? 15) * 60_000,
    }
  }

  private generator(signal: AbortSignal): ImageGenerator {
    const model = this.options.openaiModel ?? OPENAI_DEFAULT_MODEL
    return async request => {
      const response = await openaiGenerate({
        ...request,
        apiKey: this.apiKey(),
        baseUrl: this.options.openaiBaseUrl,
        model,
        signal,
      })
      return { ...response, provider: 'openai' }
    }
  }

  async doctor(): Promise<Record<string, unknown>> {
    let browserName: string | null = null
    let browserError: string | null = null
    try {
      const { browser, name } = await launchBrowser()
      browserName = name
      await browser.close().catch(() => {})
    } catch (err) {
      browserError = err instanceof Error ? err.message : String(err)
    }

    let codexBin: string | null = null
    try { codexBin = await resolveCodex(this.options.codexPath) } catch { codexBin = null }
    let hasOpenAi = false
    try { this.apiKey(); hasOpenAi = true } catch { hasOpenAi = false }

    const wechatCli = findWechatCli(this.options.wechatCliPath)
    return {
      server: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      toolCount: MCP_GAME_STUDIO_TOOLS.length,
      browser: browserName ? { ok: true, name: browserName } : { ok: false, error: browserError },
      imageProviders: { openaiKey: hasOpenAi, codexCli: codexBin },
      ghCli: findGh(this.options.ghPath) ?? null,
      cloudflared: findCloudflared(this.options.cloudflaredPath) ?? null,
      wechatCli,
    }
  }

  async executeTool(name: string, args: Record<string, unknown> = {}) {
    const controller = new AbortController()
    const cwd = resolveEffectiveWorkspaceDir({
      workspaceDir: args.workspaceDir,
      candidatePath: args.path,
      fallbackCwd: this.defaultCwd,
    })

    switch (name) {
      case 'game_studio_create': {
        const dir = resolveInside(cwd, String(args.path ?? ''))
        const template = (typeof args.template === 'string' ? args.template : 'collector') as TemplateId
        const orientation = typeof args.orientation === 'string' ? (args.orientation as Orientation) : undefined
        const manifest = await createProject(dir, {
          title: String(args.title ?? ''),
          style: typeof args.style === 'string' ? args.style : undefined,
          template,
          slots: parseSlots(args.slots),
          ...(orientation !== undefined ? { orientation } : {}),
        })
        const build = await buildProject(dir, `Created from the ${template} template`)
        await writeState(dir, build)
        const unnamed = await unnamedSlots(manifest)
        return formatToolResult({
          project: dir,
          title: manifest.title,
          orientation: manifest.orientation ?? 'portrait',
          slots: Object.fromEntries(Object.entries(manifest.slots).map(([slot, spec]) => [slot, spec.label])),
          rules: manifest.rules,
          build: { buildId: build.buildId, bytes: build.bytes, artifact: build.artifact },
          note: 'Playable now with bundled art. Read game.json and game.js before editing them, then call game_studio_build and game_studio_playtest.'
            + (unnamed.length > 0 ? ` ${namingHint(unnamed)}` : ''),
        })
      }

      case 'game_studio_build': {
        const dir = resolveInside(cwd, String(args.path ?? ''))
        const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : 'Rebuilt'
        const build = await buildProject(dir, note)
        await writeState(dir, build)
        const unnamed = await unnamedSlots(await loadManifest(dir))
        return formatToolResult({
          project: dir,
          buildId: build.buildId,
          bytes: build.bytes,
          artifact: build.artifact,
          ...(unnamed.length > 0 ? { note: namingHint(unnamed) } : {}),
        })
      }

      case 'game_studio_playtest': {
        const dir = resolveInside(cwd, String(args.path ?? ''))
        let rules: Record<string, unknown> | undefined
        if (args.rules !== undefined && String(args.rules).trim() !== '') {
          try { rules = typeof args.rules === 'string' ? JSON.parse(args.rules) : (args.rules as Record<string, unknown>) }
          catch { throw new StudioError('rules must be a JSON object, e.g. {"duration": 3}', 'BAD_RULES') }
          if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
            throw new StudioError('rules must be a JSON object, e.g. {"duration": 3}', 'BAD_RULES')
          }
        }
        const report = await playtest(dir, {
          ...(args.seconds !== undefined ? { seconds: Number(args.seconds) } : {}),
          ...(rules ? { rules } : {}),
          ...(typeof args.portrait === 'boolean' ? { portrait: args.portrait } : {}),
          ...(typeof args.platform === 'string' ? { platform: args.platform as PlaytestPlatform } : {}),
          ...(args.characters === true ? { charactersOnly: true } : {}),
          signal: controller.signal,
        })
        const summary = describePlaytest(report).replaceAll(`${dir}/`, '')
        const imageBlocks: Array<Record<string, unknown>> = []
        let budget = MAX_MCP_IMAGE_BUDGET_BYTES
        const order = ['characters', 'title', 'mid', 'end']
        const sortedShots = [...report.shots].sort((a, b) => {
          const ia = order.indexOf(a.name)
          const ib = order.indexOf(b.name)
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
        })
        for (const shot of sortedShots) {
          const data = await readFile(shot.file).catch(() => null)
          if (!data || data.byteLength > budget) continue
          budget -= data.byteLength
          imageBlocks.push({
            type: 'image',
            data: data.toString('base64'),
            mimeType: shot.mediaType,
          })
        }
        return formatToolResult(
          {
            project: dir,
            platform: report.platform,
            finalPhase: report.finalPhase,
            bestScore: report.bestScore,
            errors: report.errors,
            notes: report.notes,
            runDir: relative(dir, report.runDir),
            shots: report.shots.map(s => ({ name: s.name, file: s.file, mediaType: s.mediaType })),
          },
          imageBlocks,
          summary,
        )
      }

      case 'game_studio_generate_asset': {
        const dir = resolveInside(cwd, String(args.path ?? ''))
        const slot = String(args.slot ?? '')
        const prompt = String(args.prompt ?? '')
        const count = Math.min(4, Math.max(1, Math.trunc(Number(args.count ?? 2))))
        const provider = await this.chooseProvider(
          args.provider === 'openai' || args.provider === 'codex' ? args.provider : undefined,
        )
        const quality = provider === 'openai'
          ? (args.quality === 'low' || args.quality === 'medium' || args.quality === 'high' ? args.quality : 'medium')
          : 'auto'
        const generation = await prepareGeneration(dir, slot, prompt, quality)
        const reference = typeof args.reference === 'string' && args.reference.trim()
          ? await loadReference(cwd, args.reference.trim())
          : undefined

        if (provider === 'openai') {
          const { candidates, errors } = await generateCandidates(
            dir,
            slot,
            prompt,
            { count, quality, ...(reference ? { reference } : {}) },
            this.generator(controller.signal),
          )
          const cost = candidates.reduce((sum, item) => sum + (openaiCost(item.model, item.usage) ?? 0), 0)
          return formatToolResult({
            project: dir,
            slot,
            provider,
            count,
            candidates: candidates.map(candidateSummary),
            errors,
            costUsd: Math.round(cost * 10_000) / 10_000,
          })
        }

        const batch = { ...(await this.codexBatch(count)), ...(reference ? { reference } : {}) }
        const result = await runCodexBatch(dir, generation, batch, `codex-${shortId()}`, controller.signal)
        if (result.candidates.length === 0) {
          throw new StudioError(`Codex produced no image: ${result.errors[0] ?? 'unknown error'}`, 'PROVIDER')
        }
        return formatToolResult({
          project: dir,
          slot,
          provider,
          count,
          candidates: result.candidates.map(candidateSummary),
          errors: result.errors,
        })
      }

      case 'game_studio_apply_asset': {
        const dir = resolveInside(cwd, String(args.path ?? ''))
        const slot = String(args.slot ?? '')
        const { record, candidate, build } = await applyCandidate(dir, slot, String(args.candidate ?? ''))
        return formatToolResult({
          project: dir,
          slot,
          number: candidate.number,
          file: record.file,
          buildId: build.buildId,
          license: record.license,
        })
      }

      case 'game_studio_revert_asset': {
        const dir = resolveInside(cwd, String(args.path ?? ''))
        const slot = String(args.slot ?? '')
        const { restored, build } = await revertSlot(dir, slot)
        return formatToolResult({ project: dir, slot, restored, buildId: build.buildId })
      }

      case 'game_studio_list': {
        const scan = await listGames(cwd, controller.signal)
        return formatToolResult({
          cwd,
          games: scan.games.map(game => ({
            path: relative(cwd, game.project) || '.',
            title: game.title,
            dimension: game.dimension ?? 'unknown',
            built: game.built,
            versions: game.versions,
            updatedAt: game.updatedAt,
          })),
          ...(scan.partial ? { note: 'Workspace is large; only part of it was scanned.' } : {}),
        })
      }

      case 'game_studio_export_wall': {
        let projects: string[] | undefined
        if (typeof args.games === 'string' && args.games.trim() !== '') {
          let parsed: unknown
          try { parsed = JSON.parse(args.games) } catch { throw new StudioError('games must be a JSON array of folder paths', 'BAD_GAMES') }
          if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
            throw new StudioError('games must be a JSON array of folder paths', 'BAD_GAMES')
          }
          projects = parsed
        }
        const result = await exportWall({
          root: cwd,
          projects,
          name: typeof args.name === 'string' ? args.name : undefined,
          lang: args.lang === 'zh' || args.lang === 'en' ? (args.lang as WallLang) : undefined,
          signal: controller.signal,
        })
        return formatToolResult({ ...result, file: relative(cwd, result.file), absoluteFile: result.file })
      }

      case 'game_studio_export': {
        const dir = resolveInside(cwd, String(args.path ?? ''))
        const exported = await exportProjectHtml(dir, typeof args.name === 'string' ? args.name : undefined)
        return formatToolResult({ project: dir, ...exported })
      }

      case 'game_studio_export_wechat': {
        const dir = resolveInside(cwd, String(args.path ?? ''))
        const exported = await exportWechatProject(dir, {
          ...(typeof args.appid === 'string' && args.appid.trim() ? { appid: args.appid } : {}),
          ...(typeof args.shareTitle === 'string' && args.shareTitle.trim() ? { shareTitle: args.shareTitle } : {}),
          ...(typeof args.adUnitId === 'string' ? { adUnitId: args.adUnitId } : {}),
          signal: controller.signal,
        })
        return formatToolResult(exported)
      }

      case 'game_studio_upload_wechat': {
        const dir = resolveInside(cwd, String(args.path ?? ''))
        const uploaded = await uploadWechatProject(dir, {
          version: String(args.version ?? ''),
          ...(typeof args.desc === 'string' ? { desc: args.desc } : {}),
          ...(typeof args.appid === 'string' ? { appid: args.appid } : {}),
          ...(typeof args.confirmToken === 'string' ? { confirmToken: args.confirmToken } : {}),
          cliPath: this.options.wechatCliPath,
          signal: controller.signal,
        })
        return formatToolResult(uploaded)
      }

      case 'game_studio_versions': {
        const dir = resolveInside(cwd, String(args.path ?? ''))
        const versions = await listVersions(dir)
        return formatToolResult({
          project: dir,
          versions: versions.slice(0, 20).map(v => ({
            version: v.number,
            note: v.note,
            createdAt: v.createdAt,
            buildId: v.buildId,
          })),
        })
      }

      case 'game_studio_restore_version': {
        const dir = resolveInside(cwd, String(args.path ?? ''))
        const restored = await restoreProjectVersion(dir, Math.trunc(Number(args.version)))
        return formatToolResult({ project: dir, ...restored })
      }

      case 'game_studio_share': {
        const dir = resolveInside(cwd, String(args.path ?? ''))
        if (args.stop === true) {
          const stopped = stopShare(dir)
          await writeState(dir)
          return formatToolResult({ project: dir, stopped })
        }
        const minutes = Math.min(240, Math.max(1, Math.trunc(Number(args.minutes ?? 30))))
        const isPublic = args.public === true
        try {
          if (isPublic) requireCloudflared(this.options.cloudflaredPath)
          const shared = await shareProjectGame(dir, minutes, isPublic ? 'public' : 'lan', {
            cloudflaredPath: this.options.cloudflaredPath,
            signal: controller.signal,
          })
          return formatToolResult({ project: dir, ...shared })
        } catch (error) {
          if (error instanceof StudioError && error.code === 'NO_TUNNEL') {
            throw new StudioError(`${error.message} ${NO_TUNNEL_AGENT_HINT}`, 'NO_TUNNEL')
          }
          throw error
        }
      }

      case 'game_studio_publish': {
        const isWall = args.wall === true
        const isRemove = args.remove === true
        let projects: string[] | undefined
        if (isWall && typeof args.games === 'string' && args.games.trim() !== '') {
          let parsed: unknown
          try { parsed = JSON.parse(args.games) } catch { throw new StudioError('games must be a JSON array of folder paths', 'BAD_GAMES') }
          if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
            throw new StudioError('games must be a JSON array of folder paths', 'BAD_GAMES')
          }
          projects = parsed
        }
        const dir = isWall
          ? (typeof args.path === 'string' && args.path.trim() !== '' ? resolveInside(cwd, args.path) : undefined)
          : resolveInside(cwd, String(args.path ?? ''))
        try {
          const published = await publishProjectToPages({
            cwd,
            ...(dir ? { dir } : {}),
            wall: isWall,
            ...(projects ? { projects } : {}),
            remove: isRemove,
            ghPath: this.options.ghPath,
            githubRepo: this.options.githubRepo,
            pagesTimeoutMs: this.options.pagesTimeoutMs,
            signal: controller.signal,
          })
          return formatToolResult(published)
        } catch (error) {
          if (error instanceof StudioError && error.code === 'NO_GH') {
            throw new StudioError(`${error.message} ${NO_GH_AGENT_HINT}`, 'NO_GH')
          }
          if (error instanceof StudioError && error.code === 'GH_NOT_LOGGED_IN') {
            throw new StudioError(`${error.message} ${GH_AUTH_AGENT_HINT}`, 'GH_NOT_LOGGED_IN')
          }
          throw error
        }
      }

      default:
        throw new StudioError(`Unknown tool "${name}". Available: ${MCP_GAME_STUDIO_TOOLS.map(t => t.name).join(', ')}`, 'UNKNOWN_TOOL')
    }
  }

  async dispatch(message: unknown): Promise<Record<string, unknown> | null> {
    if (
      !message
      || typeof message !== 'object'
      || Array.isArray(message)
      || (message as Record<string, unknown>).jsonrpc !== '2.0'
      || typeof (message as Record<string, unknown>).method !== 'string'
    ) {
      return jsonRpcError(null, -32600, 'Expected a JSON-RPC 2.0 request or notification.')
    }

    const msg = message as {
      jsonrpc: '2.0'
      id?: string | number | null
      method: string
      params?: Record<string, unknown>
    }
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id')
    if (hasId && msg.id !== null && typeof msg.id !== 'string' && typeof msg.id !== 'number') {
      return jsonRpcError(null, -32600, 'Invalid JSON-RPC request id.')
    }
    const id = (msg.id ?? null) as string | number | null
    const reply = (result: unknown) => ({ jsonrpc: '2.0' as const, id, result })

    try {
      if (!hasId) return null

      switch (msg.method) {
        case 'initialize': {
          const requestedProtocol = typeof msg.params?.protocolVersion === 'string'
            ? msg.params.protocolVersion
            : '2025-06-18'
          return reply({
            protocolVersion: requestedProtocol,
            capabilities: {
              tools: { listChanged: true },
            },
            serverInfo: {
              name: MCP_SERVER_NAME,
              version: MCP_SERVER_VERSION,
            },
            instructions:
              'DSH Game Studio MCP server: create 2D Canvas and 3D Three.js WebGL games, run headless Chrome playtests '
              + '(with Web and WeChat Mini Game capsule simulation), generate transparent AI sprites via OpenAI or Codex CLI, '
              + 'export single-file HTML or < 4 MB WeChat Mini Game packages (`wx-minigame/`), upload WeChat experience builds, '
              + 'and publish permanent links to GitHub Pages. Always pass `workspaceDir` when calling tools from a plugin host.',
          })
        }

        case 'ping':
          return reply({})

        case 'tools/list':
          return reply({ tools: MCP_GAME_STUDIO_TOOLS })

        case 'resources/list':
          return reply({ resources: [] })

        case 'prompts/list':
          return reply({ prompts: [] })

        case 'tools/call': {
          const toolName = typeof msg.params?.name === 'string' ? msg.params.name.trim() : ''
          if (!toolName) {
            return jsonRpcError(id, -32602, 'Missing `params.name` in `tools/call`.')
          }
          const rawArgs = msg.params?.arguments
          const toolArgs = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {}
          const out = await this.executeTool(toolName, toolArgs)
          return reply(out)
        }

        default:
          return jsonRpcError(id, -32601, `Method not found: ${msg.method}`)
      }
    } catch (err) {
      if (!hasId) return null
      const messageText = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string })?.code
      if (msg.method === 'tools/call') {
        return reply({
          content: [{ type: 'text', text: messageText }],
          isError: true,
          ...(code ? { structuredContent: { error: messageText, code } } : {}),
        })
      }
      return jsonRpcError(id, -32000, messageText)
    }
  }

  async close(): Promise<void> {
    stopAllShares()
  }
}

async function writeLine(payload: Record<string, unknown> | null): Promise<void> {
  if (!payload) return
  if (!process.stdout.write(`${JSON.stringify(payload)}\n`)) {
    await once(process.stdout, 'drain')
  }
}

export async function runStdioMcpServer(options: GameStudioMcpServerOptions = {}): Promise<void> {
  const server = new GameStudioMcpServer(options)
  const shutdown = () => {
    process.stdin.destroy()
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let queue = Promise.resolve()

  try {
    for await (const chunk of process.stdin) {
      buffer += decoder.write(chunk as Buffer)
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
          throw new Error('MCP stdio input line exceeds the 32 MiB size limit.')
        }
        if (!line.trim()) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          await writeLine(jsonRpcError(null, -32700, 'Invalid JSON on MCP stdio stream.'))
          continue
        }
        queue = queue.then(async () => {
          const response = await server.dispatch(parsed)
          await writeLine(response)
        })
        await queue
      }
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        throw new Error('MCP stdio input buffer exceeds the 32 MiB size limit.')
      }
    }
    buffer += decoder.end()
    if (buffer.trim()) {
      await writeLine(jsonRpcError(null, -32700, 'MCP stdio messages must end with a newline.'))
    }
  } finally {
    process.off('SIGTERM', shutdown)
    process.off('SIGINT', shutdown)
    await server.close()
  }
}

function sameFile(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b) }
  catch { return resolve(a) === resolve(b) }
}

const isMain = Boolean(
  process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url)),
)

if (isMain) {
  const cliArgs = process.argv.slice(2)
  if (cliArgs.includes('--doctor')) {
    const server = new GameStudioMcpServer()
    server
      .doctor()
      .then(status => {
        process.stdout.write(`${JSON.stringify({ ok: true, status }, null, 2)}\n`)
        return server.close()
      })
      .catch(err => {
        process.stderr.write(`dsh-game-studio doctor failed: ${err instanceof Error ? err.message : String(err)}\n`)
        process.exitCode = 1
        return server.close()
      })
  } else {
    runStdioMcpServer().catch(err => {
      process.stderr.write(`dsh-game-studio mcp-server error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    })
  }
}
