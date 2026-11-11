/**
 * Browser half of dsh-game-studio: the right-sidebar "Game Studio" tab that
 * plays the built game in an isolated iframe and lets the user compare, apply
 * and revert generated art; plus compact chat rows for the studio tools that
 * open the tab when a call finishes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  AUTO_REFRESH_INTERVAL_MS, discoverAndFetchSource, loadFeedCache, loadStoredSources, MAX_SOURCES,
  mergeSources, onlineGameToShelfGame, parseWorkspaceSources, refreshSubscribedSource, saveFeedCache,
  saveStoredSources, shouldAutoRefresh, WORKSPACE_SOURCES_FILE, type SourceFetchState, type SubscribedSource,
} from './feed.ts'
import { commandErrorCopy, en, liveShare, NS, publishState, shareCopy, zh, type Key, type PublishedInfo, type ShareHeartbeat } from './locales.ts'
import {
  builtLocalGamesCount, dimensionCounts, localWallProjects, mergeShelfGames, scanShelf, viewGames,
  type Listing, type ShelfFilter, type ShelfGame, type ShelfSort,
} from './shelf.ts'

export { liveShare, publishState }

const ID = '@zseven-w/dsh-game-studio'
const KIND = 'game-studio'
const SHELF_ID = '@zseven-w/dsh-game-studio/shelf'
const SHELF_KIND = 'game-studio-shelf'
const ADDRESS_PREFIX = 'dsh-resource://game-studio/session/'
const TOOLS = ['game_studio_create', 'game_studio_build', 'game_studio_generate_asset', 'game_studio_apply_asset', 'game_studio_revert_asset', 'game_studio_export', 'game_studio_publish']

type T = (key: Key, params?: Record<string, string>) => string

export function studioAddress(sessionId: string, project: string): string {
  return `${ADDRESS_PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(project)}`
}

export function parseStudioAddress(address: string): { sessionId: string; project: string } | undefined {
  if (!address.startsWith(ADDRESS_PREFIX)) return undefined
  const [session, project, extra] = address.slice(ADDRESS_PREFIX.length).split('/')
  if (!session || !project || extra !== undefined) return undefined
  try { return { sessionId: decodeURIComponent(session), project: decodeURIComponent(project) } } catch { return undefined }
}

function baseName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path
}

function join(dir: string, file: string): string {
  return `${dir.replace(/[\\/]+$/u, '')}/${file}`
}

/** Tool rows tell open tabs to reload when a studio call finishes. */
const refreshBus = new EventTarget()
function announceRefresh(project: string): void {
  refreshBus.dispatchEvent(new CustomEvent('refresh', { detail: project }))
}

// ---------------------------------------------------------------- styles

const tok = {
  text: 'var(--dsw-alias-label-primary, inherit)',
  muted: 'var(--dsw-alias-label-secondary, #888)',
  border: 'var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
  layer: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))',
  active: 'var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.18))',
  danger: 'var(--dsw-alias-label-danger, #d33)',
}

const s: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: tok.text, fontSize: 13 },
  bar: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${tok.border}`, flexWrap: 'wrap' },
  title: { fontWeight: 600, marginRight: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  button: { font: 'inherit', fontSize: 12, padding: '3px 9px', borderRadius: 6, border: `1px solid ${tok.border}`, background: 'transparent', color: 'inherit', cursor: 'pointer' },
  stage: { position: 'relative', flex: '1 1 55%', minHeight: 200, background: '#000' },
  frame: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block' },
  hint: { padding: '6px 10px', color: tok.muted, fontSize: 12, borderBottom: `1px solid ${tok.border}` },
  error: { padding: '6px 10px', color: tok.danger, fontSize: 12, borderBottom: `1px solid ${tok.border}` },
  panel: { flex: '1 1 45%', overflow: 'auto', padding: '8px 10px', minHeight: 0 },
  slot: { borderTop: `1px solid ${tok.border}`, padding: '8px 0' },
  slotHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  thumbs: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  thumb: { width: 76, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'stretch' },
  img: { width: 76, height: 76, objectFit: 'contain', borderRadius: 8, border: `1px solid ${tok.border}`, background: `repeating-conic-gradient(${tok.layer} 0% 25%, transparent 0% 50%) 50% / 12px 12px` },
  small: { fontSize: 11, color: tok.muted },
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 },
  releasePanel: { borderBottom: `1px solid ${tok.border}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflow: 'auto' },
  releaseHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 },
  releaseStep: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '1px 0' },
  check: { width: 22, height: 22, flex: 'none', borderRadius: 6, border: `1px solid ${tok.border}`, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 },
  doneTitle: { color: tok.muted, textDecoration: 'line-through' },
  badge: { fontSize: 11, color: tok.muted, border: `1px solid ${tok.border}`, borderRadius: 999, padding: '1px 7px', flex: 'none' },
}

// ---------------------------------------------------------------- files

type ReadBytes = (sessionId: string, path: string, signal: AbortSignal) => Promise<{ data: Uint8Array }>
type RunCommand = (sessionId: string, input: string) => Promise<{ ok: boolean; text: string }>

interface StudioState {
  title: string
  orientation?: 'portrait' | 'landscape'
  build: { buildId: string; bytes: number; artifact: string } | null
  slots: Record<string, {
    label: string
    file: string
    transparent: boolean
    history: number
    record: { source: string; provider?: string; model?: string; prompt?: string } | null
    candidates: Array<{ id: string; number?: number; file: string; prompt: string; pass: boolean; problems: string[] }>
  }>
  spend?: { openaiImages: number; openaiUsd: number; codexImages: number; codexTokens: number }
  jobs?: JobRecord[]
  versions?: Array<{ number: number; note: string; createdAt: string; buildId: string }>
  share?: { url: string; qrSvg: string; expiresAt: string; scope?: 'lan' | 'public' } | null
}

function clock(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

interface JobRecord {
  id: string
  slot: string
  provider: string
  count: number
  done: number
  failed: number
  status: 'running' | 'completed' | 'failed' | 'killed' | 'interrupted'
  startedAt: string
  detail?: string
  recovered?: number
}

/** How often the tab re-reads the studio state while background generation runs, or otherwise checks share heartbeat. */
const POLL_MS = 3000
const SHARE_POLL_MS = 25_000

function elapsed(since: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function providerName(provider: string): string {
  return provider === 'codex' ? 'Codex' : provider === 'openai' ? 'OpenAI' : provider
}

function sourceLabel(record: StudioState['slots'][string]['record'], t: T): string {
  if (record === null) return ''
  if (record.source === 'generated') return `${providerName(record.provider ?? '')} · ${record.model ?? ''}`
  if (record.source === 'template') return t('tab.sourceTemplate')
  if (record.source === 'edited') return t('tab.sourceEdited')
  return record.source
}

function spendLine(spend: StudioState['spend'], t: T): string {
  if (spend === undefined || spend.openaiImages + spend.codexImages === 0) return ''
  const parts: string[] = []
  if (spend.openaiImages > 0) {
    parts.push(t('tab.spendOpenai', { count: String(spend.openaiImages), usd: spend.openaiUsd < 0.01 ? '<$0.01' : `$${spend.openaiUsd.toFixed(2)}` }))
  }
  if (spend.codexImages > 0) parts.push(t('tab.spendCodex', { count: String(spend.codexImages) }))
  return t('tab.spend', { parts: parts.join(' · ') })
}

function mimeOf(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}

/** Blob URL for one workspace file, revoked when the path or key changes or the view unmounts. */
function useFileUrl(readBytes: ReadBytes, sessionId: string, path: string | undefined, version: number | string, type?: string): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (path === undefined) { setUrl(undefined); return }
    const controller = new AbortController()
    let created: string | undefined
    readBytes(sessionId, path, controller.signal).then((file) => {
      if (controller.signal.aborted) return
      created = URL.createObjectURL(new Blob([file.data as BlobPart], { type: type ?? mimeOf(path) }))
      setUrl(created)
    }).catch(() => { if (!controller.signal.aborted) setUrl(undefined) })
    return () => { controller.abort(); if (created) URL.revokeObjectURL(created) }
  }, [readBytes, sessionId, path, version, type])
  return url
}

// ---------------------------------------------------------------- tab body

interface TabInjected { readBytes: ReadBytes; runCommand: RunCommand }

function Thumb({ readBytes, sessionId, path, version, children, title, src }: {
  readBytes: ReadBytes; sessionId: string; path: string; version: number; children?: ReactNode; title?: string
  /** An image to show instead of the file, e.g. the game's own render of a code-drawn character. */
  src?: string
}) {
  const fileUrl = useFileUrl(readBytes, sessionId, src === undefined ? path : undefined, version)
  const url = src ?? fileUrl
  return <div style={s.thumb} title={title}>
    {url ? <img src={url} alt="" style={s.img} /> : <div style={s.img} />}
    {children}
  </div>
}

interface ReleaseStepView {
  id: string
  title: string
  owner: 'wechat' | 'plugin' | 'user'
  status: 'todo' | 'done' | 'skipped'
  blocked: boolean
}

interface ReleaseView {
  progress: { done: number; total: number; percent: number }
  steps: ReleaseStepView[]
}

function StudioTab(props: any): ReactNode {  const { useTabInfo, t, readBytes, runCommand } = props as { useTabInfo: () => any; t: T } & TabInjected
  const { tab } = useTabInfo()
  const target = useMemo(() => parseStudioAddress(tab.contentId), [tab.contentId])
  if (target === undefined) throw new Error(`dsh-game-studio: not a studio address "${tab.contentId}"`)
  const { sessionId, project } = target
  const [version, setVersion] = useState(0)
  // State-only refreshes while background jobs run; they must not restart the game.
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<StudioState | null>()
  const [heartbeat, setHeartbeat] = useState<ShareHeartbeat | null>(null)
  const [published, setPublished] = useState<PublishedInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [openingPublic, setOpeningPublic] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'publish' | 'unpublish' | null>(null)
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string }>()
  const [game, setGame] = useState<{ phase: string; score: number }>()
  // Close-ups the running build drew of its code-drawn characters, by slot.
  const [renders, setRenders] = useState<Record<string, string>>({})
  const frame = useRef<HTMLIFrameElement>(null)

  const reload = useCallback(() => { setVersion(value => value + 1) }, [])

  useEffect(() => {
    const listener = (event: Event) => { if ((event as CustomEvent).detail === project) reload() }
    refreshBus.addEventListener('refresh', listener)
    return () => { refreshBus.removeEventListener('refresh', listener) }
  }, [project, reload])

  useEffect(() => {
    const controller = new AbortController()
    const decode = <V,>(res: PromiseSettledResult<{ data: Uint8Array }>): V | null => {
      if (res.status !== 'fulfilled') return null
      try { return JSON.parse(new TextDecoder().decode(res.value.data)) as V } catch { return null }
    }
    void Promise.allSettled([
      readBytes(sessionId, join(project, '.studio/state.json'), controller.signal),
      readBytes(sessionId, join(project, '.studio/share-alive.json'), controller.signal),
      readBytes(sessionId, join(project, '.studio/published.json'), controller.signal),
    ]).then(([stateRes, beatRes, pubRes]) => {
      if (controller.signal.aborted) return
      setState(decode<StudioState>(stateRes))
      setHeartbeat(decode<ShareHeartbeat>(beatRes))
      setPublished(decode<PublishedInfo>(pubRes))
    })
    return () => { controller.abort() }
  }, [readBytes, sessionId, project, version, tick])

  const running = state?.jobs?.some(job => job.status === 'running') ?? false
  useEffect(() => {
    const timer = setInterval(() => { setTick(value => value + 1) }, running ? POLL_MS : SHARE_POLL_MS)
    return () => { clearInterval(timer) }
  }, [running])

  // The game reloads on an explicit reload or a new build, not on every state poll.
  const gameUrl = useFileUrl(readBytes, sessionId, state?.build ? join(project, 'dist/index.html') : undefined,
    `${version}:${state?.build?.buildId ?? ''}`, 'text/html')
  // A reloaded build starts on its title screen; drop the previous run's phase.
  useEffect(() => { setGame(undefined); setRenders({}) }, [gameUrl])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const data = event.data as { source?: unknown; type?: unknown; phase?: unknown; score?: unknown; message?: unknown }
      if (data?.source !== 'dsh-game-studio') return
      if (data.type === 'state' && typeof data.phase === 'string') setGame({ phase: data.phase, score: Number(data.score) || 0 })
      if (data.type === 'error' && typeof data.message === 'string') setNotice({ kind: 'error', text: t('tab.gameError', { message: data.message.slice(0, 300) }) })
      if (data.type === 'renders' && (data as { renders?: unknown }).renders && typeof (data as { renders?: unknown }).renders === 'object') {
        // Only small PNG data URLs are accepted from the sandboxed game.
        const accepted: Record<string, string> = {}
        for (const [slot, value] of Object.entries((data as { renders: Record<string, unknown> }).renders)) {
          if (typeof value === 'string' && value.startsWith('data:image/png;base64,') && value.length < 2_000_000) accepted[slot] = value
        }
        setRenders(accepted)
      }
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [t])

  const run = useCallback(async (action: string, payload: Record<string, unknown>) => {
    setBusy(true)
    if (action === 'share' && payload.scope === 'public') setOpeningPublic(true)
    if (action === 'publish' || action === 'unpublish') setPublishing(true)
    setNotice(undefined)
    try {
      const result = await runCommand(sessionId, `${action} ${JSON.stringify({ project, ...payload })}`)
      if (!result.ok) { setNotice({ kind: 'error', text: commandErrorCopy(result.text, t) }); return }
      if (action === 'export') {
        const file = (JSON.parse(result.text) as { file?: string }).file ?? ''
        setNotice({ kind: 'info', text: t('tab.exported', { file }) })
      }
      if (action === 'export-wechat') {
        const dir = (JSON.parse(result.text) as { dir?: string }).dir ?? ''
        setNotice({ kind: 'info', text: t('tab.exportedWechat', { dir }) })
      }
      reload()
    } finally {
      setOpeningPublic(false)
      setPublishing(false)
      setBusy(false)
    }
  }, [runCommand, sessionId, project, reload, t])

  // ---- WeChat launch wizard -------------------------------------------------
  const [release, setRelease] = useState<ReleaseView | null>(null)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [releaseBusy, setReleaseBusy] = useState(false)

  const loadRelease = useCallback(async () => {
    setReleaseBusy(true)
    try {
      const result = await runCommand(sessionId, `wechat-release ${JSON.stringify({ project, op: 'status' })}`)
      if (!result.ok) { setNotice({ kind: 'error', text: commandErrorCopy(result.text, t) }); return }
      setRelease(JSON.parse(result.text) as ReleaseView)
    } catch (error) {
      setNotice({ kind: 'error', text: String((error as Error)?.message ?? error) })
    } finally {
      setReleaseBusy(false)
    }
  }, [runCommand, sessionId, project, t])

  const toggleReleaseStep = useCallback(async (step: ReleaseStepView) => {
    setReleaseBusy(true)
    try {
      const status = step.status === 'done' ? 'todo' : 'done'
      const result = await runCommand(sessionId, `wechat-release ${JSON.stringify({ project, op: 'update', step: step.id, status })}`)
      if (!result.ok) { setNotice({ kind: 'error', text: commandErrorCopy(result.text, t) }); return }
      setRelease(JSON.parse(result.text) as ReleaseView)
    } finally {
      setReleaseBusy(false)
    }
  }, [runCommand, sessionId, project, t])

  const writeReleaseMaterials = useCallback(async () => {
    setReleaseBusy(true)
    try {
      const result = await runCommand(sessionId, `wechat-release ${JSON.stringify({ project, op: 'materials' })}`)
      if (!result.ok) { setNotice({ kind: 'error', text: commandErrorCopy(result.text, t) }); return }
      const file = (JSON.parse(result.text) as { file?: string }).file ?? ''
      setNotice({ kind: 'info', text: t('tab.releaseMaterialsSaved', { file }) })
    } finally {
      setReleaseBusy(false)
    }
  }, [runCommand, sessionId, project, t])

  const writeReviewGuide = useCallback(async () => {
    setReleaseBusy(true)
    try {
      const result = await runCommand(sessionId, `wechat-release ${JSON.stringify({ project, op: 'review' })}`)
      if (!result.ok) { setNotice({ kind: 'error', text: commandErrorCopy(result.text, t) }); return }
      const parsed = JSON.parse(result.text) as { file?: string; risks?: unknown[] }
      setNotice({ kind: 'info', text: t('tab.releaseReviewSaved', { file: parsed.file ?? '', count: String(parsed.risks?.length ?? 0) }) })
    } finally {
      setReleaseBusy(false)
    }
  }, [runCommand, sessionId, project, t])

  const openDevtools = useCallback(async () => {
    setReleaseBusy(true)
    try {
      const result = await runCommand(sessionId, `wechat-devtools ${JSON.stringify({ project, op: 'open' })}`)
      if (!result.ok) { setNotice({ kind: 'error', text: commandErrorCopy(result.text, t) }); return }
      setNotice({ kind: 'info', text: t('tab.releaseDevtoolsOpened') })
      await loadRelease()
    } finally {
      setReleaseBusy(false)
    }
  }, [runCommand, sessionId, project, t, loadRelease])

  const toggleRelease = useCallback(() => {
    const next = !releaseOpen
    setReleaseOpen(next)
    if (next && release === null) void loadRelease()
  }, [releaseOpen, release, loadRelease])

  const ownerLabel = (owner: ReleaseStepView['owner']): string => owner === 'wechat'
    ? t('tab.releaseOwner.wechat')
    : owner === 'plugin' ? t('tab.releaseOwner.plugin') : t('tab.releaseOwner.user')

  const title = state?.title ?? baseName(project)
  const activeShare = liveShare(state?.share, heartbeat)
  const activeShareCopy = activeShare ? shareCopy(activeShare, t, clock(activeShare.expiresAt)) : undefined
  const pubInfo = publishState(published, state?.build?.buildId, t)
  const lang = t('tab.reload') === '重新载入' ? 'zh' : 'en'
  return <div style={s.root} data-plugin="dsh-game-studio">
    <div style={s.bar}>
      <span style={s.title} title={project}>{title}</span>
      {state?.build && <span style={s.small}>{t('tab.build', { id: state.build.buildId, size: `${Math.round(state.build.bytes / 1024)} KB` })}</span>}
      <button type="button" style={s.button} onClick={reload} disabled={busy}>{t('tab.reload')}</button>
      <button type="button" style={s.button} onClick={() => { void run('build', {}) }} disabled={busy}>{t('tab.rebuild')}</button>
      <button type="button" style={s.button} onClick={() => { void run('export', {}) }} disabled={busy}>{t('tab.export')}</button>
      <button type="button" style={s.button} onClick={() => { void run('export-wechat', {}) }} disabled={busy}>{t('tab.exportWechat')}</button>
      <button type="button" style={s.button} onClick={toggleRelease} disabled={busy}>{t('tab.release')}</button>
      <button type="button" style={s.button} onClick={() => { void run('share', { minutes: '30' }) }} disabled={busy}>{t('tab.share')}</button>
      <button type="button" style={s.button} onClick={() => { void run('share', { minutes: '30', scope: 'public' }) }} disabled={busy}>
        {openingPublic ? t('tab.shareOpening') : t('tab.sharePublic')}
      </button>
      <button type="button" style={s.button} onClick={() => { setConfirmAction(v => v === 'publish' ? null : 'publish') }} disabled={busy}>
        {publishing ? t('tab.publishing') : pubInfo.buttonLabel}
      </button>
    </div>
    {releaseOpen && <div style={s.releasePanel}>
      <div style={s.releaseHead}>
        <strong>{t('tab.release')}</strong>
        {release && <span style={s.small}>{t('tab.releaseProgress', {
          done: String(release.progress.done), total: String(release.progress.total), percent: String(release.progress.percent),
        })}</span>}
        <button type="button" style={s.button} disabled={releaseBusy} onClick={() => { void loadRelease() }}>{t('tab.reload')}</button>
        <button type="button" style={s.button} disabled={releaseBusy} onClick={() => { void writeReleaseMaterials() }}>{t('tab.releaseMaterials')}</button>
        <button type="button" style={s.button} disabled={releaseBusy} onClick={() => { void writeReviewGuide() }}>{t('tab.releaseReview')}</button>
        <button type="button" style={s.button} disabled={releaseBusy} onClick={() => { void openDevtools() }}>{t('tab.releaseDevtools')}</button>
      </div>
      {(release?.steps ?? []).filter(step => step.status !== 'skipped').map(step => <div key={step.id} style={s.releaseStep}>
        <button type="button" style={s.check} disabled={releaseBusy || step.blocked}
          title={step.blocked ? t('tab.releaseBlocked') : step.title}
          onClick={() => { void toggleReleaseStep(step) }}>{step.status === 'done' ? '✓' : step.blocked ? '·' : '○'}</button>
        <span style={step.status === 'done'
          ? { ...s.small, ...s.doneTitle, flex: 1, minWidth: 0 }
          : { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.title}</span>
        <span style={s.badge}>{ownerLabel(step.owner)}</span>
      </div>)}
    </div>}
    {confirmAction === 'publish' && <div style={{ ...s.hint, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ color: tok.text }}>{t('tab.publishConfirmHint')}</span>
      <button type="button" style={s.button} disabled={busy} onClick={() => { setConfirmAction(null); void run('publish', { lang }) }}>{t('tab.publishConfirmYes')}</button>
      <button type="button" style={s.button} disabled={busy} onClick={() => { setConfirmAction(null) }}>{t('tab.publishCancel')}</button>
    </div>}
    {published && <div style={{ ...s.hint, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: tok.text }}>{pubInfo.hint}</span>
        {pubInfo.outdatedHint && <span style={{ color: tok.muted }}>· {pubInfo.outdatedHint}</span>}
      </div>
      <code style={{ fontSize: 11, wordBreak: 'break-all', userSelect: 'text' }}>{published.url}</code>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" style={s.button}
          onClick={() => { void navigator.clipboard?.writeText(published.url).catch(() => undefined) }}>{t('tab.shareCopy')}</button>
        <button type="button" style={s.button} disabled={busy}
          onClick={() => { setConfirmAction(v => v === 'unpublish' ? null : 'unpublish') }}>{t('tab.unpublish')}</button>
      </div>
      {confirmAction === 'unpublish' && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
        <span style={{ color: tok.text }}>{t('tab.unpublishConfirmHint')}</span>
        <button type="button" style={s.button} disabled={busy}
          onClick={() => { setConfirmAction(null); void run('publish', { remove: true, lang }) }}>{t('tab.unpublishConfirmYes')}</button>
        <button type="button" style={s.button} disabled={busy} onClick={() => { setConfirmAction(null) }}>{t('tab.publishCancel')}</button>
      </div>}
    </div>}
    {activeShare && activeShareCopy && <div style={{ ...s.hint, display: 'flex', gap: 10, alignItems: 'center' }}>
      <img alt="" style={{ width: 112, height: 112, background: '#fff', borderRadius: 6, padding: 4, flex: 'none' }}
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(activeShare.qrSvg)}`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <span style={{ color: tok.text }}>{activeShareCopy.hint}</span>
        <code style={{ fontSize: 11, wordBreak: 'break-all', userSelect: 'text' }}>{activeShare.url}</code>
        {activeShareCopy.until && <span>{activeShareCopy.until}</span>}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {activeShareCopy.isPublic && <button type="button" style={s.button}
            onClick={() => { void navigator.clipboard?.writeText(activeShare.url).catch(() => undefined) }}>{t('tab.shareCopy')}</button>}
          <button type="button" style={s.button} disabled={busy} onClick={() => { void run('unshare', {}) }}>{t('tab.unshare')}</button>
        </div>
      </div>
    </div>}
    {notice && <div style={notice.kind === 'error' ? s.error : s.hint}>{notice.text}</div>}
    {state === undefined ? <div style={s.hint}>{t('tab.loading')}</div>
      : state === null || state.build === null ? <div style={s.hint}>{t('tab.noBuild')}</div>
        : <>
          <div style={s.hint}>{game ? t('tab.phase', { phase: game.phase, score: String(game.score) }) : t('tab.clickToPlay')}</div>
          {/* A landscape game gets a wide stage instead of a tall strip it would letterbox into. */}
          <div style={state.orientation === 'landscape' ? { ...s.stage, flex: 'none', aspectRatio: '16 / 9', minHeight: 0 } : s.stage}>
            {gameUrl && <iframe key={gameUrl} ref={frame} src={gameUrl} title={title} style={s.frame}
              sandbox="allow-scripts" allow="fullscreen" referrerPolicy="no-referrer" />}
          </div>
        </>}
    {state && <div style={s.panel}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('tab.assets')}{busy ? ` · ${t('tab.busy')}` : ''}</div>
      {spendLine(state.spend, t) && <div style={{ ...s.small, marginBottom: 4 }}>{spendLine(state.spend, t)}</div>}
      {Object.entries(state.slots).map(([slot, info]) => <div key={slot} style={s.slot}>
        <div style={s.slotHead}>
          <strong>{info.label}</strong>
          <span style={s.small}>{sourceLabel(info.record, t)}</span>
          {info.history > 0 && <button type="button" style={{ ...s.button, marginLeft: 'auto' }} disabled={busy}
            onClick={() => { void run('revert', { slot }) }}>{t('tab.revert')}</button>}
        </div>
        {(state.jobs ?? []).filter(job => job.slot === slot).slice(0, 1).map(job => <JobLine key={job.id} job={job} t={t} />)}
        <div style={s.thumbs}>
          {/* A template slot whose character the game draws in code: show what the game draws, not the template's icon file. */}
          <Thumb readBytes={readBytes} sessionId={sessionId} path={join(project, info.file)} version={version} title={info.record?.prompt}
            {...(info.record?.source === 'template' && renders[slot] ? { src: renders[slot] } : {})}>
            <span style={s.small}>{info.record?.source === 'template'
              ? (renders[slot] ? t('tab.currentRendered') : t('tab.currentTemplate'))
              : t('tab.current')}</span>
          </Thumb>
          {info.candidates.length === 0 && <span style={{ ...s.small, alignSelf: 'center' }}>{t('tab.noCandidates', { slot: info.label })}</span>}
          {info.candidates.map(candidate => <Thumb key={candidate.id} readBytes={readBytes} sessionId={sessionId}
            path={candidate.file} version={0} title={candidate.pass ? candidate.prompt : t('tab.failed', { problems: candidate.problems.join('; ') })}>
            {candidate.number !== undefined && <span style={{ ...s.small, textAlign: 'center' }}>#{candidate.number}</span>}
            <button type="button" style={s.button} disabled={busy || !candidate.pass}
              onClick={() => { void run('apply', { slot, candidate: candidate.id }) }}>{t('tab.apply')}</button>
          </Thumb>)}
        </div>
      </div>)}
      {(state.versions ?? []).length > 0 && <div style={s.slot}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('tab.versions')}</div>
        {(state.versions ?? []).map((version, index) => <div key={version.number} style={{ ...s.row, padding: '2px 0' }}>
          <span style={{ ...s.small, minWidth: 34 }}>v{version.number}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={version.note}>{version.note}</span>
          <span style={s.small}>{clock(version.createdAt)}</span>
          {index === 0
            ? <span style={{ ...s.small, minWidth: 64, textAlign: 'center' }}>{t('tab.current')}</span>
            : <button type="button" style={{ ...s.button, minWidth: 64 }} disabled={busy}
              onClick={() => { void run('restore', { version: String(version.number) }) }}>{t('tab.restore')}</button>}
        </div>)}
      </div>}
    </div>}
  </div>
}

function JobLine({ job, t }: { job: JobRecord; t: T }): ReactNode {
  const provider = providerName(job.provider)
  const detail = (job.detail ?? '').slice(0, 200)
  if (job.status === 'running') {
    return <div style={{ ...s.small, marginBottom: 6 }}>{t('tab.jobRunning', { provider, done: String(job.done), count: String(job.count), elapsed: elapsed(job.startedAt) })}</div>
  }
  if (job.status === 'interrupted' && (job.recovered ?? 0) > 0) {
    return <div style={{ ...s.small, marginBottom: 6 }}>{t(job.done < job.count ? 'tab.jobRecoveredPartial' : 'tab.jobRecovered', { provider, done: String(job.done), count: String(job.count) })}</div>
  }
  if (job.status === 'interrupted') return <div style={{ ...s.small, marginBottom: 6 }}>{t('tab.jobInterrupted', { provider })}</div>
  if (job.failed === 0) return null
  const key = job.done > 0 ? 'tab.jobPartial' : 'tab.jobFailed'
  return <div style={{ ...s.small, color: tok.danger, marginBottom: 6 }}>{t(key, { provider, failed: String(job.failed), detail })}</div>
}

// ---------------------------------------------------------------- shelf ("My games")

type ListDir = (sessionId: string, path: string, signal: AbortSignal) => Promise<Listing>
interface ShelfInjected { shelfSession: string; readBytes: ReadBytes; listDir: ListDir; runCommand: RunCommand }

const shelfStyle: Record<string, CSSProperties> = {
  // Scrolling lives on this wrapper: a height-capped grid would squeeze its rows below the tiles' aspect-ratio height.
  scroll: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gridAutoRows: 'max-content', gap: 8, padding: 10 },
  tile: { position: 'relative', display: 'block', width: '100%', aspectRatio: '4 / 3', padding: 0, border: 0, borderRadius: 10, overflow: 'hidden', cursor: 'pointer', font: 'inherit', textAlign: 'left', color: '#fff', background: '#1d1f24' },
  // Character art (no playtest yet) sits whole on a soft backdrop above the caption.
  art: { position: 'absolute', inset: '8% 12% 30%', width: '76%', height: '62%', objectFit: 'contain' },
  artBackdrop: { position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 40%, #3a3f4b 0%, #1d1f24 75%)' },
  shot: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' },
  caption: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: '28px 10px 8px', background: 'linear-gradient(to top, rgba(0,0,0,.82) 0%, rgba(0,0,0,.55) 55%, rgba(0,0,0,0) 100%)', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  badge: { position: 'absolute', top: 8, left: 8, maxWidth: 'calc(100% - 16px)', padding: '2px 7px', borderRadius: 999, background: 'rgba(17,19,23,.78)', color: '#fff', fontSize: 11, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  name: { fontWeight: 600, fontSize: 14, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 2px rgba(0,0,0,.5)' },
  meta: { fontSize: 11, lineHeight: 1.3, color: 'rgba(255,255,255,.72)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  controls: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px 0', flexWrap: 'wrap' },
  chip: { font: 'inherit', fontSize: 12, padding: '3px 11px', borderRadius: 999, border: 0, cursor: 'pointer' },
  sort: { font: 'inherit', fontSize: 12, padding: '2px 4px', border: 0, background: 'transparent', cursor: 'pointer' },
  sourcesPanel: { padding: '8px 10px', borderBottom: `1px solid ${tok.border}`, display: 'flex', flexDirection: 'column', gap: 6 },
  sourceInput: { flex: 1, minWidth: 160, font: 'inherit', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: `1px solid ${tok.border}`, background: 'transparent', color: 'inherit' },
}

/** Hover and focus feedback the inline styles cannot express. */
const SHELF_CSS = `
[data-view="shelf"] .dgs-tile img { transition: transform .25s ease; }
[data-view="shelf"] .dgs-tile:hover img, [data-view="shelf"] .dgs-tile:focus-visible img { transform: scale(1.05); }
[data-view="shelf"] .dgs-tile:focus-visible { outline: 2px solid var(--dsw-alias-interactive-border-focus, #4c8bf5); outline-offset: 2px; }
[data-view="shelf"] .dgs-chip { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, inherit); }
[data-view="shelf"] .dgs-chip[aria-pressed="true"] { background: var(--dsw-alias-label-primary, #222); color: var(--dsw-alias-bg-base, #fff); font-weight: 600; }
[data-view="shelf"] .dgs-sort { color: var(--dsw-alias-label-secondary, #888); }
[data-view="shelf"] .dgs-sort[aria-pressed="true"] { color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
`

function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function ShelfCard({ game, sessionId, readBytes, t, open }: { game: ShelfGame; sessionId: string; readBytes: ReadBytes; t: T; open: (game: ShelfGame) => void }) {
  const fileUrl = useFileUrl(readBytes, sessionId, game.online ? undefined : game.cover, game.updatedAt)
  const url = game.online ? game.cover : fileUrl
  // Playtest pictures fill the tile; a character picture is shown whole.
  const screenshot = game.cover !== undefined && /\.jpe?g(\?|$)/iu.test(game.cover)
  const meta = [game.dimension === '3d' ? '3D' : game.dimension === '2d' ? '2D' : '',
    game.built ? '' : t('shelf.notBuilt'),
    game.versions > 0 ? t('shelf.versions', { count: String(game.versions) }) : '',
    when(game.updatedAt)].filter(Boolean).join(' · ')
  return <button type="button" className="dgs-tile" style={shelfStyle.tile} onClick={() => { open(game) }} title={t('shelf.play', { title: game.title })} aria-label={t('shelf.play', { title: game.title })} data-project={game.project}>
    {!screenshot && <div style={shelfStyle.artBackdrop} />}
    {url && <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" style={screenshot ? shelfStyle.shot : shelfStyle.art} />}
    {game.online && <span style={shelfStyle.badge}>{t('shelf.onlineBadge', { source: game.online.sourceName })}</span>}
    <div style={shelfStyle.caption}>
      <span style={shelfStyle.name}>{game.title}</span>
      <span style={shelfStyle.meta}>{meta}</span>
    </div>
  </button>
}

function ShelfTab(props: any): ReactNode {
  const { useTabInfo, t, shelfSession, readBytes, listDir, runCommand, useSessions } = props as { useTabInfo: () => any; t: T; useSessions?: (select: (sessions: any) => unknown) => unknown } & ShelfInjected
  const { tab } = useTabInfo()
  const sessionId: string = shelfSession || props.sessionId
  const cwd = (useSessions ? useSessions(sessions => sessions?.byId?.[sessionId]?.cwd) : undefined) as string | undefined
  const [version, setVersion] = useState(0)
  const [scan, setScan] = useState<{ games: ShelfGame[]; partial: boolean }>()
  const visible = tab?.visible !== false
  const [filter, setFilter] = useState<ShelfFilter>('all')
  const [onlineOnly, setOnlineOnly] = useState(false)
  const [sort, setSort] = useState<ShelfSort>('recent')
  const [busy, setBusy] = useState(false)
  const [exportingWall, setExportingWall] = useState(false)
  const [publishingWall, setPublishingWall] = useState(false)
  const [confirmPublishWall, setConfirmPublishWall] = useState(false)
  const [wallPublished, setWallPublished] = useState<{ url: string; status?: string } | null>(null)
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string }>()

  const [showSources, setShowSources] = useState(false)
  const [sourceInput, setSourceInput] = useState('')
  const [addingSource, setAddingSource] = useState(false)
  const [localSources, setLocalSources] = useState<SubscribedSource[]>(() => loadStoredSources())
  const [workspaceSources, setWorkspaceSources] = useState<SubscribedSource[]>([])
  const [feedStates, setFeedStates] = useState<Record<string, SourceFetchState>>(() => loadFeedCache())
  const [loadingSourceIds, setLoadingSourceIds] = useState<Record<string, boolean>>({})
  const [playingOnline, setPlayingOnline] = useState<ShelfGame | null>(null)
  const lastRefreshRef = useRef<number | undefined>(undefined)

  const sources = useMemo(() => mergeSources(localSources, workspaceSources), [localSources, workspaceSources])

  // Unmount the online game iframe immediately when the tab becomes hidden.
  useEffect(() => {
    if (!visible) setPlayingOnline(null)
  }, [visible])

  useEffect(() => {
    const listener = () => { setVersion(value => value + 1) }
    refreshBus.addEventListener('refresh', listener)
    return () => { refreshBus.removeEventListener('refresh', listener) }
  }, [])

  useEffect(() => {
    if (!sessionId || !cwd || !visible) return
    const controller = new AbortController()
    const read = async (path: string, signal: AbortSignal) => new TextDecoder().decode((await readBytes(sessionId, path, signal)).data)
    scanShelf((path, signal) => listDir(sessionId, path, signal), read, cwd, controller.signal)
      .then(result => { if (!controller.signal.aborted) setScan(result) })
      .catch(() => { if (!controller.signal.aborted) setScan({ games: [], partial: true }) })
    read(join(cwd, WORKSPACE_SOURCES_FILE), controller.signal)
      .then(text => { if (!controller.signal.aborted) setWorkspaceSources(parseWorkspaceSources(text)) })
      .catch(() => { if (!controller.signal.aborted) setWorkspaceSources([]) })
    return () => { controller.abort() }
  }, [sessionId, cwd, visible, version, readBytes, listDir])

  const refreshFeeds = useCallback(async (targetSources: SubscribedSource[]) => {
    if (targetSources.length === 0) return
    lastRefreshRef.current = Date.now()
    const loadingFlags: Record<string, boolean> = {}
    for (const s of targetSources) loadingFlags[s.id] = true
    setLoadingSourceIds(prev => ({ ...prev, ...loadingFlags }))
    const results = await Promise.all(targetSources.map(source => refreshSubscribedSource(source, feedStates[source.id])))
    setFeedStates((prev) => {
      const next = { ...prev }
      for (const res of results) next[res.sourceId] = res
      saveFeedCache(next)
      return next
    })
    setLoadingSourceIds((prev) => {
      const next = { ...prev }
      for (const s of targetSources) delete next[s.id]
      return next
    })
  }, [feedStates])

  // Auto-refresh on wall open (with 2-minute cooldown) and every 30 minutes while open.
  useEffect(() => {
    if (!visible || sources.length === 0) return
    if (shouldAutoRefresh(lastRefreshRef.current)) {
      void refreshFeeds(sources)
    }
    const timer = setInterval(() => {
      void refreshFeeds(sources)
    }, AUTO_REFRESH_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [visible, sources, refreshFeeds])

  const addSource = useCallback(async () => {
    const raw = sourceInput.trim()
    if (!raw) return
    if (sources.length >= MAX_SOURCES) {
      setNotice({ kind: 'error', text: `Maximum of ${MAX_SOURCES} sources reached.` })
      return
    }
    setAddingSource(true)
    setNotice(undefined)
    try {
      const { source, feed } = await discoverAndFetchSource(raw)
      setLocalSources((prev) => {
        const filtered = prev.filter(item => item.id !== source.id)
        const next = [source, ...filtered].slice(0, MAX_SOURCES)
        saveStoredSources(next)
        return next
      })
      const now = new Date().toISOString()
      setFeedStates((prev) => {
        const next: Record<string, SourceFetchState> = {
          ...prev,
          [source.id]: {
            sourceId: source.id,
            name: feed.name,
            ...(feed.author ? { author: feed.author } : {}),
            updatedAt: feed.updatedAt,
            fetchedAt: now,
            games: feed.games,
            droppedCrossOrigin: feed.droppedCrossOrigin,
            status: 'ok',
          },
        }
        saveFeedCache(next)
        return next
      })
      setSourceInput('')
      setNotice({ kind: 'info', text: t('shelf.sourceAdded', { name: feed.name, count: String(feed.games.length) }) })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setAddingSource(false)
    }
  }, [sourceInput, sources.length, t])

  const removeSource = useCallback((sourceId: string) => {
    setLocalSources((prev) => {
      const next = prev.filter(item => item.id !== sourceId)
      saveStoredSources(next)
      return next
    })
    setFeedStates((prev) => {
      const next = { ...prev }
      delete next[sourceId]
      saveFeedCache(next)
      return next
    })
  }, [])

  const onlineShelfGames = useMemo(() => {
    const out: ShelfGame[] = []
    for (const source of sources) {
      const state = feedStates[source.id]
      if (!state) continue
      for (const game of state.games) {
        out.push(onlineGameToShelfGame(game))
      }
    }
    return out
  }, [sources, feedStates])

  const allGames = useMemo(() => mergeShelfGames(scan?.games ?? [], onlineShelfGames), [scan, onlineShelfGames])
  const shown = useMemo(() => viewGames(allGames, filter, sort, onlineOnly), [allGames, filter, sort, onlineOnly])
  const counts = useMemo(() => dimensionCounts(allGames, onlineOnly), [allGames, onlineOnly])
  const localProjects = useMemo(() => localWallProjects(shown), [shown])
  const builtLocalCount = useMemo(() => builtLocalGamesCount(shown), [shown])

  const open = useCallback((game: ShelfGame) => {
    if (game.online) {
      setPlayingOnline(game)
      return
    }
    tab.actions.openResource(studioAddress(sessionId, game.project))
  }, [tab, sessionId])

  const exportWall = useCallback(async () => {
    setBusy(true)
    setExportingWall(true)
    setNotice(undefined)
    try {
      // The page is written in the language the sidebar is shown in.
      const lang = t('shelf.refresh') === '刷新' ? 'zh' : 'en'
      const result = await runCommand(sessionId, `wall ${JSON.stringify({ projects: localProjects, lang })}`)
      if (!result.ok) { setNotice({ kind: 'error', text: t('shelf.exportFailed', { message: result.text }) }); return }
      const wall = JSON.parse(result.text) as { file: string; bytes: number; games: number; skipped: unknown[] }
      const text = t('shelf.exported', { file: wall.file, count: String(wall.games), size: `${(wall.bytes / 1048576).toFixed(1)} MB` })
      setNotice({ kind: 'info', text: wall.skipped.length > 0 ? `${text} ${t('shelf.exportSkipped', { count: String(wall.skipped.length) })}` : text })
    } finally {
      setExportingWall(false)
      setBusy(false)
    }
  }, [runCommand, sessionId, localProjects, t])

  const publishWall = useCallback(async () => {
    setBusy(true)
    setPublishingWall(true)
    setNotice(undefined)
    try {
      const lang = t('shelf.refresh') === '刷新' ? 'zh' : 'en'
      const result = await runCommand(sessionId, `publish ${JSON.stringify({ wall: true, projects: localProjects, lang })}`)
      if (!result.ok) { setNotice({ kind: 'error', text: commandErrorCopy(result.text, t) }); return }
      const published = JSON.parse(result.text) as { url: string; status?: string }
      setWallPublished(published)
    } finally {
      setPublishingWall(false)
      setBusy(false)
    }
  }, [runCommand, sessionId, localProjects, t])

  const chip = (value: ShelfFilter, label: string) => <button key={value} type="button" className="dgs-chip" aria-pressed={filter === value}
    style={shelfStyle.chip} onClick={() => { setFilter(value) }}>{label} {counts[value]}</button>
  const order = (value: ShelfSort, label: string) => <button key={value} type="button" className="dgs-sort" aria-pressed={sort === value}
    style={shelfStyle.sort} onClick={() => { setSort(value) }}>{label}</button>

  if (playingOnline && playingOnline.online && visible) {
    return <div style={s.root} data-plugin="dsh-game-studio" data-view="shelf">
      <div style={s.bar}>
        <button type="button" style={s.button} onClick={() => { setPlayingOnline(null) }}>{t('shelf.backToWall')}</button>
        <span style={s.title} title={playingOnline.title}>{playingOnline.title}</span>
        <span style={s.small}>{t('shelf.onlineFrom', { host: playingOnline.online.sourceHost })}</span>
        <a href={playingOnline.online.url} target="_blank" rel="noopener noreferrer" style={{ ...s.button, textDecoration: 'none' }}>{t('shelf.openExternal')}</a>
      </div>
      <div style={playingOnline.orientation === 'landscape' ? { ...s.stage, flex: 'none', aspectRatio: '16 / 9', minHeight: 0 } : s.stage}>
        <iframe key={playingOnline.online.url} src={playingOnline.online.url} title={playingOnline.title} style={s.frame}
          sandbox="allow-scripts" referrerPolicy="no-referrer" />
      </div>
    </div>
  }

  return <div style={s.root} data-plugin="dsh-game-studio" data-view="shelf">
    <style>{SHELF_CSS}</style>
    <div style={s.bar}>
      <span style={s.title}>{t('shelf.title')}</span>
      {(scan || onlineShelfGames.length > 0) && <span style={s.small}>{t('shelf.count', { count: String(shown.length) })}</span>}
      <button type="button" style={s.button} aria-pressed={showSources} onClick={() => { setShowSources(v => !v) }}>
        {sources.length > 0 ? t('shelf.sourcesCount', { count: String(sources.length) }) : t('shelf.sources')}
      </button>
      <button type="button" style={s.button} onClick={() => { setVersion(value => value + 1); void refreshFeeds(sources) }}>{t('shelf.refresh')}</button>
      {scan && scan.games.length > 0 && <>
        <button type="button" style={s.button} disabled={busy || builtLocalCount === 0} title={t('shelf.exportHint')}
          onClick={() => { void exportWall() }}>{exportingWall ? t('shelf.exporting') : t('shelf.export')}</button>
        <button type="button" style={s.button} disabled={busy || builtLocalCount === 0} title={t('shelf.publishHint')}
          onClick={() => { setConfirmPublishWall(v => !v) }}>{publishingWall ? t('shelf.publishing') : t('shelf.publish')}</button>
      </>}
    </div>
    {showSources && <div style={shelfStyle.sourcesPanel}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="text" value={sourceInput} onChange={e => { setSourceInput(e.target.value) }}
          onKeyDown={e => { if (e.key === 'Enter') void addSource() }}
          placeholder={t('shelf.sourcePlaceholder')} style={shelfStyle.sourceInput} disabled={addingSource} />
        <button type="button" style={s.button} disabled={addingSource || !sourceInput.trim()} onClick={() => { void addSource() }}>
          {addingSource ? t('shelf.sourceAdding') : t('shelf.sourceAdd')}
        </button>
      </div>
      {sources.length === 0 ? <div style={s.small}>{t('shelf.sourceEmpty')}</div>
        : sources.map((source) => {
          const st = feedStates[source.id]
          const isLoading = Boolean(loadingSourceIds[source.id])
          const count = st?.games.length ?? 0
          const updated = st?.fetchedAt ? clock(st.fetchedAt) : ''
          const statusText = isLoading
            ? t('shelf.sourceStatusLoading')
            : st?.status === 'error'
              ? t('shelf.sourceStatusError', { reason: st.error ?? '' })
              : t('shelf.sourceStatusOk')
          return <div key={source.id} style={{ ...s.row, fontSize: 12, flexWrap: 'wrap' }}>
            <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st?.name ?? source.label}</strong>
            <span style={s.small}>{t('shelf.count', { count: String(count) })}</span>
            {updated && <span style={s.small}>{t('shelf.sourceUpdated', { time: updated })}</span>}
            <span style={{ ...s.small, color: st?.status === 'error' ? tok.danger : tok.muted }}>{statusText}</span>
            {source.fromWorkspace && <span style={s.small}>{t('shelf.sourceFromWorkspace')}</span>}
            <span style={{ flex: 1 }} />
            {!source.fromWorkspace && <button type="button" style={s.button} onClick={() => { removeSource(source.id) }}>{t('shelf.sourceRemove')}</button>}
          </div>
        })}
    </div>}
    {confirmPublishWall && <div style={{ ...s.hint, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ color: tok.text }}>{t('tab.publishConfirmHint')}</span>
      <button type="button" style={s.button} disabled={busy}
        onClick={() => { setConfirmPublishWall(false); void publishWall() }}>{t('tab.publishConfirmYes')}</button>
      <button type="button" style={s.button} disabled={busy}
        onClick={() => { setConfirmPublishWall(false) }}>{t('tab.publishCancel')}</button>
    </div>}
    {wallPublished && <div style={{ ...s.hint, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ color: tok.text }}>{t('shelf.published', { url: wallPublished.url })}</span>
      {wallPublished.status === 'building' && <span>{t('tab.publishDeploying')}</span>}
      <button type="button" style={s.button}
        onClick={() => { void navigator.clipboard?.writeText(wallPublished.url).catch(() => undefined) }}>{t('tab.shareCopy')}</button>
    </div>}
    {notice && <div style={notice.kind === 'error' ? s.error : s.hint}>{notice.text}</div>}
    {(!sessionId || !cwd) && allGames.length === 0 ? <div style={s.hint}>{t('shelf.noSession')}</div>
      : scan === undefined && sessionId && cwd && allGames.length === 0 ? <div style={s.hint}>{t('shelf.scanning')}</div>
        : <>
          {scan?.partial && <div style={s.hint}>{t('shelf.partial')}</div>}
          {allGames.length === 0 ? <div style={{ ...s.hint, borderBottom: 0 }}>{t('shelf.empty')}</div>
            : <>
              <div style={shelfStyle.controls}>
                {chip('all', t('shelf.all'))}
                {counts['2d'] > 0 && chip('2d', '2D')}
                {counts['3d'] > 0 && chip('3d', '3D')}
                {onlineShelfGames.length > 0 && <button type="button" className="dgs-chip" aria-pressed={onlineOnly}
                  style={shelfStyle.chip} onClick={() => { setOnlineOnly(v => !v) }}>{t('shelf.online')} {onlineShelfGames.length}</button>}
                <span style={{ flex: 1 }} />
                {order('recent', t('shelf.sortRecent'))}
                {order('versions', t('shelf.sortVersions'))}
                {order('name', t('shelf.sortName'))}
              </div>
              <div style={shelfStyle.scroll}>
                <div style={shelfStyle.grid}>
                  {shown.map(game => <ShelfCard key={game.project} game={game} sessionId={sessionId} readBytes={readBytes} t={t} open={open} />)}
                </div>
              </div>
            </>}
        </>}
  </div>
}

function ShelfIcon(props: { size?: number }) {
  const size = props?.size ?? 16
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 8h10a4 4 0 0 1 4 4v2.5a2.5 2.5 0 0 1-4.6 1.4L15 14H9l-1.4 1.9A2.5 2.5 0 0 1 3 14.5V12a4 4 0 0 1 4-4z" />
    <path d="M8 10.5v3M6.5 12h3" /><circle cx="15.5" cy="11.5" r=".6" fill="currentColor" /><circle cx="17" cy="13" r=".6" fill="currentColor" />
  </svg>
}

// ---------------------------------------------------------------- chat rows

interface RowInjected { openStudio: (sessionId: string, project: string) => void }

function StudioRow(props: any): ReactNode {
  const { phase, block, sessionId, t, openStudio, toolName } = props as { phase: string; block: any; sessionId: string; t: T; toolName: string } & RowInjected
  const firstPhase = useRef(phase)
  const meta = phase === 'result' ? block?.meta as { studio?: number; kind?: string; project?: string; candidates?: unknown[]; job?: string | null; provider?: string; count?: number } | undefined : undefined
  const project = meta?.studio === 1 ? meta.project : undefined
  const failed = phase === 'result' && block?.isError === true
  useEffect(() => {
    // Open the studio only for calls that finished while we watched; history replay stays quiet.
    if (phase !== 'result' || firstPhase.current === 'result' || project === undefined || failed) return
    announceRefresh(project)
    openStudio(sessionId, project)
  }, [phase, project, failed, sessionId, openStudio])
  const label = failed ? t('row.failed')
    : phase !== 'result' ? t('row.running')
      : toolName === 'game_studio_create' ? t('row.create')
        : toolName === 'game_studio_build' ? t('row.build')
          : toolName === 'game_studio_generate_asset' ? (meta?.job
            ? t('row.background', { provider: providerName(meta.provider ?? ''), count: String(meta.count ?? 0) })
            : t('row.candidates', { count: String(meta?.candidates?.length ?? 0) }))
            : toolName === 'game_studio_apply_asset' ? t('row.apply')
              : toolName === 'game_studio_revert_asset' ? t('row.revert')
                : toolName === 'game_studio_publish' ? t('row.publish') : t('row.export')
  const detail = failed ? (block.content ?? []).map((item: any) => item.type === 'text' ? item.text : '').join(' ').slice(0, 240) : ''
  return <div style={s.row} data-tool={toolName}>
    <span aria-hidden>🎮</span>
    <span>{label}</span>
    {detail && <span style={{ ...s.small, color: tok.danger }}>{detail}</span>}
    {project && <button type="button" style={s.button} onClick={() => { openStudio(sessionId, project) }}>{t('row.open')}</button>}
  </div>
}

// ---------------------------------------------------------------- plugin

export const inject = ['slots', 'locale', 'remote', 'remote.workspaceFiles', 'remote.commands', 'sidebarRight', 'sidebarRightTabs']

export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-game-studio: dictionaries')
  const t: T = ctx.locale.bind(NS)

  const openStudio = (sessionId: string, project: string) => {
    ctx.sidebarRight.openResource(studioAddress(sessionId, project))
  }
  // Remote calls settle as `{ ok, value }` or `{ ok: false, error }`.
  const readBytes: ReadBytes = async (sessionId, path, signal) => {
    const result = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
    if (!result.ok) throw new Error(`${result.error?.message ?? 'read failed'} (${path})`)
    return result.value
  }
  const runCommand: RunCommand = async (sessionId, input) => {
    try {
      const result = await ctx.remote.commands.execute(sessionId, `/game-studio ${input}`, [])
      if (!result.ok) return { ok: false, text: `${result.error.message} (${result.error.code})` }
      const value = result.value?.result ?? result.value
      if (value === undefined) return { ok: false, text: 'The /game-studio command is not available in this session' }
      return { ok: value.kind === 'success', text: String(value.text ?? '') }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) }
    }
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: KIND,
    patterns: ['dsh-resource://game-studio/**'],
    priority: 'extension',
    canOpen: (address: string) => parseStudioAddress(address) !== undefined,
    title: (address: string) => {
      const target = parseStudioAddress(address)
      return t('tab.title', { name: target ? baseName(target.project) : 'game' })
    },
  }), 'dsh-game-studio: tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID, locale: NS,
    inject: (): TabInjected => ({ readBytes, runCommand }),
  }, StudioTab)), 'dsh-game-studio: tab body')

  const listDir: ListDir = async (sessionId, path, signal) => {
    const result = await ctx.remote.workspaceFiles.list(sessionId, path, signal)
    if (!result.ok) throw new Error(`${result.error?.message ?? 'list failed'} (${path})`)
    return { entries: result.value.entries ?? [], truncated: result.value.truncated === true }
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SHELF_ID,
    kind: SHELF_KIND,
    title: () => t('shelf.title'),
    guide: [{ id: 'shelf', order: 60, title: () => t('guide.title'), description: () => t('guide.description'), icon: ShelfIcon }],
  }), 'dsh-game-studio: shelf type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: SHELF_ID, locale: NS,
    inject: (sessionId: string): ShelfInjected => ({ shelfSession: typeof sessionId === 'string' ? sessionId : '', readBytes, listDir, runCommand }),
  }, ShelfTab)), 'dsh-game-studio: shelf body')

  for (const tool of TOOLS) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key: tool, locale: NS,
      inject: (): RowInjected => ({ openStudio }),
    }, StudioRow))
  }
}
