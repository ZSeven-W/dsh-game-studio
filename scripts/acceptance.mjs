// End-to-end acceptance run for the WeChat target.
//
// From empty folders it builds one 2D and one 3D game, configures ads, exports
// both mini-game projects, boots each exported project in the mock wx harness,
// plays a round, and writes RELEASE.md / REVIEW.md through the launch wizard.
// Output (screenshots + report) goes to ../artifacts/acceptance by default.
//
//   NODE_OPTIONS=--experimental-strip-types node scripts/acceptance.mjs [--out DIR]
//
// This is deliberately the same code path the tests use: the harness is imported,
// not copied, so a passing acceptance run means the shipped adapter works.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProject, loadManifest, paths } from '../src/project.ts'
import { updateCommerce } from '../src/commerce.ts'
import { exportWechat } from '../src/wechat.ts'
import { reviewGuide } from '../src/review.ts'
import { releaseMaterials, updateRelease } from '../src/release.ts'
import { writeJson } from '../src/util.ts'
import { openMockPage } from '../test/wechat-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outRoot = resolve(outIndex >= 0 ? args[outIndex + 1] : join(repo, '..', 'artifacts', 'acceptance'))

const AD_UNITS = { interstitial: 'adunit-demo0001', rewarded: 'adunit-demo0002' }
const GAMES = [
  { id: '2d', title: 'Moon Garden', template: 'collector', orientation: 'portrait' },
  { id: '3d', title: 'Lantern Isle', template: 'voxel', orientation: 'portrait' },
]

const report = {
  startedAt: new Date().toISOString(),
  node: process.version,
  plugin: JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version,
  output: outRoot,
  games: [],
  release: null,
  checks: [],
}

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function prepareGame(spec, dir) {
  await rm(dir, { recursive: true, force: true })
  const project = await createProject(dir, { title: spec.title, template: spec.template, orientation: spec.orientation })
  // Short round so the acceptance run does not wait a minute.
  project.rules = { ...project.rules, duration: 6 }
  await writeJson(paths.manifest(dir), project)
  await updateCommerce(dir, {
    enabled: true,
    interstitial: AD_UNITS.interstitial,
    rewarded: AD_UNITS.rewarded,
    analytics: true,
  })
  return project
}

async function playExported(spec, exportedDir, shotsDir) {
  const mock = await openMockPage(exportedDir)
  if (!mock) return { skipped: true }
  const shot = (name) => join(shotsDir, `${spec.id}-${name}.png`)
  try {
    const page = mock.page
    await page.waitForFunction('window.__G && window.__G.__gameState', undefined, { timeout: 20000 })
    const titleState = await page.evaluate(() => window.__G.__gameState())
    await page.screenshot({ path: shot('title') })
    await page.waitForTimeout(900)
    await page.evaluate(() => window.__touch({ changedTouches: [{ identifier: 1, clientX: 250, clientY: 700 }] }))
    await page.waitForFunction('window.__G.__gameState().phase === "playing"', undefined, { timeout: 20000 })
    await page.waitForTimeout(1200)
    const playingState = await page.evaluate(() => window.__G.__gameState())
    const metrics = await page.evaluate(() => window.__G.__wechatRuntime.metrics())
    const quality = await page.evaluate(() => window.__G.__wechatRuntime.quality)
    await page.screenshot({ path: shot('playing') })
    return { skipped: false, titlePhase: titleState.phase, playingPhase: playingState.phase, metrics, quality, errors: mock.errors, shots: [shot('title'), shot('playing')] }
  } finally {
    await mock.close()
  }
}

await rm(outRoot, { recursive: true, force: true })
const shotsDir = join(outRoot, 'screens')
await mkdir(shotsDir, { recursive: true })

for (const spec of GAMES) {
  const dir = join(outRoot, 'games', spec.title.toLowerCase().replace(/[^a-z0-9]+/gu, '-'))
  await prepareGame(spec, dir)
  const exported = await exportWechat(dir, { appid: 'touristappid' })
  const play = await playExported(spec, exported.dir, shotsDir)
  check(`${spec.id}: export produced an importable project`, exported.files.includes('game.js') && exported.files.includes('project.config.json'), `${exported.bytes} bytes`)
  check(`${spec.id}: export fits the 4 MB main package`, exported.report.totalBytes < 4 * 1024 * 1024, `${(exported.report.totalBytes / 1048576).toFixed(2)} MB`)
  if (play.skipped) {
    check(`${spec.id}: booted in the mock wx harness`, false, 'no Chrome or Edge installed')
  } else {
    check(`${spec.id}: reached the title screen`, play.titlePhase === 'title', play.titlePhase)
    check(`${spec.id}: started on a tap`, play.playingPhase === 'playing', play.playingPhase)
    check(`${spec.id}: no page errors`, play.errors.length === 0, play.errors.join(' | ').slice(0, 200))
  }
  // Release materials and the pre-review check go next to the export.
  await updateRelease(dir, { ageRating: '8+', category: '游戏 > 休闲游戏', monetization: 'iaa', gameName: spec.title })
  const materials = await releaseMaterials(dir, {
    exportDir: exported.dir,
    manifestTitle: spec.title,
    style: spec.template === 'voxel' ? 'low-poly voxel' : 'watercolor storybook',
    orientation: spec.orientation,
  })
  const review = await reviewGuide(dir, { exportDir: exported.dir })
  report.games.push({
    id: spec.id,
    title: spec.title,
    template: spec.template,
    project: dir,
    export: {
      dir: exported.dir,
      bytes: exported.bytes,
      subpackage: exported.subpackage,
      monetization: exported.monetization,
      report: { totalBytes: exported.report.totalBytes, warnings: exported.report.warnings, suggestions: exported.report.suggestions },
      files: exported.files,
    },
    play,
    materials: materials.file,
    review: { file: review.file, risks: review.risks },
  })
  check(`${spec.id}: release materials written`, materials.file.endsWith('RELEASE.md'), materials.file)
  check(`${spec.id}: pre-review risks listed`, review.risks.length > 0, review.risks.map(risk => risk.id).join(', '))
}

report.finishedAt = new Date().toISOString()
report.passed = report.checks.every(entry => entry.ok)
await writeFile(join(outRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const lines = [
  `# WeChat acceptance run — ${report.passed ? 'PASS' : 'FAIL'}`,
  '',
  `- plugin ${report.plugin} · node ${report.node}`,
  `- ${report.startedAt} → ${report.finishedAt}`,
  '',
  '## Checks',
  '',
  ...report.checks.map(entry => `- ${entry.ok ? '✅' : '❌'} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`),
  '',
  '## Games',
  '',
  '| game | template | export | boot | playing | fps | risks |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...report.games.map(game => `| ${game.title} | ${game.template} | ${(game.export.bytes / 1024).toFixed(0)} KB | ${game.play.skipped ? 'skipped' : game.play.titlePhase} | ${game.play.skipped ? '—' : game.play.playingPhase} | ${game.play.metrics?.fps ?? '—'} | ${game.review.risks.map(risk => risk.id).join(', ')} |`),
  '',
  'Screenshots: `screens/`. Machine-readable report: `report.json`.',
  '',
]
await writeFile(join(outRoot, 'REPORT.md'), lines.join('\n'), 'utf8')
console.log(`\n${report.passed ? 'acceptance PASS' : 'acceptance FAIL'} → ${outRoot}`)
if (!report.passed) process.exitCode = 1

