// Smoke-test the INSTALLED plugin (the one DSH actually loads), not the sources:
// boot it the way the host does, create a game, export the WeChat project, run
// the wizard/materials/review/commerce commands and boot the exported game in the
// mock-wx harness.
//
//   npm run installed                       # default desktop profile install
//   npm run installed -- --path <install>   # another install directory
//   npm run installed -- --no-browser       # skip the runtime boot
//
// The game is created in a temporary folder next to the checkout and removed
// afterwards unless --keep is passed.
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'
import { PNG } from 'pngjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const args = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const installDir = resolve(value('--path', process.env.DSH_GAME_STUDIO_INSTALL
  ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@zseven-w', 'dsh-game-studio')))
const withBrowser = !args.includes('--no-browser')
const keep = args.includes('--keep')
const entry = join(installDir, 'lib', 'index.js')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(entry)) {
  console.error(`No installed plugin at ${entry}. Pass --path <install directory>.`)
  process.exit(1)
}
console.log(`installed plugin: ${JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version}`)

// The host packages are not part of the installed bundle; stub the one entry point
// the plugin imports (defineTool) exactly like the host does at runtime.
const toolsStub = `data:text/javascript,${encodeURIComponent('export function defineTool(definition) { return definition }')}`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: toolsStub, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

// The plugin only accepts paths inside the session working directory, so the
// smoke game lives inside a temporary workspace and that workspace is the cwd.
const root = await mkdtemp(join(repo, '..', '.installed-check-'))

const host = await import(pathToFileURL(entry).href)
const tools = new Map()
const commands = new Map()
const services = {
  credentials: { resolve: async () => ({ value: 'stub', source: 'installed-check' }) },
  commands: { register: (command) => commands.set(command.name, command) },
}
const ctx = {
  effect: (scope) => scope(),
  tools: { register: (tool) => tools.set(tool.name, tool) },
  workingDirectory: { ensure: async () => root },
  get: (name) => services[name],
  inject(names, callback) {
    if (names.every((name) => services[name] !== undefined)) callback({ ...services, effect() {} })
  },
}
host.apply(ctx, {})

const wechatTools = [...tools.keys()].filter((name) => name.startsWith('game_studio_wechat')
  || name === 'game_studio_export_wechat')
check('the installed build registers the WeChat tools', wechatTools.length === 5, wechatTools.join(', '))
check('the /game-studio command is registered', commands.has('game-studio'))

const run = (input) => commands.get('game-studio').handler({ agent: { id: 'installed-check' }, rawInput: input })

const game = join(root, 'smoke-game')
try {
  const created = await tools.get('game_studio_create').execute({ path: game, title: 'Installed Smoke' }, { agent: { id: 'installed-check' } })
  check('create builds a playable project', Boolean(created), (created && created.title) || '')

  // Swap SVG placeholders for PNG art so the export does not need a browser.
  const manifestPath = join(game, 'game.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const [slot, spec] of Object.entries(manifest.slots)) {
    const file = `assets/${slot}.png`
    const png = new PNG({ width: spec.size[0], height: spec.size[1] })
    png.data.fill(180)
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255
    await writeFile(join(game, file), PNG.sync.write(png))
    spec.file = file
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  const exported = await run(`export-wechat ${JSON.stringify({ project: game, appid: 'touristappid' })}`)
  const view = exported.kind === 'success' ? JSON.parse(exported.text) : null
  check('export-wechat writes the mini-game project', exported.kind === 'success'
    && ['game.js', 'game.json', 'project.config.json'].every((file) => view.files.includes(file)),
  exported.kind === 'success' ? `${view.files.length} files, ${view.bytes} bytes` : String(exported.text).slice(0, 160))

  const status = await run(`wechat-release ${JSON.stringify({ project: game, op: 'status' })}`)
  const statusView = status.kind === 'success' ? JSON.parse(status.text) : null
  check('the launch wizard has its 15 steps', status.kind === 'success' && statusView.steps.length === 15,
    status.kind === 'success' ? `${statusView.progress.done}/${statusView.progress.total}, next ${statusView.next[0]?.id}` : String(status.text).slice(0, 160))

  const materials = await run(`wechat-release ${JSON.stringify({ project: game, op: 'materials' })}`)
  check('release materials are written', materials.kind === 'success' && JSON.parse(materials.text).file.endsWith('RELEASE.md'))

  const review = await run(`wechat-release ${JSON.stringify({ project: game, op: 'review' })}`)
  check('the pre-review lists risks', review.kind === 'success' && JSON.parse(review.text).risks.length > 0,
    review.kind === 'success' ? JSON.parse(review.text).risks.map((risk) => risk.id).join(', ') : '')

  const commerce = await run(`wechat-commerce ${JSON.stringify({ project: game, op: 'status' })}`)
  check('monetization starts off', commerce.kind === 'success' && JSON.parse(commerce.text).enabled === false)

  if (withBrowser) {
    const { openMockPage } = await import(pathToFileURL(join(repo, 'test', 'wechat-harness.mjs')).href)
    const mock = view ? await openMockPage(view.dir) : null
    if (!mock) {
      check('the exported game boots on a mocked wx', false, 'no Chrome or Edge installed')
    } else {
      try {
        await mock.page.waitForFunction('window.__G && window.__G.__gameState', undefined, { timeout: 20000 })
        const phase = await mock.page.evaluate(() => window.__G.__gameState().phase)
        check('the exported game boots on a mocked wx', phase === 'title', `phase ${phase}`)
        check('no page errors while booting', mock.errors.length === 0, mock.errors.join(' | ').slice(0, 200))
      } finally {
        await mock.close()
      }
    }
  }
} finally {
  if (!keep) await rm(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}

const failed = checks.filter((entry) => !entry.ok)
console.log(`\n${failed.length === 0 ? 'installed build PASS' : `installed build FAIL (${failed.length})`}`)
if (failed.length > 0) process.exitCode = 1
