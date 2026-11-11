/**
 * WeChat mini-game export target.
 *
 * The plugin's normal build is one self-contained browser HTML file. A WeChat
 * mini-game is a different runtime: game.js (CommonJS entry), game.json,
 * project.config.json, no DOM/HTML, and wx.* APIs. This module keeps the game
 * project's game.js unchanged and wraps it with a browser-like runtime
 * (wechat-runtime.js) on top of wx.*, then writes an importable project.
 *
 * P0 scope: 2D canvas games and 3D three.js/voxel games. SVG art is rasterised
 * to PNG because WeChat image loading does not support SVG.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLedger, loadManifest, paths, RUNTIMES, type GameManifest, type RuntimeId } from './project.ts'
import { embedCommerce, loadCommerce } from './commerce.ts'
import { analyzeWechatPackage, type PackageReport } from './size.ts'
import { StudioError, writeJson } from './util.ts'

const RUNTIME_FILE = fileURLToPath(new URL('./wechat-runtime.js', import.meta.url))
// Built by scripts/build.mjs into <package>/lib/vendor from both src/ and lib/.
const RUNTIME_FILES: Record<RuntimeId, URL> = {
  three: new URL('../lib/vendor/three.js', import.meta.url),
}
const MAX_MAIN_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 30 * 1024 * 1024
const SUPPORTED_RASTER = new Set(['.png', '.jpg', '.jpeg', '.webp'])

export interface WechatExportOptions {
  /** WeChat mini-game AppID; defaults to the DevTools tourist AppID. */
  appid?: string
  signal?: AbortSignal
}

export interface WechatExportResult {
  dir: string
  files: string[]
  bytes: number
  appid: string
  runtimes: string[]
  monetization: { enabled: true; interstitial?: string; rewarded?: string; analytics: boolean } | null
  report: PackageReport
  warnings: string[]
}

function slugify(value: string): string {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '').toLowerCase().slice(0, 40) || 'game'
}

async function launchBrowser(): Promise<any> {
  let chromium: any
  try { ({ chromium } = await import('playwright-core')) }
  catch { throw new StudioError('playwright-core is missing from this dsh-game-studio install', 'NO_BROWSER') }
  const tried: string[] = []
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }) }
    catch (error) {
      tried.push(`${channel}: ${String((error as Error).message ?? error).split('\n')[0]}`)
    }
  }
  throw new StudioError(
    'WeChat export needs Google Chrome or Microsoft Edge to rasterize SVG assets to PNG; neither could be started '
    + `(${tried.join('; ')}). Install one, or replace the SVG slot art with PNG and export again.`,
    'NO_BROWSER',
  )
}

async function rasterizeSvg(page: any, bytes: Buffer, width: number, height: number): Promise<Buffer> {
  const svgBase64 = bytes.toString('base64')
  const pngBase64 = await page.evaluate(async (args: { svgBase64: string; width: number; height: number }) => {
    const image = new Image()
    image.src = `data:image/svg+xml;base64,${args.svgBase64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = args.width
    canvas.height = args.height
    const context = canvas.getContext('2d')
    context.clearRect(0, 0, args.width, args.height)
    context.drawImage(image, 0, 0, args.width, args.height)
    return canvas.toDataURL('image/png').split(',')[1]
  }, { svgBase64, width, height })
  return Buffer.from(pngBase64, 'base64')
}

function readme(manifest: GameManifest, appid: string): string {
  return [
    `# ${manifest.title} — 微信小游戏工程`,
    '',
    '由 dsh-game-studio 的微信小游戏导出 target 生成。',
    '',
    '## 运行',
    '',
    '1. 打开微信开发者工具，导入本目录，项目类型选「小游戏」。',
    `2. AppID：当前是 \`${appid}\`；如果有自己的小游戏 AppID，替换 \`project.config.json\` 里的 \`appid\`，或在导入时选择测试号。`,
    '3. 点击编译；模拟器里应该直接进入游戏。',
    '4. 真机预览用「预览 / 真机调试」。',
    '',
    '## 这一版的范围',
    '',
    '- 支持 2D canvas 游戏（collector 模板和自定义 2D game.js）。',
    '- 支持 3D three.js / voxel 游戏：three.js 已内联进 game.js，WebGL 渲染到离屏 canvas，再逐帧合成到屏幕上屏 canvas。',
    '- 3D 需要 WebGL2（较新的微信基础库与机型）；不支持的设备会显示一句可读的提示，而不是白屏。',
    '- 小游戏没有 DOM，3D 模板的分数/血量/计时与开始、结束卡片由适配层按 window.__gameState() 用 canvas 重绘。',
    '- SVG 素材已转成 PNG，因为微信小游戏的 Image 不保证支持 SVG。',
    '- 音频目前静音（原游戏的 WebAudio 调用被安全跳过）；触摸/指针事件已适配。',
    '- 广告不强推：配置广告位后两局之间最多一次插屏，激励视频只由「看广告复活」触发；未配置则不加载广告代码。',
    '- 内购需要版号与微信支付商户号才能开启；配了签名服务地址才会真正调 wx.requestVirtualPayment，否则只跑演示流程。',
    '- 低端机会自动降级：按设备 benchmark 把渲染倍率限制在 1×（中端 1.5×、高端 2×），低端机帧率上限 30。',
    '- 导出结果里的 report 是包体报告：最大文件、是否超过 4 MB 主包、该压缩什么。',
    '- 微信的包体限制：主包 4MB、总包 30MB；导出时会在超过 4MB 时给出警告。',
    '',
    '## 注意',
    '',
    '- 这是发布产物，不要直接改这里的 game.js；改原游戏工程后重新导出。',
    '- `game.json` 只放微信小游戏的运行时配置，不是插件的 game.json。',
    '',
  ].join('\n')
}

/**
 * Export a dsh-game-studio project as a WeChat mini-game project under
 * <project>/export/wechat/<slug>/.
 */
export async function exportWechat(dir: string, options: WechatExportOptions = {}): Promise<WechatExportResult> {
  if (options.signal?.aborted) throw new StudioError('WeChat export was cancelled', 'CANCELLED')
  const manifest = await loadManifest(dir)
  const runtimes = [...(manifest.runtime ?? [])]
  for (const id of runtimes) {
    if (!(RUNTIMES as readonly string[]).includes(id)) {
      throw new StudioError(`Unknown runtime "${id}" in game.json; available: ${RUNTIMES.join(', ')}`, 'BAD_MANIFEST')
    }
  }

  let code: string
  try { code = await readFile(paths.code(dir), 'utf8') }
  catch { throw new StudioError(`game.js is missing in ${dir}`, 'MISSING_CODE') }
  const runtime = await readFile(RUNTIME_FILE, 'utf8')
  // Three.js ships as a classic script that assigns window.THREE; inline it like
  // the HTML build does, so the mini-game needs no remote or dynamic loading.
  const runtimeScripts: string[] = []
  for (const id of runtimes) {
    try { runtimeScripts.push(await readFile(RUNTIME_FILES[id], 'utf8')) }
    catch { throw new StudioError(`Runtime "${id}" is missing from this dsh-game-studio install`, 'MISSING_RUNTIME') }
  }
  const ledger = await loadLedger(dir).catch(() => undefined)
  const slug = slugify(manifest.title)
  const outDir = join(paths.exportDir(dir), 'wechat', slug)
  const assetDir = join(outDir, 'assets')
  await rm(outDir, { recursive: true, force: true })
  await mkdir(assetDir, { recursive: true })

  const warnings: string[] = []
  const assets: Record<string, string> = {}
  const files: string[] = []
  const written: Array<{ file: string; bytes: number }> = []
  let browser: any
  let page: any

  try {
    for (const [slot, spec] of Object.entries(manifest.slots)) {
      if (options.signal?.aborted) throw new StudioError('WeChat export was cancelled', 'CANCELLED')
      const sourcePath = join(dir, spec.file)
      let bytes: Buffer
      try { bytes = await readFile(sourcePath) }
      catch { throw new StudioError(`Asset for slot "${slot}" is missing: ${spec.file}`, 'MISSING_ASSET') }

      let ext = extname(sourcePath).toLowerCase()
      if (ext === '.svg') {
        if (!browser) {
          browser = await launchBrowser()
          page = await browser.newPage()
        }
        bytes = await rasterizeSvg(page, bytes, spec.size[0], spec.size[1])
        ext = '.png'
      } else if (!SUPPORTED_RASTER.has(ext)) {
        throw new StudioError(
          `WeChat export does not support "${ext}" for slot "${slot}"; use png, jpg, webp or svg.`,
          'BAD_ASSET',
        )
      }
      const fileName = `${slugify(slot) || 'slot'}${ext}`
      const relativePath = `assets/${fileName}`
      await writeFile(join(assetDir, fileName), bytes)
      assets[slot] = relativePath
      files.push(relativePath)
      written.push({ file: relativePath, bytes: bytes.length })
    }
  } finally {
    if (page) await page.close().catch(() => undefined)
    if (browser) await browser.close().catch(() => undefined)
  }

  const commerce = embedCommerce(await loadCommerce(dir))
  const game = {
    title: manifest.title,
    rules: manifest.rules,
    ...(commerce ? { monetization: commerce } : {}),
    slots: Object.fromEntries(Object.entries(manifest.slots).map(([slot, spec]) => [slot, {
      tile: spec.tile === true,
      custom: ledger?.assets[slot] !== undefined && ledger.assets[slot]!.source !== 'template',
    }])),
    assets,
  }

  const gameJs = [
    '/* Generated by dsh-game-studio — WeChat mini-game export. Edit the game project, not this file. */',
    runtime,
    ...runtimeScripts,
    `window.GAME=${JSON.stringify(game)};`,
    code,
    '',
  ].join('\n')
  await writeFile(join(outDir, 'game.js'), gameJs, 'utf8')
  files.push('game.js')
  written.push({ file: 'game.js', bytes: Buffer.byteLength(gameJs) })

  const orientation = manifest.orientation === 'landscape' ? 'landscape' : 'portrait'
  const gameJson = { deviceOrientation: orientation }
  await writeJson(join(outDir, 'game.json'), gameJson)
  files.push('game.json')
  written.push({ file: 'game.json', bytes: Buffer.byteLength(`${JSON.stringify(gameJson, undefined, 2)}\n`) })

  const appid = String(options.appid ?? '').trim() || 'touristappid'
  const projectConfig = {
    appid,
    projectname: slug,
    compileType: 'game',
    libVersion: '3.0.0',
    setting: { es6: true, minified: false, urlCheck: false },
  }
  await writeJson(join(outDir, 'project.config.json'), projectConfig)
  files.push('project.config.json')
  written.push({ file: 'project.config.json', bytes: Buffer.byteLength(`${JSON.stringify(projectConfig, undefined, 2)}\n`) })

  const readmeText = readme(manifest, appid)
  await writeFile(join(outDir, 'README.md'), readmeText, 'utf8')
  files.push('README.md')
  written.push({ file: 'README.md', bytes: Buffer.byteLength(readmeText) })

  const bytes = written.reduce((sum, entry) => sum + entry.bytes, 0)
  if (bytes > MAX_MAIN_BYTES) {
    warnings.push(`主包约 ${(bytes / 1048576).toFixed(1)} MB，超过微信小游戏 4 MB 主包限制；请压缩素材或使用分包。`)
  }
  if (bytes > MAX_TOTAL_BYTES) {
    warnings.push(`总包约 ${(bytes / 1048576).toFixed(1)} MB，超过 30 MB 总包限制。`)
  }
  if (manifest.slots && Object.keys(manifest.slots).length === 0) {
    warnings.push('这个工程没有素材槽位；游戏代码需要自己绘制画面。')
  }

  const report = await analyzeWechatPackage(outDir)
  return { dir: outDir, files, bytes, appid, runtimes, monetization: commerce, report, warnings }
}



