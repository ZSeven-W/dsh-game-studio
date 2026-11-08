/**
 * The game wall outside DSH: find every game in the workspace (the same scan
 * the sidebar's wall uses) and pack their latest builds into one offline HTML
 * page with the wall's tiles. Opening a tile plays that game full-window.
 *
 * Nothing is rebuilt or written inside the game projects; a game that was
 * never built is left out and reported. 3D games share one copy of the
 * runtime they all inline.
 */
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describeGame, scanShelf, type ListDir, type ReadText, type ShelfGame } from './client/shelf.ts'
import { runtimeTag } from './build.ts'
import { decodePng, encodePng, shrinkToWidth } from './png.ts'
import { RUNTIMES, type RuntimeId } from './project.ts'
import { resolveInside, StudioError, writeFileAtomic } from './util.ts'

export const fsList: ListDir = async (path) => {
  const entries = await readdir(path, { withFileTypes: true })
  // Symbolic links count as "other": the scan never follows one out of the workspace.
  return { entries: entries.map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })), truncated: false }
}
export const fsRead: ReadText = async (path) => readFile(path, 'utf8')

export function listGames(root: string, signal: AbortSignal = new AbortController().signal) {
  return scanShelf(fsList, fsRead, root, signal)
}

export function describeProject(dir: string, signal: AbortSignal = new AbortController().signal) {
  return describeGame(fsList, fsRead, dir, signal)
}

export type WallLang = 'zh' | 'en'

export interface WallOptions {
  root: string
  /** Game folders (relative to root or absolute inside it) in the order to show; default every game, newest first. */
  projects?: string[]
  lang?: WallLang
  /** File name without extension; default game-wall. */
  name?: string
  signal?: AbortSignal
}

export interface WallResult {
  file: string
  bytes: number
  games: number
  skipped: Array<{ path: string; reason: string }>
}

/** Above this the page gets slow to open; ask for fewer games instead. */
const MAX_WALL_BYTES = 64 * 1024 * 1024
const COVER_WIDTH = 480
const MAX_COVER_BYTES = 600 * 1024

export async function isPlainFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile() } catch { return false }
}

export interface CoverAsset {
  ext: 'jpg' | 'png' | 'webp' | 'svg'
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/svg+xml'
  bytes: Buffer
}

/** Read and shrink (if PNG) a project's cover picture for embedding or uploading. */
export async function readCoverAsset(path: string | undefined): Promise<CoverAsset | undefined> {
  if (!path || !(await isPlainFile(path))) return undefined
  const bytes = await readFile(path)
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) {
    try {
      const small = encodePng(shrinkToWidth(decodePng(bytes), COVER_WIDTH))
      return { ext: 'png', mime: 'image/png', bytes: Buffer.from(small) }
    } catch { return undefined }
  }
  if (bytes.byteLength > MAX_COVER_BYTES) return undefined
  if (lower.endsWith('.svg')) return { ext: 'svg', mime: 'image/svg+xml', bytes }
  if (lower.endsWith('.webp')) return { ext: 'webp', mime: 'image/webp', bytes }
  if (/\.jpe?g$/u.test(lower)) return { ext: 'jpg', mime: 'image/jpeg', bytes }
  return undefined
}

/** A small data URL for the tile, or undefined when the cover is missing, a link, or too big to embed. */
async function coverData(path: string | undefined): Promise<string | undefined> {
  const asset = await readCoverAsset(path)
  return asset ? `data:${asset.mime};base64,${asset.bytes.toString('base64')}` : undefined
}

function slugOf(name: string): string {
  return name.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '').toLowerCase() || 'game-wall'
}

/** JSON that cannot close the script element it sits in. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029')
}

function guessLang(games: ShelfGame[]): WallLang {
  return games.some(game => /[㐀-鿿]/u.test(game.title)) ? 'zh' : 'en'
}

export async function exportWall(options: WallOptions): Promise<WallResult> {
  const { root } = options
  const signal = options.signal ?? new AbortController().signal
  const scan = await listGames(root, signal)
  const byPath = new Map(scan.games.map(game => [game.project, game]))
  const skipped: WallResult['skipped'] = []
  let chosen: ShelfGame[]
  if (options.projects && options.projects.length > 0) {
    chosen = []
    for (const path of options.projects) {
      const dir = resolveInside(root, path)
      const game = byPath.get(dir)
      if (game) chosen.push(game)
      else skipped.push({ path, reason: 'not a game folder (needs game.json and .studio/)' })
    }
  } else chosen = scan.games

  const runtimes: Partial<Record<RuntimeId, string>> = {}
  for (const id of RUNTIMES) { try { runtimes[id] = await runtimeTag(id) } catch { /* runtime missing from this install */ } }
  const usedRuntimes = new Set<RuntimeId>()

  const entries: Array<Record<string, unknown>> = []
  for (const game of chosen) {
    if (signal.aborted) throw new StudioError('Export was cancelled', 'CANCELLED')
    const rel = relative(root, game.project) || '.'
    const artifact = join(game.project, 'dist', 'index.html')
    if (!(await isPlainFile(artifact))) { skipped.push({ path: rel, reason: 'not built yet' }); continue }
    let html = await readFile(artifact, 'utf8')
    for (const id of RUNTIMES) {
      const tag = runtimes[id]
      if (tag && html.includes(tag)) { html = html.split(tag).join(`<!--dsh-runtime:${id}-->`); usedRuntimes.add(id) }
    }
    entries.push({
      title: game.title, dimension: game.dimension ?? '', orientation: game.orientation,
      versions: game.versions, updatedAt: game.updatedAt, cover: await coverData(game.cover), html,
    })
  }
  if (entries.length === 0) throw new StudioError('No built games to put on the wall', 'NOTHING_TO_EXPORT')

  const lang = options.lang ?? guessLang(chosen)
  const data = {
    lang,
    exportedAt: new Date().toISOString(),
    runtimes: Object.fromEntries([...usedRuntimes].map(id => [id, runtimes[id]])),
    games: entries,
  }
  const page = renderWallPage(lang, scriptJson(data))
  const bytes = Buffer.byteLength(page)
  if (bytes > MAX_WALL_BYTES) {
    throw new StudioError(`The wall would be ${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_WALL_BYTES / 1048576} MB. Export fewer games.`, 'TOO_LARGE')
  }
  const dir = join(root, 'export')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${slugOf(options.name ?? 'game-wall')}.html`)
  await writeFileAtomic(file, page)
  return { file, bytes, games: entries.length, skipped }
}

const COPY: Record<WallLang, Record<string, string>> = {
  zh: {
    title: '游戏墙',
    brand: 'DSH STORE',
    search: '搜索游戏、流派或标签...',
    spotBadge: '本周主打推荐 · FEATURED SPOTLIGHT',
    playNow: '立即畅玩',
    freeTag: '免费畅玩',
    instantTag: '即点即玩 · 60 FPS',
    allOrient: '全部视野',
    portrait: '竖屏畅玩',
    landscape: '横屏宽幅',
    sortDef: '综合推荐',
    sort3d: '3D 优先',
    sortName: '名称排序',
    sectionTitle: '精选游戏库 · STORE LIBRARY',
    emptyFilter: '没有找到匹配当前筛选条件的游戏，试试切换标签或清空搜索。',
    reload: '重开',
    fullscreen: '全屏',
    count: '{n} 款',
    all: '全部',
    made: '用 DSH 游戏工坊做的 · 导出于 {date}',
    madeOnline: '用 DSH 游戏工坊做的 · 更新于 {date}',
    back: '← 返回游戏墙',
    versions: '{n} 个版本',
    hint: 'Esc 返回',
  },
  en: {
    title: 'Game wall',
    brand: 'DSH STORE',
    search: 'Search games, genres, or tags...',
    spotBadge: 'FEATURED SPOTLIGHT',
    playNow: 'Play Now',
    freeTag: 'FREE TO PLAY',
    instantTag: 'Instant Play · 60 FPS',
    allOrient: 'All Views',
    portrait: 'Portrait',
    landscape: 'Landscape',
    sortDef: 'Featured',
    sort3d: '3D First',
    sortName: 'Name A-Z',
    sectionTitle: 'STORE LIBRARY · ALL GAMES',
    emptyFilter: 'No games match the current filter. Try clearing your search or switching tabs.',
    reload: 'Restart',
    fullscreen: 'Fullscreen',
    count: '{n} games',
    all: 'All',
    made: 'Made with DSH Game Studio · exported {date}',
    madeOnline: 'Made with DSH Game Studio · updated {date}',
    back: '← Back to the wall',
    versions: '{n} versions',
    hint: 'Esc to go back',
  },
}

export const OFFLINE_WALL_CSP = [
  "default-src 'none'", 'img-src data: blob:', 'media-src data: blob:', 'font-src data:',
  "style-src 'unsafe-inline'", "script-src 'unsafe-inline'", "connect-src 'none'", "form-action 'none'",
].join('; ')

export const ONLINE_WALL_CSP = [
  "default-src 'none'", "img-src 'self' data: blob:", "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'", "connect-src 'self'", "frame-src 'self'", "form-action 'none'",
].join('; ')

function renderWallShell(
  lang: WallLang,
  opts: { mode: 'offline'; json: string } | { mode: 'online'; feedUrl: string },
): string {
  const copy = COPY[lang]
  const csp = opts.mode === 'online' ? ONLINE_WALL_CSP : OFFLINE_WALL_CSP
  const dataTag = opts.mode === 'offline' ? `<script type="application/json" id="data">${opts.json}</script>\n` : ''
  const bootScript = opts.mode === 'offline'
    ? `init(JSON.parse($('data').textContent),C.made);`
    : `fetch(${JSON.stringify(opts.feedUrl)},{cache:'no-cache'}).then(function(r){if(!r.ok)throw r.status;return r.json();}).then(function(f){init({exportedAt:f.updatedAt||'',runtimes:{},games:(f.games||[]).map(function(g){var u=typeof g.url==='string'?g.url.replace(/^\\/+/,''):'',c=typeof g.cover==='string'&&g.cover?g.cover.replace(/^\\/+/,''):'',v=g&&g.publishedAt?String(g.publishedAt).replace(/[^0-9a-zA-Z]/g,'').slice(0,14):'',q=v?'?v='+v:'';return{slug:g.slug||'',title:g.title||g.slug||'',dimension:g.dimension||'',orientation:g.orientation||'portrait',versions:g.versions||0,updatedAt:g.publishedAt||'',url:u?'../'+u+(u.indexOf('?')<0?q:''):'',cover:c?'../'+c+(c.indexOf('?')<0?q:''):''};})},C.madeOnline);}).catch(function(){init({exportedAt:'',runtimes:{},games:[]},C.madeOnline);});`
  const jsCopy = {
    title: copy.title, count: copy.count, all: copy.all, made: copy.made, madeOnline: copy.madeOnline,
    versions: copy.versions, playNow: copy.playNow, freeTag: copy.freeTag, allOrient: copy.allOrient,
    portrait: copy.portrait, landscape: copy.landscape, sortDef: copy.sortDef, sort3d: copy.sort3d,
    sortName: copy.sortName, emptyFilter: copy.emptyFilter,
  }

  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${copy.title}</title>
<style>
:root{color-scheme:dark;--fg:#f3f6fc;--m:#8d99ae;--c:#121826;--b:rgba(255,255,255,.08);--bd:1px solid var(--b);--g:#4ade80}
*{box-sizing:border-box}html,body{margin:0;min-height:100vh;background:radial-gradient(ellipse 90% 50% at 50% -10%,rgba(37,99,235,.22),transparent 75%),#080b12;color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif}
.topbar{background:rgba(8,11,18,.92);border-bottom:var(--bd)}
.topbar-in,.toolbar,#bar,.frow,.hprev-cap,.badges{display:flex;align-items:center;justify-content:space-between;gap:10px}
.topbar-in,.shell{max-width:1360px;margin:0 auto;padding:10px 20px}
.shell{padding:14px 20px 40px}
.bwrap,.fgroup,.chips,.htags,.trow,.hcta,.bleft,.bright,h1,.blogo,.spill,.pcta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.blogo{padding:4px 10px;border-radius:8px;background:#162032;border:1px solid rgba(255,255,255,.14);color:#f1f5f9;font-weight:800;font-size:12px;letter-spacing:.06em}
.blogo svg{width:14px;height:14px;fill:#38bdf8}.pcta svg{width:14px;height:14px;fill:currentColor}
h1{margin:0;font-size:19px;font-weight:800}
h1 small,.spill,.sbox input,.pcta,.chip,.subpill,.play-pill,.bbtn{border-radius:999px}
h1 small{font-size:12px;color:#cbd5e1;padding:2px 9px;background:var(--b)}
.made{margin:0;color:var(--m);font-size:12px}.made a{color:#93c5fd;text-decoration:none}
.sbox{position:relative;flex:1;max-width:250px;min-width:150px}
.sbox input{width:100%;padding:6px 12px 6px 30px;border:var(--bd);background:#0f172a;color:var(--fg);font:inherit;font-size:12.5px;outline:none}
.sbox svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:13px;height:13px;fill:var(--m)}
.hero{display:grid;grid-template-columns:1fr 268px;gap:12px;margin-bottom:14px}
@media(max-width:900px){.hero,.hbody{grid-template-columns:1fr}}
.hstage{position:relative;border-radius:16px;overflow:hidden;background:#101726;border:var(--bd);box-shadow:0 14px 34px #0008;display:flex;min-height:212px}
.hbg,.hprev-bg,.h-th{background-size:cover;background-position:center 26%}
.hbg{position:absolute;inset:-20px;filter:blur(20px) brightness(.38)}
.hgrad,.hprev-bg,.tile .shot,.play-ov,#player{position:absolute;inset:0}
.hgrad{background:linear-gradient(90deg,#070a12f2,#070a12bd 55%,#070a1247),linear-gradient(0deg,#070a12e6,transparent 55%)}
.hbody{position:relative;z-index:2;display:grid;grid-template-columns:1.2fr .8fr;gap:16px;width:100%;padding:18px 22px;align-items:center}
.hinfo,.hero-list,.cap,.hprice{display:flex;flex-direction:column;gap:6px}
.hinfo{align-items:flex-start}
.spill{padding:3px 9px;background:#3b82f633;border:1px solid #60a5fa66;color:#93c5fd;font-size:10.5px;font-weight:700}
.sdot{width:6px;height:6px;border-radius:50%;background:#60a5fa}
.htitle{margin:0;font-size:24px;font-weight:800}
.htag{font-size:11px;font-weight:600;padding:2px 8px;border-radius:5px;background:var(--b);color:#e2e8f0}
.htag.rate{background:#4ade8024;color:#86efac}
.hdesc{margin:0;color:#cbd5e1;font-size:13px;max-width:500px}
.pcta{padding:8px 18px;border:0;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font:inherit;font-weight:700;cursor:pointer;box-shadow:0 6px 18px #2563eb7a}
.hprice{gap:1px;margin-left:4px}.hprice strong{font-size:11.5px;color:var(--g)}.hprice span{font-size:10.5px;color:var(--m)}
.hprev{position:relative;height:178px;border-radius:12px;overflow:hidden;border:var(--bd);background:#0b0f19;cursor:pointer}
.hprev-bg{transition:transform .3s}
.hprev:hover .hprev-bg,.tile:hover img{transform:scale(1.05)}
.hprev-cap{position:absolute;inset:auto 0 0 0;padding:16px 10px 7px;background:linear-gradient(0deg,#000d,transparent);font-size:11px}
.h-item{display:flex;align-items:center;gap:9px;padding:5px 8px;border-radius:10px;border:var(--bd);background:#121826bf;color:var(--fg);font:inherit;text-align:left;cursor:pointer;flex:1}
.h-item.on{background:linear-gradient(90deg,#2563eb47,#1e293be6);border-color:#60a5fa8c}
.h-th{width:38px;height:35px;border-radius:6px;background-color:#1e293b;flex:none}
.h-txt{min-width:0;flex:1}.h-t,.name,.desc-l,.meta,#bar strong,.h-s{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h-t{font-weight:700;font-size:12.5px}.h-s{font-size:10.5px;color:var(--m)}
.toolbar{margin:0 0 11px;flex-wrap:wrap;padding:7px 11px;border-radius:11px;background:#121826b3;border:var(--bd)}
.chip,.subpill,.bbtn{font:inherit;font-size:12px;border:var(--bd);padding:4px 12px;background:#1e293bb3;color:#cbd5e1;cursor:pointer}
.chip[aria-pressed="true"]{background:#f8fafc;color:#090d16;border-color:#f8fafc;font-weight:700}
.div{width:1px;height:16px;background:var(--b)}
.subpill{font-size:11.5px;padding:3px 10px;background:#0f172a99;color:var(--m)}
.subpill.on{background:#3b82f633;color:#93c5fd;border-color:#60a5fa73;font-weight:600}
.sec-bar{margin:0 0 9px;font-size:11.5px;font-weight:700;letter-spacing:.06em;color:#94a3b8}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));gap:14px}
.tile{position:relative;display:flex;flex-direction:column;border:var(--bd);padding:0;border-radius:13px;overflow:hidden;cursor:pointer;background:var(--c);color:#fff;font:inherit;text-align:left;transition:transform .18s,border-color .18s;box-shadow:0 7px 18px #0005}
.tile:hover,.tile:focus-visible{transform:translateY(-3px);border-color:#60a5faa6;outline:none;background:#182135}
.media{position:relative;width:100%;aspect-ratio:16/10;overflow:hidden;background:radial-gradient(circle at 50% 35%,#27324a,#0f1523 80%)}
.tile .shot{width:100%;height:100%;object-fit:cover;object-position:center 26%;transition:transform .28s}
.tile .art{position:absolute;inset:10% 14%;width:72%;height:80%;object-fit:contain;transition:transform .28s}
.badges{position:absolute;top:7px;left:7px;right:7px;pointer-events:none;z-index:2}
.b-dim,.b-ori,.tpill,.ppill{font-size:10px;padding:2px 6px;border-radius:4px}
.b-dim{font-weight:800;background:#1e293be6;color:#e2e8f0}
.b-dim.d3{background:#0369a1e6;color:#e0f2fe}
.b-ori{font-weight:600;background:#0f172ad1;color:#cbd5e1}
.play-ov{background:linear-gradient(0deg,#080c16cc,transparent 65%);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .18s;z-index:1}
.tile:hover .play-ov{opacity:1}
.play-pill{padding:5px 13px;background:#2563ebf2;color:#fff;font-size:11.5px;font-weight:700}
.cap{padding:10px 11px 11px;flex:1;justify-content:space-between;gap:4px}
.name{font-weight:700;font-size:14.5px;color:#f8fafc}.desc-l{font-size:11.5px;color:#94a3b8}
.tpill{background:var(--b);color:#cbd5e1}
.frow{margin-top:3px;padding-top:6px;border-top:var(--bd)}.meta{font-size:11px;color:var(--m)}
.ppill{font-weight:700;color:var(--g);background:#4ade801f}
.empty{grid-column:1/-1;text-align:center;padding:32px;color:var(--m);border-radius:12px;border:1px dashed var(--b)}
#player{position:fixed;background:#05070c;opacity:0;pointer-events:none;z-index:20}#player.open{opacity:1;pointer-events:auto}
#player iframe{position:absolute;top:42px;left:0;width:100%;height:calc(100% - 42px);border:0;background:#000}
#bar{position:absolute;top:0;left:0;right:0;height:42px;padding:0 12px;background:#0c101a;border-bottom:var(--bd);z-index:2}
#player.fs iframe{top:0;height:100%}#player.fs #bar{background:none;border:0;pointer-events:none}#player.fs #playing,#player.fs #reload-btn{display:none}#player.fs .bbtn{pointer-events:auto;background:#0c101acc}
#back small{opacity:.7;margin-left:5px;font-weight:400}
</style></head><body>
<header class="topbar"><div class="topbar-in">
<div class="bwrap"><span class="blogo"><svg viewBox="0 0 24 24"><path d="M6 9h2v2h2v2H8v2H6v-2H4v-2h2V9zm10.5 2.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 3a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM7.5 5h9A5.5 5.5 0 0 1 22 10.5c0 2.7-.8 6.4-2.1 8.1-.8 1-2.2 1.1-3.2.2l-2.1-1.8H9.4l-2.1 1.8c-1 .9-2.4.8-3.2-.2C2.8 16.9 2 13.2 2 10.5A5.5 5.5 0 0 1 7.5 5z"/></svg>${copy.brand}</span><h1>${copy.title} <small id="count"></small></h1><p class="made" id="made"></p></div>
<div class="sbox"><svg viewBox="0 0 24 24"><path d="M10.5 3a7.5 7.5 0 0 1 5.96 12.04l4.25 4.25a1 1 0 0 1-1.42 1.42l-4.25-4.25A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/></svg><input id="search" type="search" placeholder="${copy.search}" autocomplete="off"></div>
</div></header>
<div class="shell">
<section class="hero" id="hero" style="display:none"><div class="hstage"><div class="hbg" id="hero-bg"></div><div class="hgrad"></div><div class="hbody"><div class="hinfo"><span class="spill"><span class="sdot"></span>${copy.spotBadge}</span><h2 class="htitle" id="hero-title"></h2><div class="htags" id="hero-tags"></div><p class="hdesc" id="hero-desc"></p><div class="hcta"><button type="button" class="pcta" id="hero-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>${copy.playNow}</button><div class="hprice"><strong>${copy.freeTag}</strong><span>${copy.instantTag}</span></div></div></div><div class="hprev" id="hero-prev"><div class="hprev-bg" id="hero-shot"></div><div class="hprev-cap"><span id="hero-meta"></span><span>▶ ${copy.playNow}</span></div></div></div></div><div class="hero-list" id="hero-list"></div></section>
<div class="toolbar"><div class="fgroup"><div class="chips" id="chips"></div><span class="div"></span><div class="chips" id="orient-filters"></div></div><div class="chips" id="sort-bar"></div></div>
<div class="sec-bar">${copy.sectionTitle}</div>
<main id="wall"></main>
</div>
<div id="player" role="dialog" aria-modal="true"><div id="bar"><div class="bleft"><button id="back" class="bbtn" type="button">${copy.back}<small>${copy.hint}</small></button><strong id="playing"></strong></div><div class="bright"><button id="reload-btn" class="bbtn" type="button">↻ ${copy.reload}</button><button id="fs-btn" class="bbtn" type="button">⛶ ${copy.fullscreen}</button></div></div></div>
${dataTag}<script>
(function(){
var C=${JSON.stringify(jsCopy)},CAT={
'gem-blast':'休闲三消·连锁爆炸·4大关卡|踏入星界秘境，触发激光与炫彩炸弹冲击狂热连消！|99%',
'fox-adventure':'横版平台·动作跑酷·4大章节|操控小狐狸穿越林间与星空遗迹，二段跳收集松果！|98%',
'kitchen-cat-fish':'潜行街机·趣味躲避·3阶挑战|化身橘猫潜入深夜厨房，纸箱隐身飞扑偷走金枪鱼！|97%',
'penguin-berg':'3D 体素·冰川生存·特技滑铲|在 3D 浮冰与极光冰窟滑铲穿梭，冰震波震退海豹！|97%',
'red-panda-bamboo':'3D 体素·竹林秘境·旋风特技|深入晨雾与萤火竹林，翻滚避开野猪收集金玉冬笋！|98%',
'hoop-rush':'街机体育·物理投篮·3轮赛制|60秒极限街球挑战！空心连中触发开火与双倍彩球！|96%',
'slime-king-cards':'卡牌构筑·回合策略·3阶首领|组建剑士牌组，切换三姿态搭配圣物讨伐史莱姆王！|99%',
'apex-rush':'俯视竞速·极限漂移·氮气加速|在落日海湾赛道贴弯漂移，集气释放氮气狂飙夺冠！|98%',
'slime-gate-defense':'策略塔防·英雄技能·10波守城|部署三系防御塔，召唤全屏精灵箭雨抵御史莱姆大军！|98%',
'dino-volcano-eggs':'3D 体素·火山历险·震地怒吼|操控小恐龙在 3D 火山岛冲刺避石，抢救金恐龙蛋！|97%'
};
function $(id){return document.getElementById(id);}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e;}
function ap(p,c){p.appendChild(c);return c;}
var wall=$('wall'),chips=$('chips'),player=$('player'),ob=$('orient-filters'),sbar=$('sort-bar'),si=$('search'),hs=$('hero'),hl=$('hero-list');
var data={exportedAt:'',runtimes:{},games:[]},flt='all',of='all',sb='def',q='',frame=null,ci=-1,hi=0,ht=null;
function fill(t,n){return t.replace('{n}',String(n)).replace('{date}',n);}
function info(g){
var raw=CAT[g.slug||''];
if(!raw)for(var k in CAT)if((g.title||'').indexOf(CAT[k].slice(0,2))!==-1){raw=CAT[k];break;}
if(raw){var p=raw.split('|');return{tags:p[0].split('·'),desc:p[1],rate:p[2]+' 好评'};}
var d3=g.dimension==='3d';
return{tags:[d3?'3D 立体':'2D 街机',g.orientation==='landscape'?C.landscape:C.portrait],desc:(d3?'沉浸式 3D 互动世界，':'爽快 2D 街机闯关，')+'支持键鼠与触控即点即玩。',rate:'96% 好评'};
}
function rChips(){
var c={all:data.games.length,'2d':0,'3d':0};data.games.forEach(function(g){if(c[g.dimension]!==undefined)c[g.dimension]++;});
chips.innerHTML='';
[['all',C.all],['2d','2D'],['3d','3D']].forEach(function(p){
if(p[0]!=='all'&&!c[p[0]])return;
var b=ap(chips,el('button','chip',p[1]+' '+c[p[0]]));b.type='button';b.setAttribute('aria-pressed',String(flt===p[0]));
b.onclick=function(){flt=p[0];rChips();rWall();};
});
ob.innerHTML='';
[['all',C.allOrient],['portrait','📱 '+C.portrait],['landscape','🖥️ '+C.landscape]].forEach(function(p){
var b=ap(ob,el('button','subpill'+(of===p[0]?' on':''),p[1]));b.type='button';
b.onclick=function(){of=p[0];rChips();rWall();};
});
sbar.innerHTML='';
[['def',C.sortDef],['3d',C.sort3d],['name',C.sortName]].forEach(function(p){
var b=ap(sbar,el('button','subpill'+(sb===p[0]?' on':''),p[1]));b.type='button';
b.onclick=function(){sb=p[0];rChips();rWall();};
});
}
function rHero(){
if(!data.games.length){hs.style.display='none';return;}
hs.style.display='';
var n=Math.min(5,data.games.length);if(hi>=n)hi=0;
var g=data.games[hi],inf=info(g),bg=g.cover?'url("'+g.cover.replace(/"/g,'%22')+'")':'none';
$('hero-title').textContent=g.title;$('hero-desc').textContent=inf.desc;
$('hero-bg').style.backgroundImage=$('hero-shot').style.backgroundImage=bg;
$('hero-meta').textContent=[(g.dimension||'2d').toUpperCase(),g.orientation==='landscape'?C.landscape:C.portrait].join(' · ');
var tg=$('hero-tags');tg.innerHTML='';ap(tg,el('span','htag rate','★ '+inf.rate));
inf.tags.forEach(function(t){ap(tg,el('span','htag',t));});
$('hero-play').onclick=$('hero-prev').onclick=function(){play(hi);};
hl.innerHTML='';
for(var i=0;i<n;i++)(function(idx){
var ig=data.games[idx],ii=info(ig),btn=ap(hl,el('button','h-item'+(idx===hi?' on':''))),th=ap(btn,el('span','h-th')),tx=ap(btn,el('span','h-txt'));btn.type='button';
if(ig.cover)th.style.backgroundImage='url("'+ig.cover.replace(/"/g,'%22')+'")';
ap(tx,el('span','h-t',ig.title));ap(tx,el('span','h-s',ii.tags.slice(0,2).join(' · ')));
btn.onclick=function(){if(hi===idx)play(idx);else{hi=idx;rHero();}};
})(i);
}
function rWall(){
wall.innerHTML='';var shown=0;
var items=data.games.map(function(g,i){return{g:g,i:i,inf:info(g)};}).filter(function(it){
return(flt==='all'||it.g.dimension===flt)&&(of==='all'||(it.g.orientation||'portrait')===of)&&(!q||(it.g.title+' '+it.inf.tags.join(' ')+' '+it.inf.desc).toLowerCase().indexOf(q)!==-1);
});
if(sb==='3d')items.sort(function(a,b){return(b.g.dimension==='3d'?1:0)-(a.g.dimension==='3d'?1:0)||a.i-b.i;});
else if(sb==='name')items.sort(function(a,b){return a.g.title.localeCompare(b.g.title,'zh-CN');});
items.forEach(function(it){
var g=it.g,i=it.i,inf=it.inf,shot=g.cover&&(g.cover.indexOf('data:image/jpeg')===0||/\\.jpe?g(\\?|$)/i.test(g.cover));shown++;
var t=ap(wall,el('button','tile'+(shot?'':' art-bg'))),m=ap(t,el('span','media')),bd=el('span','badges'),ov=el('span','play-ov'),cap=ap(t,el('span','cap')),top=ap(cap,el('span')),trow=el('span','trow'),foot=ap(cap,el('span','frow'));
t.type='button';t.title=g.title;
if(g.cover){var img=ap(m,el('img',shot?'shot':'art'));img.src=g.cover;img.alt='';img.onerror=function(){img.style.display='none';};}
ap(bd,el('span','b-dim '+(g.dimension==='3d'?'d3':'d2'),g.dimension?g.dimension.toUpperCase():'GAME'));
ap(bd,el('span','b-ori',g.orientation==='landscape'?C.landscape:C.portrait));ap(m,bd);
ap(ov,el('span','play-pill','▶ '+C.playNow));ap(m,ov);
inf.tags.slice(0,3).forEach(function(tg){ap(trow,el('span','tpill',tg));});
ap(top,el('span','name',g.title));ap(top,el('span','desc-l',inf.desc));ap(top,trow);
ap(foot,el('span','meta',[g.dimension?g.dimension.toUpperCase():'',g.versions>0?fill(C.versions,g.versions):inf.rate].filter(Boolean).join(' · ')));
ap(foot,el('span','ppill',C.freeTag));
t.onclick=function(){play(i);};
});
if(!shown&&data.games.length)ap(wall,el('div','empty',C.emptyFilter));
$('count').textContent=fill(C.count,shown);
}
function play(i){
var g=data.games[i];if(!g)return;
if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();
ci=i;close();
frame=el('iframe');frame.setAttribute('allow','fullscreen; gamepad; autoplay');frame.title=g.title;
if(g.url){frame.setAttribute('sandbox','allow-scripts allow-pointer-lock');frame.src=g.url;}
else{
frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-pointer-lock');
frame.srcdoc=(g.html||'').replace(/<!--dsh-runtime:([a-z0-9]+)-->/g,function(all,id){return data.runtimes[id]||all;});
}
frame.onload=function(){
player.classList.add('open');frame.focus();
try{frame.contentWindow.addEventListener('keydown',function(e){if(e.key==='Escape')close();});}catch(e){}
try{frame.contentWindow.focus();}catch(e){}
};
ap(player,frame);document.title=g.title;$('playing').textContent=g.title;
}
function close(){
if(frame){frame.remove();frame=null;}
player.classList.remove('open','fs');document.title=C.title;
}
function init(next,tpl){
data=next;
var m=$('made');m.innerHTML='';ap(m,document.createTextNode(fill(tpl,(data.exportedAt||'').slice(0,10))+' · '));
var a=ap(m,el('a','','github.com/ZSeven-W/dsh-game-studio'));a.href='https://github.com/ZSeven-W/dsh-game-studio';a.target='_blank';a.rel='noopener';
rHero();rChips();rWall();
if(ht)clearInterval(ht);
if(data.games.length>1)ht=setInterval(function(){if(!player.classList.contains('open')){hi=(hi+1)%Math.min(5,data.games.length);rHero();}},6000);
}
si.oninput=function(){q=(si.value||'').trim().toLowerCase();rWall();};
$('back').onclick=close;
$('reload-btn').onclick=function(){if(ci>=0)play(ci);};
$('fs-btn').onclick=function(){if(player.requestFullscreen){if(!document.fullscreenElement)player.requestFullscreen().catch(function(){player.classList.toggle('fs');});else document.exitFullscreen();}else player.classList.toggle('fs');};
document.addEventListener('keydown',function(e){if(e.key==='Escape')close();});
window.addEventListener('message',function(e){if(frame&&e.source===frame.contentWindow&&e.data&&e.data.type==='dsh-wall-escape')close();});
${bootScript}
})();
</script>
</body></html>
`.replace(/\n+/g, '\n')
}

/** The offline wall page: tiles like the sidebar's wall, 2D/3D filters, and a full-window player. */
export function renderWallPage(lang: WallLang, json: string): string {
  return renderWallShell(lang, { mode: 'offline', json })
}

/** The lightweight online wall page for GitHub Pages: reads `../games.json` and loads games on demand in an iframe. */
export function renderOnlineWallPage(lang: WallLang, feedUrl = '../games.json'): string {
  return renderWallShell(lang, { mode: 'online', feedUrl })
}
