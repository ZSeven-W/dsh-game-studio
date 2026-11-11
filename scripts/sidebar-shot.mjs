// Screenshot the sidebar panels users actually see: bundle the real client source
// with a fake host, render it in a headless browser and capture the main panel,
// the launch wizard and the monetization panel.
//
//   npm run shots
//
// Screenshots land in artifacts/sidebar/.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildProject } from '../src/build.ts'
import { writeState } from '../src/assets.ts'
import { createProject } from '../src/project.ts'
import { loadRelease, markMaterialsWritten, markReviewWritten, releasePlan, releaseStatus } from '../src/release.ts'
import { launchBrowser } from '../test/wechat-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outDir = resolve(outIndex >= 0 ? args[outIndex + 1] : join(repo, '..', 'artifacts', 'sidebar'))
await mkdir(outDir, { recursive: true })

// Fixtures come from the real command layer so the panel renders real step titles.
const temp = await mkdtemp(join(repo, '..', '.sidebar-fixtures-'))
const fixtures = { release: null, commerce: null, state: null }
try {
  const dir = join(temp, 'lantern-isle-3d')
  const project = await createProject(dir, { title: 'Lantern Isle', template: 'voxel' })
  project.rules = { ...project.rules, duration: 45 }
  await writeFile(join(dir, 'game.json'), `${JSON.stringify(project, null, 2)}\n`)
  const built = await buildProject(dir, 'Screenshot fixture')
  fixtures.state = await writeState(dir, built)
  // The panel shows that these two files already exist; generate them for the fixture.
  await markMaterialsWritten(dir)
  await markReviewWritten(dir)
  fixtures.release = {
    ...releaseStatus(dir, await loadRelease(dir), releasePlan(false)),
    materialsPresent: true,
    reviewPresent: true,
    uploads: [{ version: '0.9.0', at: new Date().toISOString(), note: 'uploaded 0.9.0 · 主包 803 KB · upload ok' }],
  }
  fixtures.commerce = {
    enabled: false,
    ads: { interstitial: '', rewarded: '' },
    iap: { enabled: false, licenseNumber: '', merchantId: '', payUrl: '' },
    analytics: true,
    embedded: false,
    check: { ok: true, problems: [], notes: ['尚未开启商业化：填好广告位或资质后再打开开关。'] },
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}

const bundle = join(outDir, 'sidebar.js')
await build({
  entryPoints: [join(repo, 'test', 'sidebar-entry.tsx')],
  bundle: true,
  outfile: bundle,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  target: ['chrome110'],
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
})

const browser = await launchBrowser()
if (!browser) {
  console.log('no Chrome or Edge installed: screenshots skipped')
  process.exit(0)
}
const parseRgb = (value) => {
  const text = String(value).trim()
  const hex = text.match(/^#([0-9a-f]{6})$/iu)
  if (hex) {
    const int = Number.parseInt(hex[1], 16)
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 }
  }
  const match = text.match(/rgba?\(([^)]+)\)/u)
  if (!match) return null
  const [r, g, b] = match[1].split(',').map((part) => Number(part.trim()))
  return { r, g, b }
}
const luminance = ({ r, g, b }) => {
  const channel = (value) => {
    const v = value / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
const contrastRatio = (foreground, background) => {
  const a = luminance(parseRgb(foreground))
  const b = luminance(parseRgb(background))
  const [light, dark] = a >= b ? [a, b] : [b, a]
  return (light + 0.05) / (dark + 0.05)
}
const contrastChecks = []
const expectContrast = (label, foreground, background, minimum) => {
  const ratio = contrastRatio(foreground, background)
  const ok = ratio >= minimum
  contrastChecks.push({ label, ratio: Number(ratio.toFixed(2)), minimum, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  contrast ${label}: ${ratio.toFixed(2)}:1 (needs ${minimum}:1) — ${foreground} on ${background}`)
  if (!ok) process.exitCode = 1
}

const page = await browser.newPage({ viewport: { width: 400, height: 900 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (error) => errors.push(String(error?.stack ?? error)))
await page.addInitScript((data) => { window.__FIXTURES__ = data.fixtures; window.__WIDTH__ = data.width }, { fixtures, width: 372 })
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #f3f4f6; }
</style></head><body><div id="root"></div><script src="${'sidebar.js'}"></script></body></html>`
const pageFile = join(outDir, 'sidebar.html')
await writeFile(pageFile, html, 'utf8')

try {
  await page.goto(`file:///${pageFile.replace(/\\/gu, '/')}`)
  await page.waitForTimeout(1500)
  console.log('page errors:', JSON.stringify(errors))
  console.log('body:', (await page.evaluate(() => document.body.innerText)).slice(0, 400).replace(/\n/gu, ' | '))
  await page.waitForSelector('text=导出微信小游戏', { timeout: 20000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(outDir, 'sidebar-main.png'), fullPage: true })

  await page.click('text=上线向导')
  await page.waitForSelector('text=注册', { timeout: 20000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(outDir, 'sidebar-wizard.png'), fullPage: true })

  // The step list scrolls inside the panel; a second shot shows the rest.
  const list = await page.$('text=注册小游戏账号')
  if (list) {
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('*')].find((node) => node.textContent?.trim() === '注册小游戏账号')
      let node = row?.parentElement ?? null
      while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement
      if (node) node.scrollTop = node.scrollHeight
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(outDir, 'sidebar-wizard-bottom.png'), fullPage: true })
  }

  // The environment doctor's answer, as the panel shows it.
  const doctorButton = await page.$('text=检查环境')
  if (doctorButton) {
    await doctorButton.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(outDir, 'sidebar-env.png'), fullPage: true })
  }

  const lightColours = await page.evaluate(() => {
    const styleOf = (text) => {
      const node = [...document.querySelectorAll('div, span, button')]
        .filter((el) => el.childElementCount === 0)
        .find((el) => el.textContent.trim().includes(text))
      return node ? getComputedStyle(node) : null
    }
    return {
      muted: styleOf('点一下画面开始玩')?.color ?? null,
      danger: styleOf('环境检查')?.color ?? null,
      background: getComputedStyle(document.body).backgroundColor,
    }
  })
  if (lightColours.muted) expectContrast('light muted hint', lightColours.muted, lightColours.background, 4.5)
  if (lightColours.danger) expectContrast('light error notice', lightColours.danger, lightColours.background, 4.5)

  // Touch targets: the sidebar is also used on a tablet/phone-sized surface, so
  // every button should reach the 24x24 px minimum.
  const targets = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((button) => button.offsetParent !== null)
    .map((button) => {
      const rect = button.getBoundingClientRect()
      return { label: (button.textContent || button.getAttribute('aria-label') || '?').trim().slice(0, 24), width: Math.round(rect.width), height: Math.round(rect.height) }
    }))
  const small = targets.filter((target) => target.width < 24 || target.height < 24)
  const shortest = targets.reduce((min, target) => Math.min(min, target.height), Infinity)
  console.log(`touch targets: ${targets.length} buttons, shortest ${shortest}px, ${small.length} below 24px`)
  if (small.length > 0) {
    for (const target of small) console.log(`  small: ${target.label} ${target.width}x${target.height}`)
    process.exitCode = 1
  }

  // Keyboard and screen-reader basics: every control needs a name, and Tab must
  // land on a control with a visible focus ring.
  const a11y = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('button, input, a[href], iframe')]
      .filter((el) => el.offsetParent !== null || el.tagName === 'IFRAME')
    const unnamed = controls
      .filter((el) => !(el.textContent || '').trim() && !el.getAttribute('aria-label') && !el.getAttribute('title'))
      .map((el) => el.outerHTML.slice(0, 70))
    return { count: controls.length, unnamed }
  })
  console.log(`accessible names: ${a11y.count} controls, ${a11y.unnamed.length} unnamed`)
  if (a11y.unnamed.length > 0) {
    for (const snippet of a11y.unnamed) console.log(`  unnamed: ${snippet}`)
    process.exitCode = 1
  }

  await page.evaluate(() => document.body.focus())
  await page.keyboard.press('Tab')
  const focus = await page.evaluate(() => {
    const el = document.activeElement
    if (!el) return null
    const style = getComputedStyle(el)
    return {
      tag: el.tagName,
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    }
  })
  const ringVisible = focus !== null && focus.outlineStyle !== 'none' && Number.parseFloat(focus.outlineWidth) >= 2
  console.log(`tab focus: <${focus?.tag}> "${focus?.label}" outline ${focus?.outlineStyle} ${focus?.outlineWidth}`)
  if (!ringVisible) {
    console.error('Tab does not land on a control with a visible focus ring')
    process.exitCode = 1
  }

  // Preview writes a QR file; the panel shows it so the user can scan directly.
  const previewButton = await page.$('text=预览二维码')
  if (previewButton) {
    await previewButton.click()
    await page.waitForSelector('img[alt="preview QR"]', { timeout: 5000 }).catch(() => undefined)
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(outDir, 'sidebar-preview.png'), fullPage: true })
  }

  // Upload with the fake CLI: the wizard must show the upload step done afterwards.
  const uploadButton = await page.$('text=上传版本')
  if (uploadButton) {
    await uploadButton.click()
    await page.waitForSelector('text=已上传版本', { timeout: 5000 }).catch(() => undefined)
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(outDir, 'sidebar-uploaded.png'), fullPage: true })
  }

  // Real sidebars are narrower than the draw width; check the same panel at 320 px.
  const narrow = await browser.newPage({ viewport: { width: 320, height: 900 }, deviceScaleFactor: 2 })
  const narrowErrors = []
  narrow.on('pageerror', (error) => narrowErrors.push(String(error)))
  await narrow.addInitScript((data) => { window.__FIXTURES__ = data.fixtures; window.__WIDTH__ = data.width }, { fixtures, width: 320 })
  await narrow.goto(`file:///${pageFile.replace(/\\/gu, '/')}`)
  await narrow.waitForSelector('text=上线向导', { timeout: 20000 })
  await narrow.click('text=上线向导')
  await narrow.waitForSelector('text=注册小游戏账号', { timeout: 20000 })
  await narrow.waitForTimeout(400)
  const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  console.log(`narrow width overflow: ${overflow}px (${narrowErrors.length} page errors)`)
  await narrow.screenshot({ path: join(outDir, 'sidebar-narrow.png'), fullPage: true })
  await narrow.close()
  if (overflow > 0) process.exitCode = 1
  if (narrowErrors.length > 0) process.exitCode = 1

  // The panel takes its colours from host CSS variables; check that a dark theme
  // really reaches it instead of being overridden by hard-coded colours.
  const dark = await browser.newPage({ viewport: { width: 400, height: 900 }, deviceScaleFactor: 2 })
  const darkErrors = []
  dark.on('pageerror', (error) => darkErrors.push(String(error)))
  await dark.addInitScript((data) => { window.__FIXTURES__ = data.fixtures; window.__WIDTH__ = data.width }, { fixtures, width: 372 })
  await dark.goto(`file:///${pageFile.replace(/\\/gu, '/')}`)
  await dark.waitForSelector('text=上线向导', { timeout: 20000 })
  await dark.click('text=上线向导')
  await dark.waitForSelector('text=注册小游戏账号', { timeout: 20000 })
  await dark.evaluate(() => {
    const root = document.documentElement
    root.style.setProperty('--dsw-alias-label-primary', 'rgb(232, 236, 245)')
    root.style.setProperty('--dsw-alias-label-secondary', 'rgb(158, 168, 186)')
    root.style.setProperty('--dsw-alias-border-l2', 'rgba(255, 255, 255, 0.18)')
    root.style.setProperty('--dsw-alias-label-danger', 'rgb(255, 128, 128)')
    document.body.style.background = '#11151c'
    document.body.style.margin = '0'
  })
  await dark.waitForTimeout(400)
  const themed = await dark.evaluate(() => {
    const heading = [...document.querySelectorAll('strong')].find((node) => node.textContent.includes('上线向导'))
    const hint = [...document.querySelectorAll('div, span')]
      .filter((node) => node.childElementCount === 0)
      .find((node) => node.textContent.trim().includes('点一下画面开始玩'))
    return {
      heading: heading ? getComputedStyle(heading).color : null,
      hint: hint ? getComputedStyle(hint).color : null,
      background: '#11151c',
    }
  })
  console.log(`dark theme heading colour: ${themed.heading} (${darkErrors.length} page errors)`)
  if (themed.heading) expectContrast('dark primary text', themed.heading, themed.background, 7)
  if (themed.hint) expectContrast('dark muted hint', themed.hint, themed.background, 4.5)
  await dark.screenshot({ path: join(outDir, 'sidebar-dark.png'), fullPage: true })
  await dark.close()
  if (themed.heading !== 'rgb(232, 236, 245)') {
    console.error('the panel ignores the host label colour in a dark theme')
    process.exitCode = 1
  }
  if (darkErrors.length > 0) process.exitCode = 1

  const commerceButton = await page.$('text=商业化')
  if (commerceButton) {
    await commerceButton.click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(outDir, 'sidebar-commerce.png'), fullPage: true })
  }
  console.log(`screenshots written to ${outDir} (${errors.length} page errors)`)
  for (const error of errors) console.log(`  ${error}`)
} finally {
  await browser.close()
  if (errors.length > 0) process.exitCode = 1
}
