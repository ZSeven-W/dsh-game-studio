// The built Host plugin (lib/index.js) driven through its tools with a stand-in
// Harness context and a local fake of the OpenAI image endpoint, so the
// spend-approval gate, candidate numbering and wiring are checked as shipped.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PNG } from 'pngjs'

// The Harness supplies @deepseek-ai/dsh-tools; here defineTool only needs to hand the definition back.
const toolsStub = `data:text/javascript,${encodeURIComponent('export function defineTool(definition) { return definition }')}`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: toolsStub, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const host = await import('../lib/index.js')

function spritePng() {
  const image = new PNG({ width: 256, height: 256 })
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const inside = (x - 128) ** 2 + (y - 128) ** 2 <= 80 ** 2
      image.data.set([200, 90, 40, inside ? 255 : 0], (y * 256 + x) * 4)
    }
  }
  return PNG.sync.write(image).toString('base64')
}

/** Fake OpenAI image endpoint that records every request it is billed for. */
async function fakeOpenAI(t, { resets = 0 } = {}) {
  const requests = []
  const image = spritePng()
  let dropped = 0
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => { chunks.push(chunk) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const type = req.headers['content-type'] ?? ''
      const body = type.includes('json') ? JSON.parse(raw.toString('utf8')) : {}
      // Multipart edits: pull the plain fields out of the form for the assertions.
      if (type.includes('multipart')) {
        for (const match of raw.toString('latin1').matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/gu)) body[match[1]] = match[2]
      }
      requests.push(Object.assign(body, { url: req.url, contentType: type, raw }))
      // A flaky proxy: the first `resets` requests lose their connection with no answer.
      if (dropped < resets) { dropped += 1; req.socket.destroy(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'gpt-image-2.5-flare', data: [{ b64_json: image }], usage: { input_tokens: 240, output_tokens: 196 } }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests }
}

/** A minimal Harness context: tools, a working directory and the optional services the plugin injects. */
async function harness(t, { approval, config = {}, extra = {}, agent = {}, resets = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'game-studio-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const openai = await fakeOpenAI(t, { resets })
  const tools = new Map()
  const commands = new Map()
  const services = {
    credentials: { resolve: async () => ({ value: 'sk-test-only', source: 'test' }) },
    commands: { register: (cmd) => { commands.set(cmd.name, cmd) } },
    ...(approval ? { approval } : {}),
    ...extra,
  }
  const disposers = []
  const ctx = {
    // cordis effects: run the setup, dispose when the test ends.
    effect(setup) { const dispose = setup(); disposers.push(dispose); t.after(() => dispose?.()) },
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    workingDirectory: { ensure: async () => root },
    get: (name) => services[name],
    inject(names, callback) {
      if (names.every(name => services[name] !== undefined)) callback({ ...services, effect() {} })
    },
  }
  host.apply(ctx, { openaiBaseUrl: openai.baseUrl, imageProvider: 'openai', ...config })
  const exec = { agent: { id: 'session-1', ...agent }, callId: 'call-1', signal: new AbortController().signal }
  const call = (name, args) => tools.get(name).execute(args, exec)
  const runCommand = (rawInput) => commands.get('game-studio').handler({ agent: exec.agent, rawInput })
  const unload = () => { for (const dispose of disposers) dispose?.() }
  await call('game_studio_create', { path: 'game', title: 'Moon Garden' })
  return { root, openai, call, runCommand, unload, tools }
}

function approvalAnswering(outcome) {
  const asked = []
  return { asked, request: async (request) => { asked.push(request); return outcome } }
}

test('a declined spend sends nothing to the image service', async (t) => {
  const approval = approvalAnswering('rejected')
  const { openai, call } = await harness(t, { approval })
  await assert.rejects(call('game_studio_generate_asset', { path: 'game', slot: 'hero', prompt: 'a fox', count: 3, quality: 'low' }), /declined/u)
  assert.equal(openai.requests.length, 0)
  assert.equal(approval.asked.length, 1)
  assert.match(approval.asked[0].displayReason.zh, /3 张「Hero」.*预计约 \$0\.02/u)
  assert.equal(approval.asked[0].toolName, 'game_studio_generate_asset')
})

test('with nobody to approve, generation fails closed unless the owner turned the prompt off', async (t) => {
  const closed = await harness(t)
  await assert.rejects(closed.call('game_studio_generate_asset', { path: 'game', slot: 'hero', prompt: 'a fox', count: 1 }), /Nobody can approve/u)
  assert.equal(closed.openai.requests.length, 0)

  const open = await harness(t, { config: { confirmSpending: false } })
  const result = await open.call('game_studio_generate_asset', { path: 'game', slot: 'hero', prompt: 'a fox', count: 1, quality: 'low' })
  assert.equal(result.candidates.length, 1)
  assert.equal(open.openai.requests.length, 1)
})

test('an approved batch makes one varied request per candidate, numbered in request order', async (t) => {
  const approval = approvalAnswering('allowed-once')
  const { root, openai, call } = await harness(t, { approval })
  const result = await call('game_studio_generate_asset', { path: 'game', slot: 'hero', prompt: 'a fox', count: 3, quality: 'low' })
  assert.deepEqual(result.candidates.map(item => item.number), [1, 2, 3])
  assert.equal(openai.requests.length, 3)
  assert.deepEqual(openai.requests.map(request => request.n), [1, 1, 1])
  const takes = openai.requests.map(request => /Take (\d)/u.exec(request.prompt)?.[1]).sort()
  assert.deepEqual(takes, ['1', '2', '3'], 'each candidate asks for a different take')
  assert.equal(result.costUsd, 0.0212)

  const second = await call('game_studio_generate_asset', { path: 'game', slot: 'hero', prompt: 'a fox', count: 2, quality: 'low' })
  assert.deepEqual(second.candidates.map(item => item.number), [4, 5], 'numbers continue across batches')

  const applied = await call('game_studio_apply_asset', { path: 'game', slot: 'hero', candidate: '#2' })
  assert.equal(applied.number, 2)
  const state = JSON.parse(await readFile(join(root, 'game', '.studio', 'state.json'), 'utf8'))
  assert.deepEqual(state.slots.hero.candidates.map(item => item.number), [1, 2, 3, 4, 5])
  assert.equal(state.spend.openaiImages, 5)
  assert.equal(state.spend.openaiUsd, 0.0354)
})

test('a reference image goes to the image-edit endpoint as a file, and the approval says so', async (t) => {
  const approval = approvalAnswering('allowed-once')
  const { root, openai, call } = await harness(t, { approval })
  const reference = Buffer.from(spritePng(), 'base64')
  await writeFile(join(root, 'my-fox.png'), reference)
  const result = await call('game_studio_generate_asset', { path: 'game', slot: 'hero', prompt: 'a fox', count: 1, quality: 'low', reference: 'my-fox.png' })
  assert.equal(result.candidates.length, 1)
  const [request] = openai.requests
  assert.match(request.url, /\/images\/edits$/u)
  assert.match(request.contentType, /^multipart\/form-data/u)
  assert.ok(request.raw.includes(reference), 'the picture itself is uploaded')
  assert.match(request.raw.toString('latin1'), /filename="my-fox\.png"/u)
  assert.match(request.prompt, /Follow the attached reference image/u)
  assert.match(approval.asked[0].displayReason.zh, /参考图「my-fox\.png」/u)
  await assert.rejects(call('game_studio_generate_asset', { path: 'game', slot: 'hero', prompt: 'a fox', reference: '/etc/hosts' }), /working directory or a chat attachment/u)
})

test('a dropped connection is retried once, and a second drop says so without blaming a missing proxy', async (t) => {
  const saved = Object.fromEntries(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'].map(name => [name, process.env[name]]))
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
  for (const name of Object.keys(saved)) delete process.env[name]

  const once = await harness(t, { approval: approvalAnswering('allowed-once'), resets: 1 })
  const result = await once.call('game_studio_generate_asset', { path: 'game', slot: 'hero', prompt: 'a fox', count: 1, quality: 'low' })
  assert.equal(result.candidates.length, 1, 'the retry got the image')
  assert.equal(once.openai.requests.length, 2)

  const twice = await harness(t, { approval: approvalAnswering('allowed-once'), resets: 2 })
  await assert.rejects(twice.call('game_studio_generate_asset', { path: 'game', slot: 'hero', prompt: 'a fox', count: 1, quality: 'low' }),
    (error) => /also on a second try/u.test(error.message) && /start DSH with HTTPS_PROXY set/u.test(error.message))
  assert.equal(twice.openai.requests.length, 2, 'only one retry')

  // With a proxy configured, the hint must not tell the user to configure one.
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9'
  process.env.NO_PROXY = '127.0.0.1'
  const proxied = await harness(t, { approval: approvalAnswering('allowed-once'), resets: 2 })
  await assert.rejects(proxied.call('game_studio_generate_asset', { path: 'game', slot: 'hero', prompt: 'a fox', count: 1, quality: 'low' }),
    (error) => /through the proxy in HTTPS_PROXY/u.test(error.message) && !/start DSH with HTTPS_PROXY set/u.test(error.message))
})

test('the agent cannot open a phone link without the user\'s yes', async (t) => {
  const approval = approvalAnswering('rejected')
  const { root, call } = await harness(t, { approval })
  await assert.rejects(call('game_studio_share', { path: 'game', minutes: 10 }), /declined/u)
  assert.match(approval.asked[0].displayReason.zh, /局域网开放一个临时试玩链接 10 分钟/u)
  const state = JSON.parse(await readFile(join(root, 'game', '.studio', 'state.json'), 'utf8'))
  assert.equal(state.share, null)
})

const FAKE_HOST_CLOUDFLARED = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') process.exit(0)
if (process.env.FAKE_CLOUDFLARED_LOG) {
  appendFileSync(process.env.FAKE_CLOUDFLARED_LOG, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\\n')
}
process.on('SIGTERM', () => process.exit(0))
console.error('INF |  https://\\u001b[1mfake-abc\\u001b[22m.trycloudflare.com  |')
setInterval(() => {}, 60000)
`

let sharedHostCloudflared

async function makeFakeCloudflared(t) {
  if (!sharedHostCloudflared) {
    const binDir = await mkdtemp(join(tmpdir(), 'game-studio-cf-host-'))
    const bin = join(binDir, 'cloudflared')
    await writeFile(bin, FAKE_HOST_CLOUDFLARED)
    await chmod(bin, 0o755)
    spawnSync(bin, ['--version'])
    process.once('exit', () => { spawnSync('rm', ['-rf', binDir]) })
    sharedHostCloudflared = bin
  }
  const command = sharedHostCloudflared
  const dir = await mkdtemp(join(tmpdir(), 'game-studio-cf-log-'))
  const logFile = join(dir, 'calls.jsonl')
  await writeFile(logFile, '')
  process.env.FAKE_CLOUDFLARED_LOG = logFile
  const readCalls = async () => (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  t.after(async () => {
    delete process.env.FAKE_CLOUDFLARED_LOG
    const entries = await readCalls().catch(() => [])
    for (const entry of entries) {
      try { process.kill(entry.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    await rm(dir, { recursive: true, force: true })
  })
  return { command, readCalls }
}

test('public game_studio_share checks for cloudflared before asking for approval, and sidebar command omits agent-only instructions', async (t) => {
  const approval = approvalAnswering('allowed-once')
  const { root, call, runCommand } = await harness(t, { approval, config: { cloudflaredPath: join(tmpdir(), 'missing-cloudflared-bin') } })
  await assert.rejects(
    call('game_studio_share', { path: 'game', minutes: 10, public: true }),
    (err) => err.code === 'NO_TUNNEL'
      && /brew install cloudflared/u.test(err.message)
      && /Tell the user how to install it; do not download or install it yourself\./u.test(err.message),
  )
  assert.equal(approval.asked.length, 0, 'approval must not be asked when cloudflared is missing')
  const state = JSON.parse(await readFile(join(root, 'game', '.studio', 'state.json'), 'utf8'))
  assert.equal(state.share, null)

  const viaCommand = await runCommand(`share ${JSON.stringify({ project: join(root, 'game'), minutes: '30', scope: 'public' })}`)
  assert.equal(viaCommand.kind, 'error')
  assert.doesNotMatch(viaCommand.text, /do not download/iu)
  const payload = JSON.parse(viaCommand.text)
  assert.equal(payload.code, 'NO_TUNNEL')
  assert.equal(payload.platform, process.platform)
  assert.match(payload.install, /brew install cloudflared|winget install|developers\.cloudflare\.com/u)
})

test('declining a public share starts no cloudflared process and leaves state.share null', async (t) => {
  const { command, readCalls } = await makeFakeCloudflared(t)
  const approval = approvalAnswering('rejected')
  const { root, call } = await harness(t, { approval, config: { cloudflaredPath: command } })
  await assert.rejects(call('game_studio_share', { path: 'game', minutes: 15, public: true }), /declined/u)
  assert.equal(approval.asked.length, 1)
  assert.match(approval.asked[0].displayReason.zh, /公网.*15 分钟.*Cloudflare/u)
  assert.match(approval.asked[0].displayReason.en, /public link.*15 minutes.*Cloudflare/u)
  assert.deepEqual(await readCalls(), [], 'no cloudflared process may be started before approval')
  const state = JSON.parse(await readFile(join(root, 'game', '.studio', 'state.json'), 'utf8'))
  assert.equal(state.share, null)
})

test('approving a public share and using the /game-studio share command open and close the public tunnel', async (t) => {
  const { command, readCalls } = await makeFakeCloudflared(t)
  const approval = approvalAnswering('allowed-once')
  const { root, call, runCommand } = await harness(t, { approval, config: { cloudflaredPath: command } })
  const shared = await call('game_studio_share', { path: 'game', minutes: 20, public: true })
  assert.equal(shared.scope, 'public')
  assert.match(shared.url, /^https:\/\/fake-abc\.trycloudflare\.com\/[A-Za-z0-9_-]{24}\/$/u)
  assert.equal((await readCalls()).length, 1)
  const state1 = JSON.parse(await readFile(join(root, 'game', '.studio', 'state.json'), 'utf8'))
  assert.equal(state1.share?.scope, 'public')
  assert.equal(state1.share?.url, shared.url)

  const stopped = await call('game_studio_share', { path: 'game', stop: true })
  assert.equal(stopped.stopped, true)
  const state2 = JSON.parse(await readFile(join(root, 'game', '.studio', 'state.json'), 'utf8'))
  assert.equal(state2.share, null)

  // Sidebar button command (/game-studio share {"scope": "public"}) opens without asking approval again.
  const viaCommand = await runCommand(`share ${JSON.stringify({ project: join(root, 'game'), minutes: '30', scope: 'public' })}`)
  assert.equal(viaCommand.kind, 'success', viaCommand.text)
  assert.equal(approval.asked.length, 1, 'sidebar command does not prompt for approval')
  const payload = JSON.parse(viaCommand.text)
  assert.equal(payload.scope, 'public')
  assert.match(payload.url, /^https:\/\/fake-abc\.trycloudflare\.com\//u)
  const unshared = await runCommand(`unshare ${JSON.stringify({ project: join(root, 'game') })}`)
  assert.equal(unshared.kind, 'success')
})

test('/game-studio status keeps a live share reachable and clears stale state.json share after plugin unload', async (t) => {
  const { root, runCommand, unload } = await harness(t)
  const gameDir = join(root, 'game')
  const statePath = join(gameDir, '.studio', 'state.json')
  const heartbeatPath = join(gameDir, '.studio', 'share-alive.json')

  const opened = await runCommand(`share ${JSON.stringify({ project: gameDir, minutes: '15' })}`)
  assert.equal(opened.kind, 'success', opened.text)
  const liveShare = JSON.parse(opened.text)
  assert.equal(JSON.parse(await readFile(heartbeatPath, 'utf8')).url, liveShare.url)

  const aliveStatus = await runCommand(`status ${JSON.stringify({ project: gameDir })}`)
  assert.equal(aliveStatus.kind, 'success', aliveStatus.text)
  assert.equal(JSON.parse(aliveStatus.text).share?.url, liveShare.url)
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).share?.url, liveShare.url)
  const page = await fetch(liveShare.url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<title>Moon Garden<\/title>/u)

  // Simulate DSH restart / plugin unload: in-memory shares are stopped and heartbeat file is deleted without rewriting state.json.
  unload()
  await assert.rejects(readFile(heartbeatPath, 'utf8'), { code: 'ENOENT' })
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).share?.url, liveShare.url, 'stale share remains in state.json until status check')

  const afterUnload = await runCommand(`status ${JSON.stringify({ project: gameDir })}`)
  assert.equal(afterUnload.kind, 'success', afterUnload.text)
  assert.equal(JSON.parse(afterUnload.text).share, null)
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).share, null)
})

// ---------------------------------------------------------------- wechat release

test('/game-studio wechat-release reports the checklist, records steps and writes materials', async (t) => {
  const { root, runCommand } = await harness(t)
  const project = join(root, 'game')

  const initial = await runCommand(`wechat-release ${JSON.stringify({ project, op: 'status' })}`)
  assert.equal(initial.kind, 'success', initial.text)
  const view = JSON.parse(initial.text)
  assert.ok(view.progress.total > 0)
  assert.equal(view.progress.done, 0)
  assert.ok(view.steps.some(step => step.id === 'record' && step.owner === 'wechat'), 'filing is a console step')
  assert.ok(view.next.length > 0)

  const updated = await runCommand(`wechat-release ${JSON.stringify({ project, op: 'update', step: 'register', status: 'done' })}`)
  assert.equal(updated.kind, 'success', updated.text)
  assert.equal(JSON.parse(updated.text).progress.done, 1)
  assert.equal(JSON.parse(await readFile(join(project, '.studio', 'wechat-release.json'), 'utf8')).steps.register.status, 'done')

  const materials = await runCommand(`wechat-release ${JSON.stringify({ project, op: 'materials' })}`)
  assert.equal(materials.kind, 'success', materials.text)
  const text = await readFile(JSON.parse(materials.text).file, 'utf8')
  assert.match(text, /小游戏备案/u)
  assert.match(text, /适龄提示/u)
})

test('/game-studio wechat-devtools says to export first instead of guessing a path', async (t) => {
  const { root, runCommand } = await harness(t)
  const result = await runCommand(`wechat-devtools ${JSON.stringify({ project: join(root, 'game'), op: 'open' })}`)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /run the WeChat export first/u)
})

test('/game-studio wechat-commerce stores ad unit IDs and refuses a bad one', async (t) => {
  const { root, runCommand } = await harness(t)
  const project = join(root, 'game')

  const initial = await runCommand(`wechat-commerce ${JSON.stringify({ project, op: 'status' })}`)
  assert.equal(initial.kind, 'success', initial.text)
  assert.equal(JSON.parse(initial.text).embedded, null)

  const refused = await runCommand(`wechat-commerce ${JSON.stringify({ project, op: 'configure', enabled: true, interstitial: 'oops' })}`)
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /adunit-/u)

  const configured = await runCommand(`wechat-commerce ${JSON.stringify({ project, op: 'configure', enabled: true, interstitial: 'adunit-abc123def456' })}`)
  assert.equal(configured.kind, 'success', configured.text)
  assert.equal(JSON.parse(configured.text).embedded.interstitial, 'adunit-abc123def456')
})

// ---------------------------------------------------------------- playtest

/** Stand-ins for the Harness's attachment store and model catalog. */
function imageServices({ seesImages }) {
  const saved = []
  return {
    saved,
    extra: {
      attachments: {
        imageLimits: { maxImageBytes: 5_000_000, maxMessageImageBytes: 20_000_000 },
        saveImage: async ({ data, mediaType, name }) => {
          saved.push({ bytes: data.byteLength, mediaType, name })
          return { attachmentId: `att-${saved.length}`, mediaType, bytes: data.byteLength, width: 1, height: 1, name }
        },
      },
      llm: { resolveModelInfo: async () => ({ inputModalities: seesImages ? ['text', 'image'] : ['text'] }) },
    },
    agent: { session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'test-model' } }) } },
  }
}

const NO_BROWSER = /Chrome or Microsoft Edge/u

test('playtest plays the 3D game to its end screen with this-run-only rules and shows the model what it saw', { timeout: 180_000 }, async (t) => {
  const images = imageServices({ seesImages: true })
  const { root, call, tools } = await harness(t, images)
  await call('game_studio_create', { path: 'cube', title: 'Lantern Isle', template: 'voxel' })
  const before = {
    manifest: await readFile(join(root, 'cube', 'game.json'), 'utf8'),
    build: await readFile(join(root, 'cube', 'dist', 'index.html'), 'utf8'),
    versions: (await call('game_studio_versions', { path: 'cube' })).versions.length,
  }
  let result
  try { result = await call('game_studio_playtest', { path: 'cube', rules: '{"duration": 2}', portrait: false }) }
  catch (error) { if (NO_BROWSER.test(error.message)) return t.skip('no Chrome or Edge here'); throw error }

  assert.equal(result.finalPhase, 'won', result.summary)
  assert.equal(result.errors, 0, result.summary)
  assert.match(result.summary, /title@.*playing@.*won@/u)
  assert.match(result.summary, /rules for this run only: \{"duration":2\}/u)
  assert.doesNotMatch(result.summary, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), 'paths are relative to the project')
  // The model gets the character close-ups first, then the screens.
  assert.deepEqual(result.images.map(image => image.name), ['characters', 'end', 'title'])
  const blocks = tools.get('game_studio_playtest').output.render({}, result)
  assert.equal(blocks.filter(block => block.type === 'image').length, 3)
  assert.equal(blocks[0].type, 'text')
  for (const slot of ['hero', 'enemy', 'pickup']) {
    const png = await readFile(join(root, 'cube', '.studio', 'renders', `${slot}.png`))
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
  }
  // The "My games" shelf gets this run's picture as the cover (no midpoint in a 2-second round, so the title screen).
  const cover = await readFile(join(root, 'cube', '.studio', 'cover.jpg'))
  assert.equal(cover.readUInt16BE(0), 0xffd8, 'the cover is a JPEG')
  const runTitle = result.summary.match(/\.studio\/playtest\/(run-[^/]+)\/title\.jpg/u)
  assert.ok(runTitle, result.summary)
  assert.deepEqual(cover, await readFile(join(root, 'cube', '.studio', 'playtest', runTitle[1], 'title.jpg')))

  // Reverse check: the override reached the game (without it, the round is still running) ...
  const plain = await call('game_studio_playtest', { path: 'cube', seconds: 2, portrait: false })
  assert.equal(plain.finalPhase, 'playing', plain.summary)
  // ... and neither run touched the project, its build or its versions.
  assert.equal(await readFile(join(root, 'cube', 'game.json'), 'utf8'), before.manifest)
  assert.equal(await readFile(join(root, 'cube', 'dist', 'index.html'), 'utf8'), before.build)
  assert.equal((await call('game_studio_versions', { path: 'cube' })).versions.length, before.versions)
})

test('playtest on a model that cannot see images returns text only and stores no attachments', { timeout: 120_000 }, async (t) => {
  const images = imageServices({ seesImages: false })
  const { call } = await harness(t, images)
  let result
  try { result = await call('game_studio_playtest', { path: 'game', rules: '{"duration": 2}' }) }
  catch (error) { if (NO_BROWSER.test(error.message)) return t.skip('no Chrome or Edge here'); throw error }
  assert.equal(result.finalPhase, 'won', result.summary)
  assert.match(result.summary, /390×844 touch/u)
  assert.match(result.summary, /cannot view images/u)
  assert.deepEqual(result.images, [])
  assert.equal(images.saved.length, 0)
  assert.match(result.summary, /\.studio\/playtest\/run-[^/]+\/end\.jpg/u)
})

test('playtest refuses rules the game does not have, before starting a browser', async (t) => {
  const { call } = await harness(t)
  await assert.rejects(call('game_studio_playtest', { path: 'game', rules: '{"duraton": 2}' }), /Unknown rule duraton; this game's rules are: .*duration/u)
  await assert.rejects(call('game_studio_playtest', { path: 'game', rules: '[1]' }), /JSON object/u)
})

test('characters-only playtest returns one close-up per slot without playing: code-drawn characters from the game, the rest from their files', { timeout: 120_000 }, async (t) => {
  const images = imageServices({ seesImages: true })
  const { root, call, tools } = await harness(t, images)
  await call('game_studio_create', { path: 'cube', title: 'Lantern Isle', template: 'voxel' })
  let result
  try { result = await call('game_studio_playtest', { path: 'cube', characters: true }) }
  catch (error) { if (NO_BROWSER.test(error.message)) return t.skip('no Chrome or Edge here'); throw error }
  assert.deepEqual(result.images.map(image => image.name), ['hero', 'enemy', 'pickup', 'background'])
  assert.match(result.summary, /^Character close-ups from the latest game code, drawn in .*: hero, enemy, pickup\./u)
  assert.match(result.summary, /Slot files, which the sidebar shows as they are: background\. Nothing else is needed/u)
  assert.doesNotMatch(result.summary, /Phases:/u, 'nothing was played')
  assert.equal(tools.get('game_studio_playtest').output.render({}, result).filter(block => block.type === 'image').length, 4)
  await assert.rejects(readFile(join(root, 'cube', '.studio', 'cover.jpg')), /ENOENT/u, 'close-ups alone are not a cover')
  const png = await readFile(join(root, 'cube', '.studio', 'renders', 'hero.png'))
  assert.equal(png.readUInt32BE(16), 384, 'close-ups for model work are drawn larger')

  assert.match(result.summary, /The sidebar already uses these as the thumbnails of hero, enemy, pickup; nothing else is needed/u)
  const code = join(root, 'cube', 'game.js')
  const original = await readFile(code, 'utf8')
  await writeFile(code, `${original}\n// lantern tweak\n`)
  const edited = await call('game_studio_playtest', { path: 'cube', characters: true })
  assert.match(edited.summary, /After game_studio_build the sidebar uses these/u, 'an edit not yet built is called out')

  // A 3D game without the hook gets the contract spelled out in the playtest result.
  await writeFile(code, original.replace('window.__renderSlots = renderSlots;', ''))
  const bare = await call('game_studio_playtest', { path: 'cube', seconds: 1 })
  assert.match(bare.summary, /No character close-ups, so the sidebar shows the template's icon files\. .*window\.__renderSlots\(size\) returns/u)

  // The 2D template draws its characters through drawCharacter(), so it has close-ups too.
  const flat = await call('game_studio_playtest', { path: 'game', characters: true })
  assert.deepEqual(flat.images.map(image => image.name), ['hero', 'enemy', 'pickup', 'background'])
  assert.match(flat.summary, /close-ups from the latest game code, drawn in .*: hero, enemy, pickup\./u)
  const flatHero = await readFile(join(root, 'game', '.studio', 'renders', 'hero.png'))
  assert.equal(flatHero.readUInt32BE(16), 384)

  // Characters redrawn into the slot files need no hook: show the files, no error.
  const flatCode = join(root, 'game', 'game.js')
  const flatOriginal = await readFile(flatCode, 'utf8')
  const unhooked = flatOriginal.replace('window.__renderSlots = renderSlots;', '')
  assert.notEqual(unhooked, flatOriginal)
  await writeFile(flatCode, unhooked)
  const templateFiles = await call('game_studio_playtest', { path: 'game', characters: true })
  assert.deepEqual(templateFiles.images.map(image => image.name), ['hero', 'enemy', 'pickup', 'background'])
  assert.match(templateFiles.summary, /Slot files, which the sidebar shows as they are: hero, enemy, pickup, background\. hero, enemy, pickup still hold the template's art; if game\.js draws those characters in code instead, draw them in drawCharacter\(\)/u)
  for (const slot of ['hero', 'enemy', 'pickup', 'background']) {
    const file = join(root, 'game', 'assets', `${slot}.svg`)
    await writeFile(file, (await readFile(file, 'utf8')).replace('</svg>', '<circle cx="10" cy="10" r="4" fill="#123456"/></svg>'))
  }
  await call('game_studio_build', { path: 'game', note: 'Redrew the characters' })
  const redrawn = await call('game_studio_playtest', { path: 'game', characters: true })
  assert.equal(redrawn.images.length, 4)
  assert.match(redrawn.summary, /Slot files, which the sidebar shows as they are: hero, enemy, pickup, background\. Nothing else is needed for them\./u)
  assert.doesNotMatch(redrawn.summary, /drawCharacter|still hold the template/u)
})

test('a clean playtest says the game is ready only once it is the user\'s game, and names a stale build', { timeout: 120_000 }, async (t) => {
  const { root, call } = await harness(t)
  let fresh
  try { fresh = await call('game_studio_playtest', { path: 'game', seconds: 2 }) }
  catch (error) { if (NO_BROWSER.test(error.message)) return t.skip('no Chrome or Edge here'); throw error }
  assert.match(fresh.summary, /Errors: none/u)
  assert.doesNotMatch(fresh.summary, /All checks passed/u, 'the untouched template is not the user\'s game yet')
  const code = join(root, 'game', 'game.js')
  await writeFile(code, `${await readFile(code, 'utf8')}\n// the user's game\n`)
  const stale = await call('game_studio_playtest', { path: 'game', seconds: 2 })
  assert.match(stale.summary, /Checks passed, but the sidebar still plays an older build: call game_studio_build\./u)
  await call('game_studio_build', { path: 'game' })
  const ready = await call('game_studio_playtest', { path: 'game', seconds: 2 })
  assert.match(ready.summary, /All checks passed\. If the game already matches what the user asked for .* export it and tell the user\. More polish is optional/u)
  // A game that keeps playing but logs a script error is not ready.
  await writeFile(code, `${await readFile(code, 'utf8')}\nsetTimeout(function () { throw new Error('lantern boom') }, 300);\n`)
  await call('game_studio_build', { path: 'game' })
  const broken = await call('game_studio_playtest', { path: 'game', seconds: 2 })
  assert.match(broken.summary, /lantern boom/u)
  assert.match(broken.summary, /Phases: title.*playing/u)
  assert.doesNotMatch(broken.summary, /All checks passed/u)
})

test('create names the slots after the user\'s characters; generic names are pointed out at create and build', async (t) => {
  const { root, call, tools } = await harness(t)
  const named = await call('game_studio_create', {
    path: 'farm', title: '小鸡玉米农场', slots: '{"hero": "小鸡", "enemy": "狐狸", "pickup": "玉米粒", "background": "农场"}',
  })
  assert.deepEqual(named.slots, { hero: '小鸡', enemy: '狐狸', pickup: '玉米粒', background: '农场' })
  assert.match(named.note, /Read game\.json and game\.js before you edit them/u)
  assert.doesNotMatch(named.note, /generic names/u)
  const manifest = JSON.parse(await readFile(join(root, 'farm', 'game.json'), 'utf8'))
  assert.equal(manifest.slots.hero.label, '小鸡')
  assert.doesNotMatch(JSON.stringify(await call('game_studio_build', { path: 'farm' })), /generic names/u)

  const partly = await call('game_studio_create', { path: 'half', title: 'Half', slots: { hero: 'Chick' } })
  assert.match(partly.note, /still calls enemy, pickup, background by the template's generic names; set slots\.<slot>\.label in game\.json/u)
  assert.match((await call('game_studio_build', { path: 'half' })).note, /still calls enemy, pickup, background/u)
  await assert.rejects(call('game_studio_create', { path: 'bad', title: 'Bad', slots: '[1]' }), /slots must be a JSON object/u)
  // Agents pass the slots as an object as often as a string; the host must accept both.
  assert.equal(tools.get('game_studio_create').parameters.slots.type, 'json')
})

test('create gives a game its own art slots: new ones get a placeholder that builds, unneeded ones are dropped', { timeout: 120_000 }, async (t) => {
  const approval = approvalAnswering('rejected')
  const { root, call } = await harness(t, { approval })
  const cards = await call('game_studio_create', {
    path: 'cards', title: '史莱姆王讨伐战',
    slots: { hero: '流浪剑士', enemy: '史莱姆王', pickup: null, card: { label: '卡面', size: [256, 384] }, table: { label: '牌桌', transparent: false } },
  })
  assert.deepEqual(cards.slots, { hero: '流浪剑士', enemy: '史莱姆王', background: 'Background', card: '卡面', table: '牌桌' })
  const manifest = JSON.parse(await readFile(join(root, 'cards', 'game.json'), 'utf8'))
  assert.deepEqual(manifest.slots.card, { file: 'assets/card.svg', label: '卡面', size: [256, 384], transparent: true })
  assert.deepEqual(manifest.slots.table, { file: 'assets/table.svg', label: '牌桌', size: [512, 512], transparent: false })
  assert.equal(manifest.slots.pickup, undefined)
  await assert.rejects(readFile(join(root, 'cards', 'assets', 'pickup.svg')), /ENOENT/u, 'a dropped slot leaves no file behind')
  const placeholder = await readFile(join(root, 'cards', 'assets', 'card.svg'), 'utf8')
  assert.match(placeholder, /^<svg [^>]*width="256" height="384"/u)
  assert.match(placeholder, />卡<\/text>/u)
  const ledger = JSON.parse(await readFile(join(root, 'cards', 'assets', 'ASSETS.json'), 'utf8'))
  assert.equal(ledger.assets.card.source, 'template')
  assert.equal(ledger.assets.pickup, undefined)
  const html = await readFile(join(root, 'cards', 'dist', 'index.html'), 'utf8')
  assert.match(html, /"card":"data:image\/svg\+xml;base64,/u, 'the new slot reaches game.js as GAME.assets.card')
  // AI art can be made for a slot the game added, named the way the sidebar names it.
  await assert.rejects(call('game_studio_generate_asset', { path: 'cards', slot: 'card', prompt: 'a sword card', count: 1, quality: 'low' }), /declined/u)
  assert.match(approval.asked.at(-1).displayReason.zh, /「卡面」/u)
  // Close-ups skip the dropped slot and show the new ones from their files.
  let close
  try { close = await call('game_studio_playtest', { path: 'cards', characters: true }) }
  catch (error) { if (NO_BROWSER.test(error.message)) return t.skip('no Chrome or Edge here'); throw error }
  assert.match(close.summary, /Character close-ups from the latest game code, drawn in .*: hero, enemy\./u)
  assert.match(close.summary, /Slot files, which the sidebar shows as they are: background, card, table\./u)
  assert.doesNotMatch(close.summary, /pickup/u)

  await assert.rejects(call('game_studio_create', { path: 'b1', title: 'B', slots: { 'Big Card': 'x' } }), /must be letters, digits or _ and start with a letter/u)
  // camelCase is how agents name things in JS; names that differ only in case would share a file on macOS.
  const camel = await call('game_studio_create', { path: 'camel', title: 'C', slots: { cardArt: { label: '卡面' } } })
  assert.equal(camel.slots.cardArt, '卡面')
  await assert.rejects(call('game_studio_create', { path: 'b5', title: 'B', slots: { card: 'a', Card: 'b' } }), /differ only in case/u)
  // A refused request leaves no half-made folder, so the same call works once it is fixed.
  await assert.rejects(call('game_studio_create', { path: 'retry', title: 'R', slots: { hero: 'x', 'Bad Name': {} } }), /must be letters, digits or _/u)
  await assert.rejects(readFile(join(root, 'retry', 'game.json')), /ENOENT/u)
  await call('game_studio_create', { path: 'retry', title: 'R', slots: { hero: 'x' } })
  // A template slot can be redrawn to another shape, e.g. a full portrait background instead of a tile.
  const court = await call('game_studio_create', { path: 'court', title: 'C', slots: { background: { label: '球场', size: [390, 844], transparent: false } } })
  assert.equal(court.slots.background, '球场')
  const courtManifest = JSON.parse(await readFile(join(root, 'court', 'game.json'), 'utf8'))
  assert.deepEqual(courtManifest.slots.background, { file: 'assets/background.svg', label: '球场', size: [390, 844], transparent: false })
  assert.match(await readFile(join(root, 'court', 'assets', 'background.svg'), 'utf8'), /^<svg [^>]*width="390" height="844"/u)
  await assert.rejects(call('game_studio_create', { path: 'b3', title: 'B', slots: { card: { size: [10, 10] } } }), /between 32 and 2048/u)
  await assert.rejects(call('game_studio_create', { path: 'b4', title: 'B', slots: { hero: null, enemy: null, pickup: null, background: null } }), /at least one asset slot/u)
})

/** Width × height of a baseline or progressive JPEG. */
function jpegSize(data) {
  for (let i = 2; i < data.length - 9;) {
    if (data[i] !== 0xff) { i++; continue }
    const marker = data[i + 1]
    if (marker === 0xc0 || marker === 0xc2) return [data.readUInt16BE(i + 7), data.readUInt16BE(i + 5)]
    i += 2 + data.readUInt16BE(i + 2)
  }
  return null
}

test('a landscape game is played and previewed landscape; phone screenshots are sharp enough to read', { timeout: 120_000 }, async (t) => {
  const { root, call } = await harness(t)
  const wide = await call('game_studio_create', { path: 'runner', title: 'Fox Run', orientation: 'landscape' })
  assert.equal(wide.orientation, 'landscape')
  assert.equal(JSON.parse(await readFile(join(root, 'runner', 'game.json'), 'utf8')).orientation, 'landscape')
  assert.equal(JSON.parse(await readFile(join(root, 'runner', '.studio', 'state.json'), 'utf8')).orientation, 'landscape')
  assert.equal(JSON.parse(await readFile(join(root, 'game', '.studio', 'state.json'), 'utf8')).orientation, 'portrait')
  await assert.rejects(call('game_studio_create', { path: 'sideways', title: 'S', orientation: 'sideways' }), /Unknown orientation "sideways"/u)

  let played
  try { played = await call('game_studio_playtest', { path: 'runner', seconds: 1 }) }
  catch (error) { if (NO_BROWSER.test(error.message)) return t.skip('no Chrome or Edge here'); throw error }
  assert.match(played.summary, /^Playtest in .*, 960×540;/u, 'a landscape game plays landscape without being asked')
  const wideShot = played.summary.match(/Screenshots: .*?(\S+title\.jpg)/u)[1]
  assert.deepEqual(jpegSize(await readFile(join(root, 'runner', wideShot))), [960, 540])
  const upright = await call('game_studio_playtest', { path: 'runner', seconds: 1, portrait: true })
  assert.match(upright.summary, /^Playtest in .*, 390×844 touch, screenshots at 2× pixels/u, 'the call can still ask for portrait')

  const phone = await call('game_studio_playtest', { path: 'game', seconds: 1 })
  assert.match(phone.summary, /^Playtest in .*, 390×844 touch, screenshots at 2× pixels/u)
  const phoneShot = phone.summary.match(/Screenshots: .*?(\S+title\.jpg)/u)[1]
  assert.deepEqual(jpegSize(await readFile(join(root, 'game', phoneShot))), [780, 1688])
})

test('a game that defines window.__autoplay plays its own round in the playtest; others are told to add it', { timeout: 120_000 }, async (t) => {
  const { root, call } = await harness(t)
  const code = join(root, 'game', 'game.js')
  const original = await readFile(code, 'utf8')
  let arrows
  try { arrows = await call('game_studio_playtest', { path: 'game', seconds: 2, rules: '{"maxPickups": 0}' }) }
  catch (error) { if (NO_BROWSER.test(error.message)) return t.skip('no Chrome or Edge here'); throw error }
  assert.match(arrows.summary, /played by arrow keys toward the nearest pickup/u)
  assert.match(arrows.summary, /The arrow-key autopilot scored nothing\. .*define window\.__autoplay\(state\)/u)

  // The game's own bot scores without the hero moving: arrow keys are not pressed.
  const bot = original.replace("  window.__gameState = function () {", "  window.__autoplay = function (state) { if (state.phase === 'playing') score += 1; };\n  window.__gameState = function () {")
  assert.notEqual(bot, original)
  await writeFile(code, bot)
  await call('game_studio_build', { path: 'game' })
  const self = await call('game_studio_playtest', { path: 'game', seconds: 2, rules: '{"maxPickups": 0}' })
  assert.match(self.summary, /played by the game's own window\.__autoplay/u)
  assert.match(self.summary, /Best score: [1-9]\d*/u)
  assert.doesNotMatch(self.summary, /autopilot scored nothing/u)

  await writeFile(code, original.replace("  window.__gameState = function () {", "  window.__autoplay = function () { throw new Error('bot tripped'); };\n  window.__gameState = function () {"))
  await call('game_studio_build', { path: 'game' })
  const broken = await call('game_studio_playtest', { path: 'game', seconds: 2 })
  assert.equal((broken.summary.match(/window\.__autoplay failed: .*bot tripped/gu) ?? []).length, 1, 'a broken bot is reported once, not every tick')

  // An invented autoplay rule is pointed at the hook.
  await assert.rejects(call('game_studio_playtest', { path: 'game', rules: '{"autoDemo": true}' }), /Unknown rule autoDemo; .*define window\.__autoplay\(state\) in game\.js instead of a rule/u)
  await assert.rejects(call('game_studio_playtest', { path: 'game', rules: '{"duraton": 2}' }), /^(?![\s\S]*__autoplay)[\s\S]*Unknown rule duraton/u)
})

test('the agent is told how sidebar thumbnails of code-drawn characters work, so it never reads the plugin', async (t) => {
  const { tools } = await harness(t)
  for (const name of ['game_studio_create', 'game_studio_build']) {
    const description = tools.get(name).description
    assert.match(description, /window\.__renderSlots\(size\) returns \{ <slot>: "data:image\/png;base64,…" \}/u, name)
    assert.match(description, /type: "renders"/u, name)
  }
  assert.match(tools.get('game_studio_playtest').description, /characters: true/u)
  for (const name of ['game_studio_create', 'game_studio_playtest']) {
    const description = tools.get(name).description
    assert.match(description, /window\.__gameState\(\), which must return \{ phase: "title" \| "playing" \| "won" \| "lost", score, hearts, fps, hero: \{ x, y \}, pickups: \[\{ x, y \}\], enemies: \[\{ x, y \}\], world: \{ w, h \} \}/u, name)
    assert.match(description, /Keep this function when you rewrite game\.js/u, name)
  }
  assert.match(tools.get('game_studio_create').description, /drawCharacter\(g, slot, size\)/u)
  for (const name of ['game_studio_create', 'game_studio_playtest']) {
    assert.match(tools.get(name).description, /should also define window\.__autoplay\(state\): during a playtest it is called about 10 times a second/u, name)
  }
  for (const name of ['game_studio_create', 'game_studio_build']) {
    assert.match(tools.get(name).description, /overwriting its file in assets\/ .*records it as your edit, so leave assets\/ASSETS\.json alone/u, name)
  }
  assert.match(tools.get('game_studio_create').description, /rules are free-form: add any key and read it in game\.js as window\.GAME\.rules\.<key>/u)
})

// ---------------------------------------------------------------- publish to GitHub Pages

const FAKE_HOST_GH = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') process.exit(0)
if (args[0] !== 'api') {
  console.error('unexpected subcommand: ' + args[0])
  process.exit(1)
}
let method = 'GET'
let inputFile = null
let endpoint = ''
for (let i = 1; i < args.length; i++) {
  if (args[i] === '-X') { method = args[++i]; continue }
  if (args[i] === '--input') { inputFile = args[++i]; continue }
  if (!endpoint) endpoint = args[i]
}
const body = inputFile ? JSON.parse(readFileSync(inputFile, 'utf8')) : null
if (process.env.FAKE_GH_LOG) {
  appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({
    method,
    path: endpoint,
    body,
    hasInputFile: Boolean(inputFile),
    forceColor: process.env.FORCE_COLOR ?? null,
    noColor: process.env.NO_COLOR ?? null,
    promptDisabled: process.env.GH_PROMPT_DISABLED ?? null,
  }) + '\\n')
}
if (process.env.FAKE_GH_MODE === 'not-logged-in') {
  console.error('To get started with GitHub CLI, please run:  gh auth login')
  process.exit(4)
}
if (process.env.FAKE_GH_MODE === 'network-error') {
  console.error('error connecting to api.github.com\\nread: connection reset by peer')
  process.exit(1)
}
const stateFile = process.env.FAKE_GH_STATE
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2))
const callKey = method + ' ' + endpoint
if (state.transientFailures && state.transientFailures[callKey] > 0) {
  state.transientFailures[callKey] -= 1
  save()
  console.error('gh: ' + method + ' "https://api.github.com/' + endpoint + '": EOF')
  process.exit(1)
}
const notFound = () => {
  console.log(JSON.stringify({ message: 'Not Found', status: '404' }))
  console.error('gh: Not Found (HTTP 404)')
  process.exit(1)
}
if (method === 'GET' && endpoint === 'user') {
  console.log(JSON.stringify({ login: state.login }))
  process.exit(0)
}
if (method === 'POST' && endpoint === 'user/repos') {
  const fullName = state.login + '/' + body.name
  const defaultBranch = state.defaultBranch || 'main'
  const blobSha = 'blob-' + (++state.seq)
  const treeSha = 'tree-' + (++state.seq)
  const commitSha = 'commit-' + (++state.seq)
  state.repos[fullName] = {
    name: body.name,
    private: Boolean(body.private),
    defaultBranch,
    remainingRef404: state.initialRef404Count || 0,
    head: commitSha,
    blobs: { [blobSha]: Buffer.from('# ' + body.name + '\\n', 'utf8').toString('base64') },
    trees: { [treeSha]: { 'README.md': blobSha } },
    commits: { [commitSha]: { tree: treeSha, message: 'Initial commit', parents: [] } },
    pages: null,
  }
  save()
  console.log(JSON.stringify({ name: body.name, full_name: fullName, private: Boolean(body.private), default_branch: defaultBranch }))
  process.exit(0)
}
const repoMatch = /^repos\\/([^/]+\\/[^/]+)(?:\\/(.*))?$/u.exec(endpoint)
if (!repoMatch) notFound()
const fullName = repoMatch[1]
const rest = (repoMatch[2] || '').split('?')[0]
const repo = state.repos[fullName]
if (!repo) notFound()
const repoBranch = repo.defaultBranch || 'main'

if (method === 'GET' && rest === '') {
  console.log(JSON.stringify({ name: repo.name, full_name: fullName, private: repo.private, default_branch: repoBranch }))
  process.exit(0)
}
if (method === 'GET' && rest === 'git/ref/heads/' + repoBranch) {
  if (repo.remainingRef404 > 0) {
    repo.remainingRef404 -= 1
    save()
    notFound()
  }
  console.log(JSON.stringify({ ref: 'refs/heads/' + repoBranch, object: { sha: repo.head, type: 'commit' } }))
  process.exit(0)
}
if (method === 'GET' && rest.startsWith('git/commits/')) {
  const sha = rest.slice('git/commits/'.length)
  const commit = repo.commits[sha]
  if (!commit) notFound()
  console.log(JSON.stringify({ sha, tree: { sha: commit.tree }, message: commit.message, parents: commit.parents.map(p => ({ sha: p })) }))
  process.exit(0)
}
if (method === 'GET' && rest.startsWith('git/trees/')) {
  const sha = rest.slice('git/trees/'.length)
  const treeMap = repo.trees[sha]
  if (!treeMap) notFound()
  const tree = Object.entries(treeMap).map(([path, bSha]) => ({ path, mode: '100644', type: 'blob', sha: bSha }))
  console.log(JSON.stringify({ sha, tree, truncated: false }))
  process.exit(0)
}
if (method === 'GET' && rest.startsWith('git/blobs/')) {
  const sha = rest.slice('git/blobs/'.length)
  const content = repo.blobs[sha]
  if (content === undefined) notFound()
  console.log(JSON.stringify({ sha, content, encoding: 'base64' }))
  process.exit(0)
}
if (method === 'POST' && rest === 'git/blobs') {
  const sha = 'blob-' + (++state.seq)
  repo.blobs[sha] = body.content
  save()
  console.log(JSON.stringify({ sha }))
  process.exit(0)
}
if (method === 'POST' && rest === 'git/trees') {
  const baseFiles = { ...(repo.trees[body.base_tree] || {}) }
  for (const item of body.tree || []) {
    if (item.sha === null) delete baseFiles[item.path]
    else baseFiles[item.path] = item.sha
  }
  const sha = 'tree-' + (++state.seq)
  repo.trees[sha] = baseFiles
  save()
  console.log(JSON.stringify({ sha, tree: body.tree }))
  process.exit(0)
}
if (method === 'POST' && rest === 'git/commits') {
  const sha = 'commit-' + (++state.seq)
  repo.commits[sha] = { tree: body.tree, message: body.message, parents: body.parents || [] }
  save()
  console.log(JSON.stringify({ sha }))
  process.exit(0)
}
if (method === 'PATCH' && rest === 'git/refs/heads/' + repoBranch) {
  repo.head = body.sha
  if (state.patchRef422Once) {
    state.patchRef422Once = false
    save()
    console.error('gh: Update is not a fast forward (HTTP 422)')
    process.exit(1)
  }
  save()
  console.log(JSON.stringify({ ref: 'refs/heads/' + repoBranch, object: { sha: body.sha } }))
  process.exit(0)
}
if (method === 'POST' && rest === 'pages') {
  if (repo.pages && repo.pages.enabled) {
    console.error('gh: Conflict (HTTP 409)')
    process.exit(1)
  }
  const [owner, rName] = fullName.split('/')
  repo.pages = { enabled: true, url: 'https://' + owner + '.github.io/' + rName + '/', source: body.source }
  save()
  console.log(JSON.stringify({ html_url: repo.pages.url }))
  process.exit(0)
}
if (method === 'GET' && rest === 'pages') {
  const [owner, rName] = fullName.split('/')
  const url = repo.pages?.url || ('https://' + owner + '.github.io/' + rName + '/')
  console.log(JSON.stringify({ html_url: url, status: 'built' }))
  process.exit(0)
}
if (method === 'GET' && rest === 'pages/builds/latest') {
  const pagesMode = process.env.FAKE_GH_PAGES_MODE || 'built'
  if (pagesMode === 'errored') {
    console.log(JSON.stringify({ status: 'errored', commit: repo.head, error: { message: 'Page build failed' } }))
    process.exit(0)
  }
  if (pagesMode === 'building') {
    console.log(JSON.stringify({ status: 'building', commit: repo.head }))
    process.exit(0)
  }
  console.log(JSON.stringify({ status: 'built', commit: repo.head }))
  process.exit(0)
}
notFound()
`

let sharedHostGh

async function makeFakeGh(t, {
  login = 'octocat',
  preExistingRepo = null,
  mode = 'ok',
  pagesMode = 'built',
  defaultBranch = 'main',
  initialRef404Count = 0,
  transientFailures = null,
  patchRef422Once = false,
} = {}) {
  if (!sharedHostGh) {
    const binDir = await mkdtemp(join(tmpdir(), 'game-studio-gh-host-'))
    const bin = join(binDir, 'gh')
    await writeFile(bin, FAKE_HOST_GH)
    await chmod(bin, 0o755)
    spawnSync(bin, ['--version'])
    process.once('exit', () => { spawnSync('rm', ['-rf', binDir]) })
    sharedHostGh = bin
  }
  const command = sharedHostGh
  const dir = await mkdtemp(join(tmpdir(), 'game-studio-gh-state-'))
  const logFile = join(dir, 'calls.jsonl')
  const stateFile = join(dir, 'state.json')
  const initialState = { login, seq: 0, defaultBranch, initialRef404Count, transientFailures: transientFailures ? { ...transientFailures } : {}, patchRef422Once, repos: {} }
  if (preExistingRepo) {
    const fullName = `${login}/${preExistingRepo.name}`
    const blobs = {}
    const treeMap = {}
    for (const [path, content] of Object.entries(preExistingRepo.files ?? { 'README.md': '# existing\n' })) {
      const bSha = `blob-${++initialState.seq}`
      blobs[bSha] = Buffer.from(content, 'utf8').toString('base64')
      treeMap[path] = bSha
    }
    const tSha = `tree-${++initialState.seq}`
    const cSha = `commit-${++initialState.seq}`
    initialState.repos[fullName] = {
      name: preExistingRepo.name,
      private: false,
      defaultBranch: preExistingRepo.defaultBranch ?? defaultBranch,
      remainingRef404: 0,
      head: cSha,
      blobs,
      trees: { [tSha]: treeMap },
      commits: { [cSha]: { tree: tSha, message: 'Initial commit', parents: [] } },
      pages: null,
    }
  }
  await writeFile(logFile, '')
  await writeFile(stateFile, JSON.stringify(initialState, null, 2))
  process.env.FAKE_GH_LOG = logFile
  process.env.FAKE_GH_STATE = stateFile
  process.env.FAKE_GH_MODE = mode
  process.env.FAKE_GH_PAGES_MODE = pagesMode
  const readCalls = async () => (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const writeCalls = async () => (await readCalls()).filter(call => call.method !== 'GET')
  const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'))
  const repoFiles = async (repoName = 'dsh-games') => {
    const st = await readState()
    const repo = st.repos[`${login}/${repoName}`]
    if (!repo) return null
    const treeSha = repo.commits[repo.head].tree
    const tree = repo.trees[treeSha]
    const out = {}
    for (const [path, bSha] of Object.entries(tree)) {
      out[path] = Buffer.from(repo.blobs[bSha], 'base64')
    }
    return out
  }
  t.after(async () => {
    delete process.env.FAKE_GH_LOG
    delete process.env.FAKE_GH_STATE
    delete process.env.FAKE_GH_MODE
    delete process.env.FAKE_GH_PAGES_MODE
    await rm(dir, { recursive: true, force: true })
  })
  return { command, readCalls, writeCalls, readState, repoFiles }
}

test('first game_studio_publish creates the repo, commits .nojekyll, .dsh-game-studio.json, index.html and <slug>/index.html byte-identical to dist/index.html, enables Pages and waits until built', async (t) => {
  const { command, readCalls, readState, repoFiles } = await makeFakeGh(t, { login: 'octocat' })
  const approval = approvalAnswering('allowed-once')
  const { root, call } = await harness(t, { approval, config: { ghPath: command, pagesTimeoutMs: 200 } })

  const gameDir = join(root, 'game')
  const artifactBytes = await readFile(join(gameDir, 'dist', 'index.html'))

  const published = await call('game_studio_publish', { path: 'game' })
  assert.equal(published.url, 'https://octocat.github.io/dsh-games/game/')
  assert.equal(published.siteUrl, 'https://octocat.github.io/dsh-games/')
  assert.equal(published.repo, 'octocat/dsh-games')
  assert.equal(published.slug, 'game')
  assert.equal(published.status, 'built')

  // Approval was asked once and mentioned creating the new public repo.
  assert.equal(approval.asked.length, 1)
  assert.match(approval.asked[0].displayReason.zh, /新建公开仓库 octocat\/dsh-games/u)
  assert.match(approval.asked[0].displayReason.en, /create a new public repository octocat\/dsh-games/u)

  const calls = await readCalls()
  assert.equal(calls.filter(c => c.method === 'POST' && c.path === 'user/repos').length, 1, 'created the repository once')
  assert.equal(calls.filter(c => c.method === 'POST' && c.path === 'repos/octocat/dsh-games/git/commits').length, 1, 'exactly one commit')
  assert.equal(calls.filter(c => c.method === 'POST' && c.path === 'repos/octocat/dsh-games/pages').length, 1, 'enabled Pages')
  assert.ok(calls.some(c => c.method === 'GET' && c.path === 'repos/octocat/dsh-games/pages/builds/latest'), 'waited for Pages build')
  for (const c of calls.filter(item => item.method !== 'GET')) {
    assert.equal(c.hasInputFile, true, `write request ${c.method} ${c.path} passed body via --input temp file`)
  }

  const files = await repoFiles('dsh-games')
  assert.deepEqual(Object.keys(files).sort(), ['.dsh-game-studio.json', '.nojekyll', 'README.md', 'game/cover.svg', 'game/index.html', 'games.json', 'index.html'])
  assert.equal(files['.nojekyll'].byteLength, 0)
  assert.deepEqual(files['game/index.html'], artifactBytes, '<slug>/index.html is byte-for-byte identical to paths.artifact(dir)')

  const feed = JSON.parse(files['games.json'].toString('utf8'))
  assert.equal(feed.format, 'dsh-games-feed')
  assert.equal(feed.version, 1)
  assert.equal(feed.author, 'octocat')
  assert.equal(feed.games.length, 1)
  assert.equal(feed.games[0].slug, 'game')
  assert.equal(feed.games[0].title, 'Moon Garden')
  assert.equal(feed.games[0].url, 'game/')
  assert.equal(feed.games[0].cover, 'game/cover.svg')
  assert.equal(feed.games[0].dimension, '2d')
  assert.equal(feed.games[0].orientation, 'portrait')

  const marker = JSON.parse(files['.dsh-game-studio.json'].toString('utf8'))
  assert.equal(marker.tool, 'dsh-game-studio')
  assert.equal(marker.version, 1)
  assert.equal(marker.games.game.title, 'Moon Garden')
  assert.match(marker.games.game.source, /^[0-9a-f]{16}$/u)
  assert.equal(marker.wall, null)
  assert.match(files['index.html'].toString('utf8'), /href="\.\/game\/"><strong>Moon Garden<\/strong>/u)

  // Local .studio/published.json was written for the sidebar.
  const pubRecord = JSON.parse(await readFile(join(gameDir, '.studio', 'published.json'), 'utf8'))
  assert.equal(pubRecord.url, 'https://octocat.github.io/dsh-games/game/')
  assert.equal(pubRecord.slug, 'game')
  assert.equal(pubRecord.buildId, marker.games.game.buildId)

  // Item 11: No local absolute path (tmpdir() or root) appears anywhere in the uploaded blobs or manifest.
  const st = await readState()
  const tmpPrefix = tmpdir()
  for (const [bSha, b64] of Object.entries(st.repos['octocat/dsh-games'].blobs)) {
    const content = Buffer.from(b64, 'base64').toString('utf8')
    assert.ok(!content.includes(tmpPrefix), `blob ${bSha} must not contain tmpdir (${tmpPrefix})`)
    assert.ok(!content.includes(root), `blob ${bSha} must not contain workspace root (${root})`)
  }
})

test('republishing the same project reuses its slug without creating the repo again and makes exactly one new commit', async (t) => {
  const { command, readCalls, repoFiles } = await makeFakeGh(t, { login: 'octocat' })
  const approval = approvalAnswering('allowed-once')
  const { root, call } = await harness(t, { approval, config: { ghPath: command, pagesTimeoutMs: 200 } })

  const first = await call('game_studio_publish', { path: 'game' })
  assert.equal(first.slug, 'game')
  const callsAfterFirst = (await readCalls()).length

  // Rebuild after a change and publish again.
  const codePath = join(root, 'game', 'game.js')
  await writeFile(codePath, `${await readFile(codePath, 'utf8')}\n// v2\n`)
  const rebuilt = await call('game_studio_build', { path: 'game', note: 'v2' })

  const second = await call('game_studio_publish', { path: 'game' })
  assert.equal(second.slug, 'game', 'same project reuses slug')
  assert.equal(second.url, 'https://octocat.github.io/dsh-games/game/')
  assert.doesNotMatch(approval.asked[1].displayReason.zh, /新建公开仓库/u, 'existing repo does not say it will create the repo')

  const secondCalls = (await readCalls()).slice(callsAfterFirst)
  assert.equal(secondCalls.filter(c => c.method === 'POST' && c.path === 'user/repos').length, 0, 'did not create repo again')
  assert.equal(secondCalls.filter(c => c.method === 'POST' && c.path === 'repos/octocat/dsh-games/git/commits').length, 1, 'only one new commit')

  const files = await repoFiles('dsh-games')
  assert.deepEqual(Object.keys(files).sort(), ['.dsh-game-studio.json', '.nojekyll', 'README.md', 'game/cover.svg', 'game/index.html', 'games.json', 'index.html'])
  const marker = JSON.parse(files['.dsh-game-studio.json'].toString('utf8'))
  assert.deepEqual(Object.keys(marker.games), ['game'])
  assert.equal(marker.games.game.buildId, rebuilt.buildId)
})

test('two different projects with the same folder name get distinct slugs (<slug> and <slug>-2)', async (t) => {
  const { command, repoFiles } = await makeFakeGh(t, { login: 'octocat' })
  const approval = approvalAnswering('allowed-once')
  const { call } = await harness(t, { approval, config: { ghPath: command, pagesTimeoutMs: 200 } })

  await call('game_studio_create', { path: 'nested/game', title: 'Second Moon' })

  const pub1 = await call('game_studio_publish', { path: 'game' })
  const pub2 = await call('game_studio_publish', { path: 'nested/game' })
  assert.equal(pub1.slug, 'game')
  assert.equal(pub1.url, 'https://octocat.github.io/dsh-games/game/')
  assert.equal(pub2.slug, 'game-2')
  assert.equal(pub2.url, 'https://octocat.github.io/dsh-games/game-2/')

  const files = await repoFiles('dsh-games')
  assert.ok(files['game/index.html'])
  assert.ok(files['game-2/index.html'])
  const marker = JSON.parse(files['.dsh-game-studio.json'].toString('utf8'))
  assert.deepEqual(Object.keys(marker.games).sort(), ['game', 'game-2'])
  const indexHtml = files['index.html'].toString('utf8')
  assert.match(indexHtml, /href="\.\/game\/"/u)
  assert.match(indexHtml, /href="\.\/game-2\/"/u)
})

test('existing repository without .dsh-game-studio.json marker is rejected with REPO_NOT_OURS and zero write requests', async (t) => {
  const { command, writeCalls } = await makeFakeGh(t, {
    login: 'octocat',
    preExistingRepo: { name: 'dsh-games', files: { 'README.md': '# Personal site\n', 'index.html': '<h1>Hello</h1>' } },
  })
  const approval = approvalAnswering('allowed-once')
  const { root, call, runCommand } = await harness(t, { approval, config: { ghPath: command, pagesTimeoutMs: 200 } })

  await assert.rejects(
    call('game_studio_publish', { path: 'game' }),
    (err) => err.code === 'REPO_NOT_OURS' && /githubRepo/u.test(err.message),
  )
  assert.deepEqual(await writeCalls(), [], 'zero write requests (no blobs, trees, commits, refs, or pages calls)')

  const viaCommand = await runCommand(`publish ${JSON.stringify({ project: join(root, 'game') })}`)
  assert.equal(viaCommand.kind, 'error')
  assert.equal(JSON.parse(viaCommand.text).code, 'REPO_NOT_OURS')
  assert.deepEqual(await writeCalls(), [], 'sidebar command also makes zero write requests on REPO_NOT_OURS')
})

test('missing gh throws NO_GH and unauthenticated gh throws GH_NOT_LOGGED_IN before asking for approval, and sidebar command omits agent-only instructions', async (t) => {
  const approval = approvalAnswering('allowed-once')
  const missingGh = await harness(t, { approval, config: { ghPath: join(tmpdir(), 'no-such-gh-bin') } })
  await assert.rejects(
    missingGh.call('game_studio_publish', { path: 'game' }),
    (err) => err.code === 'NO_GH' && /brew install gh/u.test(err.message) && /do not download, install, or run/u.test(err.message),
  )
  assert.equal(approval.asked.length, 0, 'no approval asked when gh is missing')

  const cmdNoGh = await missingGh.runCommand(`publish ${JSON.stringify({ project: join(missingGh.root, 'game') })}`)
  assert.equal(cmdNoGh.kind, 'error')
  assert.doesNotMatch(cmdNoGh.text, /do not download|Tell the user/iu)
  assert.equal(JSON.parse(cmdNoGh.text).code, 'NO_GH')

  const { command, writeCalls } = await makeFakeGh(t, { mode: 'not-logged-in' })
  const unauth = await harness(t, { approval, config: { ghPath: command } })
  await assert.rejects(
    unauth.call('game_studio_publish', { path: 'game' }),
    (err) => err.code === 'GH_NOT_LOGGED_IN' && /gh auth login/u.test(err.message) && /do not run `gh auth login` yourself/u.test(err.message),
  )
  assert.equal(approval.asked.length, 0, 'no approval asked when gh is not logged in')
  assert.deepEqual(await writeCalls(), [])

  const cmdUnauth = await unauth.runCommand(`publish ${JSON.stringify({ project: join(unauth.root, 'game') })}`)
  assert.equal(cmdUnauth.kind, 'error')
  assert.doesNotMatch(cmdUnauth.text, /do not run|Tell the user/iu)
  assert.equal(JSON.parse(cmdUnauth.text).code, 'GH_NOT_LOGGED_IN')
})

test('declining game_studio_publish throws declined and makes zero write requests to GitHub', async (t) => {
  const { command, writeCalls } = await makeFakeGh(t, { login: 'octocat' })
  const approval = approvalAnswering('rejected')
  const { root, call } = await harness(t, { approval, config: { ghPath: command } })

  await assert.rejects(call('game_studio_publish', { path: 'game' }), /declined/u)
  assert.equal(approval.asked.length, 1)
  assert.deepEqual(await writeCalls(), [], 'zero write requests when approval is declined')
  await assert.rejects(readFile(join(root, 'game', '.studio', 'published.json')), { code: 'ENOENT' })
})

test('publishing an unbuilt game fails with NO_BUILD before asking for approval', async (t) => {
  const { command, writeCalls } = await makeFakeGh(t, { login: 'octocat' })
  const approval = approvalAnswering('allowed-once')
  const { root, call } = await harness(t, { approval, config: { ghPath: command } })

  await rm(join(root, 'game', 'dist', 'index.html'), { force: true })
  await assert.rejects(
    call('game_studio_publish', { path: 'game' }),
    (err) => err.code === 'NO_BUILD' && /game_studio_build/u.test(err.message),
  )
  assert.equal(approval.asked.length, 0, 'no approval asked when the game is not built')
  assert.deepEqual(await writeCalls(), [])
})

test('removing a published game sets its file sha to null in the new tree and updates the manifest and directory page', async (t) => {
  const { command, readCalls, repoFiles } = await makeFakeGh(t, { login: 'octocat' })
  const approval = approvalAnswering('allowed-once')
  const { root, call } = await harness(t, { approval, config: { ghPath: command, pagesTimeoutMs: 200 } })

  await call('game_studio_publish', { path: 'game' })
  const removed = await call('game_studio_publish', { path: 'game', remove: true })
  assert.equal(removed.removed, true)
  assert.equal(removed.slug, 'game')
  assert.match(approval.asked[1].displayReason.zh, /从 octocat\/dsh-games 删除《Moon Garden》/u)

  const treePosts = (await readCalls()).filter(c => c.method === 'POST' && c.path === 'repos/octocat/dsh-games/git/trees')
  const lastTree = treePosts.at(-1).body.tree
  assert.ok(lastTree.some(entry => entry.path === 'game/index.html' && entry.sha === null), 'game/index.html has sha: null in tree')
  assert.ok(lastTree.some(entry => entry.path === 'game/cover.svg' && entry.sha === null), 'game/cover.svg has sha: null in tree')

  const files = await repoFiles('dsh-games')
  assert.equal(files['game/index.html'], undefined, 'game/index.html is removed from the repository tree')
  assert.equal(files['game/cover.svg'], undefined, 'game/cover.svg is removed from the repository tree')
  const marker = JSON.parse(files['.dsh-game-studio.json'].toString('utf8'))
  assert.deepEqual(marker.games, {})
  const feed = JSON.parse(files['games.json'].toString('utf8'))
  assert.deepEqual(feed.games, [], 'games.json removes the deleted game')
  assert.doesNotMatch(files['index.html'].toString('utf8'), /Moon Garden/u)
  await assert.rejects(readFile(join(root, 'game', '.studio', 'published.json')), { code: 'ENOENT' })
})

test('publishing the game wall uploads lightweight on-demand wall/index.html, games.json, and all unpublished or updated games in a single commit', async (t) => {
  const { command, readCalls, repoFiles } = await makeFakeGh(t, { login: 'octocat' })
  const approval = approvalAnswering('allowed-once')
  const { root, call } = await harness(t, { approval, config: { ghPath: command, pagesTimeoutMs: 200 } })

  await call('game_studio_create', { path: 'isle', title: 'Lantern Isle', template: 'voxel' })
  const pubWall = await call('game_studio_publish', { wall: true })
  assert.equal(pubWall.url, 'https://octocat.github.io/dsh-games/wall/')
  assert.equal(pubWall.slug, 'wall')

  // Approval prompt lists the games that will be published alongside the wall.
  assert.equal(approval.asked.length, 1)
  assert.match(approval.asked[0].displayReason.zh, /Moon Garden/u)
  assert.match(approval.asked[0].displayReason.zh, /Lantern Isle/u)
  assert.match(approval.asked[0].displayReason.en, /Moon Garden/u)
  assert.match(approval.asked[0].displayReason.en, /Lantern Isle/u)

  // All unpublished games and wall/index.html are uploaded in a single commit.
  const calls = await readCalls()
  assert.equal(calls.filter(c => c.method === 'POST' && c.path === 'repos/octocat/dsh-games/git/commits').length, 1, 'exactly one commit for wall + all games')
  assert.equal(calls.filter(c => c.method === 'PATCH' && c.path === 'repos/octocat/dsh-games/git/refs/heads/main').length, 1, 'exactly one ref update')

  const files = await repoFiles('dsh-games')
  assert.ok(files['wall/index.html'], 'wall/index.html uploaded')
  assert.ok(files['wall/index.html'].byteLength < 20_000, 'wall/index.html is a lightweight on-demand page without inline game HTML or three.js')
  const wallHtml = files['wall/index.html'].toString('utf8')
  assert.match(wallHtml, /"\.\.\/games\.json"/u)
  assert.match(wallHtml, /connect-src 'self'; frame-src 'self'/u)
  assert.ok(files['game/index.html'], 'unpublished 2D game uploaded in same commit')
  assert.ok(files['game/cover.svg'], '2D game cover uploaded in same commit')
  assert.ok(files['isle/index.html'], 'unpublished 3D game uploaded in same commit')
  assert.ok(files['isle/cover.svg'], '3D game cover uploaded in same commit')

  const marker = JSON.parse(files['.dsh-game-studio.json'].toString('utf8'))
  assert.equal(marker.wall.games, 2)
  assert.ok(typeof marker.wall.publishedAt === 'string')
  assert.deepEqual(Object.keys(marker.games).sort(), ['game', 'isle'])
  assert.match(files['index.html'].toString('utf8'), /href="\.\/wall\/"/u)

  const feed = JSON.parse(files['games.json'].toString('utf8'))
  assert.equal(feed.games.length, 2)
  assert.deepEqual(feed.games.map(g => g.slug).sort(), ['game', 'isle'])

  // Local .studio/published.json written for each game included in the wall publish.
  const pubGame = JSON.parse(await readFile(join(root, 'game', '.studio', 'published.json'), 'utf8'))
  const pubIsle = JSON.parse(await readFile(join(root, 'isle', '.studio', 'published.json'), 'utf8'))
  assert.equal(pubGame.url, 'https://octocat.github.io/dsh-games/game/')
  assert.equal(pubIsle.url, 'https://octocat.github.io/dsh-games/isle/')
})

test('waitForPages returns status building without failing when Pages stays building, and throws PAGES_ERRORED when Pages build errors', async (t) => {
  const buildingGh = await makeFakeGh(t, { login: 'octocat', pagesMode: 'building' })
  const approval = approvalAnswering('allowed-once')
  const buildingHarness = await harness(t, { approval, config: { ghPath: buildingGh.command, pagesTimeoutMs: 120 } })

  const pending = await buildingHarness.call('game_studio_publish', { path: 'game' })
  assert.equal(pending.status, 'building')
  assert.equal(pending.url, 'https://octocat.github.io/dsh-games/game/')
  assert.match(pending.note, /still deploying/u)

  const erroredGh = await makeFakeGh(t, { login: 'octocat', pagesMode: 'errored' })
  const erroredHarness = await harness(t, { approval, config: { ghPath: erroredGh.command, pagesTimeoutMs: 200 } })
  await assert.rejects(
    erroredHarness.call('game_studio_publish', { path: 'game' }),
    (err) => err.code === 'PAGES_ERRORED' && /errored/u.test(err.message),
  )
})

test('removing an unpublished project with the same folder name as a published project fails with NOT_PUBLISHED, makes zero write requests, and keeps the published project intact', async (t) => {
  const { command, writeCalls, repoFiles } = await makeFakeGh(t, { login: 'octocat' })
  const approval = approvalAnswering('allowed-once')
  const { root, call } = await harness(t, { approval, config: { ghPath: command, pagesTimeoutMs: 200 } })

  // Project X at 'game' is published; Project Y at 'other/game' has the same folder name and was never published.
  await call('game_studio_create', { path: 'other/game', title: 'Other Game' })
  await call('game_studio_publish', { path: 'game' })

  // Also plant a stale .studio/published.json in Y pointing to 'game' to ensure neither stale local record nor folder name can delete X.
  const stalePubPath = join(root, 'other/game', '.studio', 'published.json')
  await writeFile(stalePubPath, JSON.stringify({ url: 'https://octocat.github.io/dsh-games/game/', repo: 'octocat/dsh-games', slug: 'game', publishedAt: new Date().toISOString(), buildId: 'stale' }))

  const writesBeforeRemove = (await writeCalls()).length

  await assert.rejects(
    call('game_studio_publish', { path: 'other/game', remove: true }),
    (err) => err.code === 'NOT_PUBLISHED' && /octocat\/dsh-games/u.test(err.message),
  )
  assert.equal((await writeCalls()).length, writesBeforeRemove, 'zero write requests when removing an unpublished project')

  // Stale local published.json in Y was cleaned up, while X's files in the repo are still intact.
  await assert.rejects(readFile(stalePubPath), { code: 'ENOENT' })
  const files = await repoFiles('dsh-games')
  assert.ok(files['game/index.html'], 'Project X game/index.html is still in the repo')
  const marker = JSON.parse(files['.dsh-game-studio.json'].toString('utf8'))
  assert.equal(marker.games.game.title, 'Moon Garden')

  // Removing wall when wall is null in manifest also fails with NOT_PUBLISHED and zero write requests.
  await assert.rejects(
    call('game_studio_publish', { wall: true, remove: true }),
    (err) => err.code === 'NOT_PUBLISHED',
  )
  assert.equal((await writeCalls()).length, writesBeforeRemove, 'zero write requests when removing unpublished wall')
})

test('newly created repository retries reading initial branch ref when the first 2 reads return 404 and succeeds on the 3rd attempt', async (t) => {
  const { command, readCalls, repoFiles } = await makeFakeGh(t, { login: 'octocat', initialRef404Count: 2 })
  const approval = approvalAnswering('allowed-once')
  const { call } = await harness(t, { approval, config: { ghPath: command, pagesTimeoutMs: 200 } })

  const published = await call('game_studio_publish', { path: 'game' })
  assert.equal(published.url, 'https://octocat.github.io/dsh-games/game/')
  assert.equal(published.status, 'built')

  const refGets = (await readCalls()).filter(c => c.method === 'GET' && c.path === 'repos/octocat/dsh-games/git/ref/heads/main')
  assert.equal(refGets.length, 3, 'retried GET git/ref/heads/main twice after 404 and succeeded on 3rd attempt')
  const files = await repoFiles('dsh-games')
  assert.ok(files['game/index.html'])
})

test('publishing and republishing use the repository default_branch (master) for ref reads, ref updates, and Pages source', async (t) => {
  const { command, readCalls, readState } = await makeFakeGh(t, { login: 'octocat', defaultBranch: 'master' })
  const approval = approvalAnswering('allowed-once')
  const { root, call } = await harness(t, { approval, config: { ghPath: command, pagesTimeoutMs: 200 } })

  const first = await call('game_studio_publish', { path: 'game' })
  assert.equal(first.url, 'https://octocat.github.io/dsh-games/game/')

  const codePath = join(root, 'game', 'game.js')
  await writeFile(codePath, `${await readFile(codePath, 'utf8')}\n// master branch update\n`)
  await call('game_studio_build', { path: 'game', note: 'master-v2' })
  const second = await call('game_studio_publish', { path: 'game' })
  assert.equal(second.url, 'https://octocat.github.io/dsh-games/game/')

  const calls = await readCalls()
  assert.ok(calls.some(c => c.method === 'GET' && c.path === 'repos/octocat/dsh-games/git/ref/heads/master'), 'read refs/heads/master')
  assert.ok(calls.some(c => c.method === 'PATCH' && c.path === 'repos/octocat/dsh-games/git/refs/heads/master'), 'updated refs/heads/master')
  assert.equal(calls.filter(c => /heads\/main/u.test(c.path)).length, 0, 'never requested heads/main')

  const st = await readState()
  assert.equal(st.repos['octocat/dsh-games'].pages.source.branch, 'master', 'Pages source.branch is master')
})

test('network error during gh api user throws GH_FAILED with stderr details instead of GH_NOT_LOGGED_IN', async (t) => {
  const { command, writeCalls } = await makeFakeGh(t, { mode: 'network-error' })
  const approval = approvalAnswering('allowed-once')
  const { root, call, runCommand } = await harness(t, { approval, config: { ghPath: command } })

  await assert.rejects(
    call('game_studio_publish', { path: 'game' }),
    (err) => err.code === 'GH_FAILED' && err.code !== 'GH_NOT_LOGGED_IN' && /connection reset by peer/u.test(err.message),
  )
  assert.equal(approval.asked.length, 0)
  assert.deepEqual(await writeCalls(), [])

  const viaCommand = await runCommand(`publish ${JSON.stringify({ project: join(root, 'game') })}`)
  assert.equal(viaCommand.kind, 'error')
  assert.equal(JSON.parse(viaCommand.text).code, 'GH_FAILED')
})

test('publishing uploads shrunk PNG or JPEG cover with matching extension and cleans up old cover extension when republished', async (t) => {
  const { command, readCalls, repoFiles } = await makeFakeGh(t, { login: 'octocat' })
  const approval = approvalAnswering('allowed-once')
  const { root, call } = await harness(t, { approval, config: { ghPath: command, pagesTimeoutMs: 200 } })

  const gameDir = join(root, 'game')
  const big = new PNG({ width: 1024, height: 1024 })
  big.data.fill(200)
  await writeFile(join(gameDir, 'assets', 'hero.png'), PNG.sync.write(big))
  const manifest = JSON.parse(await readFile(join(gameDir, 'game.json'), 'utf8'))
  manifest.slots.hero.file = 'assets/hero.png'
  await writeFile(join(gameDir, 'game.json'), JSON.stringify(manifest, null, 2))
  await call('game_studio_build', { path: 'game', note: 'png hero' })

  await call('game_studio_publish', { path: 'game' })
  let files = await repoFiles('dsh-games')
  assert.ok(files['game/cover.png'], 'game/cover.png uploaded')
  assert.equal(files['game/cover.png'].readUInt32BE(16), 480, 'PNG cover shrunk to 480px width')
  let feed = JSON.parse(files['games.json'].toString('utf8'))
  assert.equal(feed.games[0].cover, 'game/cover.png')

  // Now add a playtest screenshot (.studio/cover.jpg) and republish; old cover.png must be deleted.
  await writeFile(join(gameDir, '.studio', 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  await call('game_studio_build', { path: 'game', note: 'jpg cover' })
  await call('game_studio_publish', { path: 'game' })

  const treePosts = (await readCalls()).filter(c => c.method === 'POST' && c.path === 'repos/octocat/dsh-games/git/trees')
  const lastTree = treePosts.at(-1).body.tree
  assert.ok(lastTree.some(entry => entry.path === 'game/cover.png' && entry.sha === null), 'old game/cover.png removed with sha: null')

  files = await repoFiles('dsh-games')
  assert.equal(files['game/cover.png'], undefined, 'old cover.png is gone from tree')
  assert.deepEqual(files['game/cover.jpg'], Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'new cover.jpg is uploaded')
  feed = JSON.parse(files['games.json'].toString('utf8'))
  assert.equal(feed.games[0].cover, 'game/cover.jpg')
})

test('wall publish skips re-uploading already-current game blobs and only lists unpublished or updated games in approval', async (t) => {
  const { command, readCalls, repoFiles } = await makeFakeGh(t, { login: 'octocat' })
  const approval = approvalAnswering('allowed-once')
  const { call } = await harness(t, { approval, config: { ghPath: command, pagesTimeoutMs: 200 } })

  // Publish 'game' first so its buildId is already up-to-date on the remote.
  await call('game_studio_publish', { path: 'game' })
  await call('game_studio_create', { path: 'isle', title: 'Lantern Isle', template: 'voxel' })
  const callsBeforeWall = (await readCalls()).length

  await call('game_studio_publish', { wall: true })
  const wallNotice = approval.asked.at(-1).displayReason
  assert.match(wallNotice.zh, /Lantern Isle/u, 'unpublished game is listed in wall approval')
  assert.doesNotMatch(wallNotice.zh, /Moon Garden/u, 'already-published unchanged game is not listed in wall approval')

  const wallCalls = (await readCalls()).slice(callsBeforeWall)
  assert.equal(wallCalls.filter(c => c.method === 'POST' && c.path === 'repos/octocat/dsh-games/git/commits').length, 1, 'single commit for wall publish')
  const lastTree = wallCalls.filter(c => c.method === 'POST' && c.path === 'repos/octocat/dsh-games/git/trees').at(-1).body.tree
  assert.ok(lastTree.some(entry => entry.path === 'isle/index.html'), 'new game isle/index.html is in the tree update')
  assert.ok(!lastTree.some(entry => entry.path === 'game/index.html'), 'unchanged game/index.html is not re-uploaded')

  const files = await repoFiles('dsh-games')
  assert.ok(files['game/index.html'])
  assert.ok(files['isle/index.html'])
  assert.ok(files['wall/index.html'])
})

test('gh api retries transient network errors on GET and git object writes, does not retry POST user/repos, and verifies remote ref sha on PATCH 422', async (t) => {
  // 1) Transient EOF on POST git/trees and HTTP 422 after updating ref on PATCH git/refs/heads/main both recover cleanly.
  const recoverable = await makeFakeGh(t, {
    login: 'octocat',
    transientFailures: { 'POST repos/octocat/dsh-games/git/trees': 1 },
    patchRef422Once: true,
  })
  const approval = approvalAnswering('allowed-once')
  const okHarness = await harness(t, { approval, config: { ghPath: recoverable.command, pagesTimeoutMs: 200 } })

  const published = await okHarness.call('game_studio_publish', { path: 'game' })
  assert.equal(published.url, 'https://octocat.github.io/dsh-games/game/')
  const calls = await recoverable.readCalls()
  assert.equal(calls.filter(c => c.method === 'POST' && c.path === 'repos/octocat/dsh-games/git/trees').length, 2, 'POST git/trees retried once after EOF and succeeded')
  assert.equal(calls.filter(c => c.method === 'PATCH' && c.path === 'repos/octocat/dsh-games/git/refs/heads/main').length, 1, 'PATCH ref called once')
  const files = await recoverable.repoFiles('dsh-games')
  assert.ok(files['game/index.html'], 'ref was updated and verified despite 422 response')

  // 2) Transient EOF on POST user/repos is NOT retried (non-idempotent repository creation).
  const noRetryCreate = await makeFakeGh(t, {
    login: 'octocat',
    transientFailures: { 'POST user/repos': 1 },
  })
  const failHarness = await harness(t, { approval, config: { ghPath: noRetryCreate.command, pagesTimeoutMs: 200 } })
  await assert.rejects(
    failHarness.call('game_studio_publish', { path: 'game' }),
    (err) => err.code === 'GH_FAILED' && /EOF/u.test(err.message),
  )
  const failCalls = await noRetryCreate.readCalls()
  assert.equal(failCalls.filter(c => c.method === 'POST' && c.path === 'user/repos').length, 1, 'POST user/repos is never retried')
})

