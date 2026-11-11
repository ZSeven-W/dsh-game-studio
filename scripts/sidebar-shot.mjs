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
import { loadRelease, releasePlan, releaseStatus } from '../src/release.ts'
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
  fixtures.release = releaseStatus(dir, await loadRelease(dir), releasePlan(false))
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
const page = await browser.newPage({ viewport: { width: 400, height: 900 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (error) => errors.push(String(error?.stack ?? error)))
await page.addInitScript((data) => { window.__FIXTURES__ = data }, fixtures)
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
