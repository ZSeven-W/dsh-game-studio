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
// not copied, so a passing acceptance run means the shipped adapter works. It is
// also the regression check to re-run after an upstream update.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProject, paths } from '../src/project.ts'
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
  { id: '2d', title: 'Moon Garden', template: 'collector', orientation: 'portrait', renderer: null },
  { id: '3d', title: 'Lantern Isle', template: 'voxel', orientation: 'portrait', renderer: 'webgl' },
]

const report = {
  startedAt: new Date().toISOString(),
  node: process.version,
  plugin: JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version,
  output: outRoot,
  games: [],
  checks: [],
}

function check(name, ok, detail = '', skipped = false) {
  report.checks.push({ name, ok: skipped ? true : ok, skipped, detail })
  const mark = skipped ? 'SKIP' : ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function prepareGame(spec, dir) {
  await rm(dir, { recursive: true, force: true })
  const project = await createProject(dir, { title: spec.title, template: spec.template, orientation: spec.orientation })
  // Short round so the run can reach the end screen even on software-rendered 3D.
  project.rules = { ...project.rules, duration: 2 }
  await writeJson(paths.manifest(dir), project)
  await updateRelease(dir, { ageRating: '8+', category: '游戏 > 休闲游戏', monetization: 'both', gameName: spec.title })
  // The licence and merchant ID are recorded above, so the wizard step is done too.
  await updateRelease(dir, { step: 'iap' })
  await updateCommerce(dir, {
    iapEnabled: true,
    licenseNumber: 'ISBN 978-7-498-12345-6',
    merchantId: '1900000109',
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
    await page.screenshot({ path: shot('title') })
    const titleState = await page.evaluate(() => window.__G.__gameState())
    await page.waitForTimeout(900)
    await page.evaluate(() => window.__touch({ changedTouches: [{ identifier: 1, clientX: 250, clientY: 700 }] }))
    await page.waitForFunction('window.__G.__gameState().phase === "playing"', undefined, { timeout: 20000 })
    await page.waitForTimeout(1200)
    const playingState = await page.evaluate(() => window.__G.__gameState())
    const metrics = await page.evaluate(() => window.__G.__wechatRuntime.metrics())
    const quality = await page.evaluate(() => window.__G.__wechatRuntime.quality)
    // Everything below is what a real device would exercise; each probe is
    // asserted as its own check so a regression names the broken capability.
    const iap = await page.evaluate(async () => {
      try {
        const result = await window.__G.__commerce.iap.buy('gem-10')
        return { dryRun: result && result.dryRun === true }
      } catch (error) {
        return { dryRun: false, error: String((error && error.message) || error) }
      }
    })
    const probe = await page.evaluate(async () => {
      const toneOk = window.__G.__wechatRuntime.playTone(440, 0.05, 'sine', 0.05)
      await new Promise((resolve) => setTimeout(resolve, 150))
      return {
        toneOk,
        audioPlayed: window.__wxAudio ? window.__wxAudio.played.length : 0,
        audioFiles: window.__wxAudio ? window.__wxAudio.files.length : 0,
        ads: window.__wxAds ? { interstitial: window.__wxAds.interstitial, rewarded: window.__wxAds.rewarded } : null,
        edits: window.__wxAds ? window.__wxAds.events.map((entry) => entry.id) : [],
      }
    })
    await page.screenshot({ path: shot('playing') })
    // Let the round actually finish: that is what makes round_end and the
    // between-rounds interstitial observable instead of merely configured.
    await page.waitForFunction('window.__G.__gameState().phase !== "playing"', undefined, { timeout: 20000 }).catch(() => undefined)
    await page.waitForTimeout(1500)
    const summary = await page.evaluate(() => window.__G.__wechatRuntime.summary())
    return {
      skipped: false,
      titlePhase: titleState.phase,
      playingPhase: playingState.phase,
      state: playingState,
      metrics,
      quality,
      probe,
      iap,
      summary,
      errors: mock.errors,
      shots: [shot('title'), shot('playing')],
    }
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

  check(`${spec.id}: export produced an importable project`,
    exported.files.includes('game.js') && exported.files.includes('project.config.json'), `${exported.bytes} bytes`)
  check(`${spec.id}: export fits the 4 MB main package`,
    exported.report.totalBytes < 4 * 1024 * 1024, `${(exported.report.totalBytes / 1048576).toFixed(2)} MB`)

  if (play.skipped) {
    for (const name of ['booted in the mock wx harness', 'reached the title screen', 'started on a tap', 'no page errors', 'audio plays a tone', 'no ad is forced at boot', 'device tier reported']) {
      check(`${spec.id}: ${name}`, false, 'no Chrome or Edge installed', true)
    }
  } else {
    check(`${spec.id}: booted in the mock wx harness`, play.titlePhase === 'title', play.titlePhase)
    check(`${spec.id}: started on a tap`, play.playingPhase === 'playing', play.playingPhase)
    check(`${spec.id}: no page errors`, play.errors.length === 0, play.errors.join(' | ').slice(0, 200))
    check(`${spec.id}: audio plays a tone`, play.probe.toneOk === true && play.probe.audioPlayed >= 1,
      `${play.probe.audioFiles} wav, ${play.probe.audioPlayed} played`)
    check(`${spec.id}: no ad is forced at boot`,
      play.probe.ads !== null && play.probe.ads.interstitial === 0 && play.probe.ads.rewarded === 0,
      JSON.stringify(play.probe.ads))
    check(`${spec.id}: demo purchase returns dryRun`, play.iap.dryRun === true, play.iap.error || 'dryRun')
    check(`${spec.id}: a finished round is counted`,
      play.summary.rounds >= 1 && play.summary.completedRounds >= 1 && play.summary.avgRoundSeconds >= 1.5,
      'rounds ' + play.summary.rounds + ', completed ' + play.summary.completedRounds + ', avg ' + play.summary.avgRoundSeconds + 's')
    check(`${spec.id}: interstitial follows a finished round`, play.summary.adShows >= 1, 'shows ' + play.summary.adShows)
    check(`${spec.id}: the dry-run purchase is counted`, play.summary.dryRuns >= 1, 'dryRuns ' + play.summary.dryRuns)
    check(`${spec.id}: device tier reported`, Boolean(play.quality?.tier), `${play.quality?.tier} · cap ${play.quality?.dprCap}x`)
    if (spec.renderer) {
      check(`${spec.id}: renders through WebGL`, play.state.renderer === spec.renderer, play.state.renderer)
    }
  }

  // Release materials and the pre-review check go next to the export.
  await updateRelease(dir, { ageRating: '8+', category: '游戏 > 休闲游戏', monetization: 'both', gameName: spec.title })
  const materials = await releaseMaterials(dir, {
    exportDir: exported.dir,
    manifestTitle: spec.title,
    style: spec.template === 'voxel' ? 'low-poly voxel' : 'watercolor storybook',
    orientation: spec.orientation,
  })
  const review = await reviewGuide(dir, { exportDir: exported.dir })
  check(`${spec.id}: release materials written`, materials.file.endsWith('RELEASE.md'), materials.file)
  check(`${spec.id}: pre-review risks listed`, review.risks.length > 0, review.risks.map((risk) => risk.id).join(', '))

  // The copy-paste material must name the same ads and rating the game carries.
  const gameJs = await readFile(join(exported.dir, 'game.js'), 'utf8')
  const materialsText = await readFile(materials.file, 'utf8')
  const units = [exported.monetization?.interstitial, exported.monetization?.rewarded].filter(Boolean)
  const rating = (gameJs.match(/"ageRating":"([^"]+)"/u) ?? [])[1]
  const agree = units.every((id) => gameJs.includes(id) && materialsText.includes(id))
    && (!rating || materialsText.includes('适龄级别：' + rating))
  check(spec.id + ': materials match the export (ads, age rating)', agree,
    units.length + ' ad units' + (rating ? ', rating ' + rating : ''))

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
}

report.finishedAt = new Date().toISOString()
const counted = report.checks.filter((entry) => !entry.skipped)
report.passed = counted.every((entry) => entry.ok)
report.summary = {
  passed: counted.filter((entry) => entry.ok).length,
  failed: counted.filter((entry) => !entry.ok).length,
  skipped: report.checks.filter((entry) => entry.skipped).length,
}
await writeFile(join(outRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const icon = (entry) => entry.skipped ? '⏭️' : entry.ok ? '✅' : '❌'
const lines = [
  `# WeChat acceptance run — ${report.passed ? 'PASS' : 'FAIL'}`,
  '',
  `- plugin ${report.plugin} · node ${report.node}`,
  `- ${report.summary.passed} passed · ${report.summary.failed} failed · ${report.summary.skipped} skipped`,
  `- ${report.startedAt} → ${report.finishedAt}`,
  '',
  '## Checks',
  '',
  ...report.checks.map((entry) => `- ${icon(entry)} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`),
  '',
  '## Games',
  '',
  '| game | template | export | boot | playing | fps | tier | risks |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...report.games.map((game) => `| ${game.title} | ${game.template} | ${(game.export.bytes / 1024).toFixed(0)} KB | ${game.play.skipped ? 'skipped' : game.play.titlePhase} | ${game.play.skipped ? '—' : game.play.playingPhase} | ${game.play.metrics?.fps ?? '—'} | ${game.play.quality?.tier ?? '—'} | ${game.review.risks.map((risk) => risk.id).join(', ')} |`),
  '',
  'Screenshots: `screens/`. Machine-readable report: `report.json`.',
  '',
]
await writeFile(join(outRoot, 'REPORT.md'), lines.join('\n'), 'utf8')
console.log(`\n${report.passed ? 'acceptance PASS' : 'acceptance FAIL'} (${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped) → ${outRoot}`)
if (!report.passed) process.exitCode = 1
