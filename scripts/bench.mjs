// Performance benchmark for the WeChat export: build one 2D and one 3D game,
// export them, boot them in the mock-wx harness, play for a fixed time and record
// frame rate, boot time, device tier and memory warnings.
//
//   npm run bench                                  # 20 s per template, high-end profile
//   BENCH_TIER=low npm run bench                   # low-end profile (30 fps cap)
//   node scripts/bench.mjs --seconds 30 --tier low # direct invocation with flags
//
// Headless Chrome renders WebGL in software, so the 3D numbers are a lower bound:
// compare runs against each other, not against a phone.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProject, loadManifest } from '../src/project.ts'
import { exportWechat } from '../src/wechat.ts'
import { openMockPage } from '../test/wechat-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const outDir = resolve(repo, '..', 'artifacts', 'bench')
const args = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
// npm on Windows drops the flag names after `--`, so env vars are the portable
// way to change the run; the flags stay for `node scripts/bench.mjs ...`.
const seconds = Math.max(5, Number(process.env.BENCH_SECONDS ?? value('--seconds', '20')) || 20)
const tier = (process.env.BENCH_TIER ?? value('--tier', 'high')) === 'low' ? 'low' : 'high'
const profile = tier === 'low' ? { benchmarkLevel: 5, pixelRatio: 3 } : { benchmarkLevel: 40, pixelRatio: 3 }

const GAMES = [
  { id: '2d', title: 'Bench Garden', template: 'collector' },
  { id: '3d', title: 'Bench Isle', template: 'voxel' },
]

const report = { at: new Date().toISOString(), seconds, tier, node: process.version, games: [] }

async function bench(spec) {
  const root = await mkdtemp(join(repo, '..', '.bench-'))
  const dir = join(root, spec.title.toLowerCase().replace(/[^a-z0-9]+/gu, '-'))
  try {
    const project = await createProject(dir, { title: spec.title, template: spec.template })
    // Long round: the game must still be playing when the measurement ends.
    project.rules = { ...project.rules, duration: seconds + 120 }
    await writeFile(join(dir, 'game.json'), `${JSON.stringify(project, null, 2)}\n`)
    const manifest = await loadManifest(dir)

    const exported = await exportWechat(dir, { appid: 'touristappid' })
    const mock = await openMockPage(exported.dir, profile)
    if (!mock) return { skipped: true, reason: 'no Chrome or Edge installed' }

    const page = mock.page
    try {
      await page.waitForFunction('window.__G && window.__G.__gameState && window.__G.__gameState().phase === "title"', undefined, { timeout: 20000 })
      await page.waitForTimeout(900)
      await page.evaluate(() => window.__touch({ changedTouches: [{ identifier: 1, clientX: 250, clientY: 700 }] }))
      await page.waitForFunction('window.__G.__gameState().phase === "playing"', undefined, { timeout: 20000 })

      // bootMs is only final once the first frame has run, i.e. after the game starts.
      await page.waitForFunction('window.__G.__wechatRuntime.metrics().bootMs !== null', undefined, { timeout: 20000 })
      const bootMs = await page.evaluate(() => window.__G.__wechatRuntime.metrics().bootMs)
      const samples = []
      let previousFrames = await page.evaluate(() => window.__G.__wechatRuntime.metrics().frames)
      for (let second = 1; second <= seconds; second += 1) {
        await page.waitForTimeout(1000)
        const metrics = await page.evaluate(() => window.__G.__wechatRuntime.metrics())
        samples.push({ second, fps: metrics.fps, frames: metrics.frames, delta: metrics.frames - previousFrames })
        previousFrames = metrics.frames
      }
      const summary = await page.evaluate(() => window.__G.__wechatRuntime.summary())
      const quality = await page.evaluate(() => window.__G.__wechatRuntime.quality)
      const phases = await page.evaluate(() => window.__G.__gameState().phase)

      const fps = samples.map((sample) => sample.fps).filter((value) => value > 0)
      const sorted = [...fps].sort((a, b) => a - b)
      const result = {
        id: spec.id,
        title: spec.title,
        template: spec.template,
        renderer: spec.template === 'voxel' ? 'webgl' : 'canvas2d',
        bytes: exported.bytes,
        bootMs,
        tier: quality.tier,
        dprCap: quality.dprCap,
        fpsAvg: fps.length > 0 ? Math.round(fps.reduce((sum, value) => sum + value, 0) / fps.length) : 0,
        fpsMedian: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0,
        fpsMin: sorted.length > 0 ? sorted[0] : 0,
        samples,
        memoryWarnings: summary.memoryWarnings,
        rounds: summary.rounds,
        phase: phases,
        errors: mock.errors,
      }
      console.log(`${spec.id}: ${result.fpsAvg} fps avg (min ${result.fpsMin}) · boot ${bootMs} ms · tier ${result.tier} · ${result.errors.length} errors`)
      return result
    } finally {
      await mock.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await mkdir(outDir, { recursive: true })
for (const spec of GAMES) {
  const result = await bench(spec)
  report.games.push(result)
}

await writeFile(join(outDir, `bench-${tier}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
const lines = [
  '# WeChat export benchmark',
  '',
  `- ${report.at} · node ${report.node} · ${seconds}s per game · ${tier} profile (benchmarkLevel ${profile.benchmarkLevel}, pixelRatio ${profile.pixelRatio})`,
  '- Headless Chrome uses software WebGL; 3D numbers are a lower bound. Compare runs, not phones.',
  '',
  '| game | renderer | fps avg | fps min | boot ms | tier | memory warnings | errors |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...report.games.map((game) => game.skipped
    ? `| ${game.id} | — | skipped: ${game.reason} | | | | | |`
    : `| ${game.title} | ${game.renderer} | ${game.fpsAvg} | ${game.fpsMin} | ${game.bootMs} | ${game.tier} | ${game.memoryWarnings} | ${game.errors.length} |`),
  '',
  `Machine-readable samples: \`bench-${tier}.json\`.`,
  '',
]
await writeFile(join(outDir, `BENCH-${tier}.md`), lines.join('\n'), 'utf8')
console.log(`\nbenchmark written to ${outDir}`)
