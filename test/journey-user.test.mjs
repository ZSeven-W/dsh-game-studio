// One user journey, in order, against the host layer: create → export → launch
// wizard → materials → review → monetization → the two "needs your account" calls
// → the help text. The individual pieces have their own tests; this one fails if
// the journey as a non-coder walks it stops fitting together.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PNG } from 'pngjs'

const stub = `data:text/javascript,${encodeURIComponent('export function defineTool(definition) { return definition }')}`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: stub, shortCircuit: true }
    return next(specifier, context)
  },
})

const { apply } = await import('../src/index.ts')

test('a non-coder journey: create, export, wizard, materials, monetization, help', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'game-studio-journey-user-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const tools = new Map()
  const commands = new Map()
  const services = {
    credentials: { resolve: async () => ({ value: 'stub', source: 'journey' }) },
    commands: { register: (command) => commands.set(command.name, command) },
  }
  apply({
    effect: (scope) => scope(),
    tools: { register: (tool) => tools.set(tool.name, tool) },
    workingDirectory: { ensure: async () => root },
    get: (name) => services[name],
    inject(names, callback) {
      if (names.every((name) => services[name] !== undefined)) callback({ ...services, effect() {} })
    },
  }, {})
  const run = (input) => commands.get('game-studio').handler({ agent: { id: 'journey' }, rawInput: input })
  const game = join(root, 'moon-garden')

  // 1. One sentence and a template.
  const created = await tools.get('game_studio_create').execute({ path: game, title: 'Moon Garden' }, { agent: { id: 'journey' } })
  assert.equal(created?.title, 'Moon Garden')

  // 2. Art that exports without a browser.
  const manifest = JSON.parse(await readFile(join(game, 'game.json'), 'utf8'))
  for (const [slot, spec] of Object.entries(manifest.slots)) {
    const png = new PNG({ width: spec.size[0], height: spec.size[1] })
    png.data.fill(140)
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255
    const file = `assets/${slot}.png`
    await writeFile(join(game, file), PNG.sync.write(png))
    spec.file = file
  }
  await writeFile(join(game, 'game.json'), JSON.stringify(manifest, null, 2))

  // 3. 侧栏「导出微信小游戏」.
  const exported = await run(`export-wechat ${JSON.stringify({ project: game, appid: 'touristappid' })}`)
  assert.equal(exported.kind, 'success', exported.text)
  const view = JSON.parse(exported.text)
  for (const file of ['game.js', 'game.json', 'project.config.json']) assert.ok(view.files.includes(file), file)

  // 4. 侧栏「上线向导」.
  const status = await run(`wechat-release ${JSON.stringify({ project: game, op: 'status' })}`)
  assert.equal(status.kind, 'success', status.text)
  assert.equal(JSON.parse(status.text).steps.length, 15)

  // 5. Materials and the pre-review.
  const materials = JSON.parse((await run(`wechat-release ${JSON.stringify({ project: game, op: 'materials' })}`)).text)
  const materialsText = await readFile(materials.file, 'utf8')
  assert.match(materialsText, /## English summary/u)
  assert.match(materialsText, /## 9\. 上线前检查/u)
  const review = JSON.parse((await run(`wechat-release ${JSON.stringify({ project: game, op: 'review' })}`)).text)
  assert.ok(review.risks.some((risk) => risk.id === 'appid'), 'a tourist AppID is a known risk')
  // Both files are now on disk, and the status says so, so the sidebar can show it.
  const afterFiles = JSON.parse((await run(`wechat-release ${JSON.stringify({ project: game, op: 'status' })}`)).text)
  assert.ok(afterFiles.materialsAt, 'the status remembers the generated materials')
  assert.ok(afterFiles.reviewAt, 'the status remembers the generated review')

  // 6. 侧栏「商业化」: off by default, a malformed ad unit names the format.
  const commerce = JSON.parse((await run(`wechat-commerce ${JSON.stringify({ project: game, op: 'status' })}`)).text)
  assert.equal(commerce.enabled, false)
  const badUnit = await run(`wechat-commerce ${JSON.stringify({ project: game, op: 'configure', enabled: true, interstitial: 'nope' })}`)
  assert.equal(badUnit.kind, 'error')
  assert.match(badUnit.text, /adunit-/u)

  // 7. The two calls that need the user's account explain themselves.
  const doctor = await run(`wechat-devtools ${JSON.stringify({ project: game, op: 'doctor' })}`)
  assert.equal(doctor.kind, 'success', doctor.text)
  const environment = JSON.parse(doctor.text)
  assert.equal(typeof environment.cliFound, 'boolean')
  assert.equal(typeof environment.portOpen, 'boolean')
  assert.equal(environment.tourist, true, 'the exported project still uses the tourist AppID')
  assert.ok(Array.isArray(environment.hints) && environment.hints.length > 0, 'the doctor always explains something')
  const devtools = await run(`wechat-devtools ${JSON.stringify({ project: game, op: 'preview' })}`)
  assert.equal(devtools.kind, 'error')
  assert.match(devtools.text, /(DevTools|服务端口|port)/u)
  const ci = await run(`wechat-ci ${JSON.stringify({ project: game })}`)
  assert.equal(ci.kind, 'error')
  assert.match(ci.text, /AppID/u)

  // 8. Typing /game-studio alone lists the actions.
  const help = await run('')
  assert.equal(help.kind, 'success')
  assert.match(help.text, /wechat-devtools/u)
})
