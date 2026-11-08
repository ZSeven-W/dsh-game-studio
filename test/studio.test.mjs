// Project, build and asset-slot flow against the real template, with a fake
// image generator standing in for the paid provider.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PNG } from 'pngjs'
import { applyCandidate, composePrompt, generateCandidates, reserveNumbers, revertSlot, withProjectLock, writeState } from '../src/assets.ts'
import { buildProject } from '../src/build.ts'
import { commandErrorCopy, en as localeEn, liveShare, publishState, shareCopy, zh as localeZh } from '../src/client/locales.ts'
import { findGh, ghInstallHint, requireGh } from '../src/github.ts'
import { checkSprite, decodePng, fitSprite } from '../src/png.ts'
import { estimateOpenaiCost } from '../src/pricing.ts'
import { createProject, loadLedger, loadManifest, paths, templateDir } from '../src/project.ts'
import { askToSpend, spendNotice } from '../src/spend.ts'
import { loadReference } from '../src/reference.ts'
import { shareAddress, shareHeartbeatPath, shareInfo, startShare, stopAllShares, stopShare } from '../src/share.ts'
import { cloudflaredInstallHint, findCloudflared, requireCloudflared } from '../src/tunnel.ts'
import { listVersions, restoreFiles } from '../src/versions.ts'
import { resolveInside, writeJson } from '../src/util.ts'

/** A size×size PNG with an opaque disc of the given radius, transparent elsewhere (or fully opaque). */
function discPng(size, radius, { opaqueBackground = false, cx = size / 2, cy = size / 2 } = {}) {
  const png = new PNG({ width: size, height: size })
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
      png.data[i] = inside ? 220 : 255
      png.data[i + 1] = inside ? 80 : 255
      png.data[i + 2] = inside ? 40 : 255
      png.data[i + 3] = inside || opaqueBackground ? 255 : 0
    }
  }
  return new Uint8Array(PNG.sync.write(png))
}

/** One image per request, handed out in request order. */
function fakeGenerator(images) {
  const calls = []
  const generate = async (request) => {
    calls.push(request)
    return { images: [images[(calls.length - 1) % images.length]], model: 'fake-image-1', provider: 'fake', usage: { inputTokens: 10, outputTokens: 20 } }
  }
  return { generate, calls }
}

async function tempProject(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-studio-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'my-game')
  await createProject(dir, { title: 'Moon Garden', style: 'watercolor storybook' })
  return { root, dir }
}

test('sprite checks accept a cut-out and reject an opaque or edge-touching image', () => {
  const ok = checkSprite(decodePng(discPng(200, 60)))
  assert.equal(ok.pass, true, ok.problems.join())
  const opaque = checkSprite(decodePng(discPng(200, 60, { opaqueBackground: true })))
  assert.equal(opaque.pass, false)
  assert.match(opaque.problems.join(), /transparency/u)
  const clipped = checkSprite(decodePng(discPng(200, 80, { cx: 20 })))
  assert.equal(clipped.pass, false)
  assert.match(clipped.problems.join(), /edge/u)
})

test('fitSprite crops to the subject and centres it with padding', () => {
  const fitted = fitSprite(decodePng(discPng(400, 50, { cx: 100, cy: 300 })), 128)
  assert.equal(fitted.width, 128)
  const checks = checkSprite(fitted)
  assert.equal(checks.pass, true, checks.problems.join())
  assert.ok(Math.abs(checks.bbox.x + checks.bbox.w / 2 - 64) <= 1)
  assert.ok(checks.bbox.w >= 110 && checks.bbox.w <= 116, `width ${checks.bbox.w}`)
})

test('create and build produce one self-contained HTML file with a no-network CSP', async (t) => {
  const { dir } = await tempProject(t)
  const manifest = await loadManifest(dir)
  assert.equal(manifest.title, 'Moon Garden')
  assert.equal(manifest.style, 'watercolor storybook')
  const ledger = await loadLedger(dir)
  assert.deepEqual(Object.keys(ledger.assets).sort(), Object.keys(manifest.slots).sort())
  const build = await buildProject(dir)
  const html = await readFile(build.artifact, 'utf8')
  assert.match(html, /Content-Security-Policy/u)
  assert.match(html, /connect-src 'none'/u)
  assert.match(html, /window\.GAME=/u)
  assert.doesNotMatch(html, /src="https?:|href="https?:/u)
  // Exactly the two inline scripts we emit; nothing in the payload closed one early.
  assert.equal(html.match(/<\/script>/gu).length, 2)
  for (const slot of Object.keys(manifest.slots)) assert.match(html, new RegExp(`"${slot}":"data:image/`, 'u'))
})

test('a "</script>" inside game code or the title cannot break out of the inline script', async (t) => {
  const { dir } = await tempProject(t)
  const manifest = await loadManifest(dir)
  manifest.title = 'Evil </script><img src=x onerror=alert(1)>'
  await writeFile(join(dir, 'game.json'), JSON.stringify(manifest))
  await writeFile(join(dir, 'game.js'), 'var s = "</script><script>alert(1)</script>"; <!-- x\n')
  const build = await buildProject(dir)
  const html = await readFile(build.artifact, 'utf8')
  assert.equal(html.match(/<\/script>/giu).length, 2)
  assert.doesNotMatch(html, /<title>[^<]*<img/u)
})

test('a project refuses to be created over an existing game or outside the workspace', async (t) => {
  const { root, dir } = await tempProject(t)
  await assert.rejects(createProject(dir, { title: 'Again' }), /already exists/u)
  assert.throws(() => resolveInside(root, '../elsewhere'), /inside the session working directory/u)
})

test('generate → apply → revert keeps the game buildable and the ledger honest', async (t) => {
  const { dir } = await tempProject(t)
  const before = await loadManifest(dir)
  const { generate, calls } = fakeGenerator([discPng(1024, 300), discPng(1024, 300, { opaqueBackground: true })])
  const { candidates } = await generateCandidates(dir, 'hero', 'a fox in a red scarf', { count: 2, quality: 'low' }, generate)
  assert.equal(calls.length, 2, 'one request per candidate')
  assert.equal(calls[0].n, 1)
  assert.equal(calls[0].background, 'transparent')
  assert.match(calls[0].prompt, /watercolor storybook/u)
  assert.match(calls[0].prompt, /a fox in a red scarf/u)
  assert.notEqual(calls[0].prompt, calls[1].prompt, 'each candidate is a different take')
  assert.equal(candidates.length, 2)
  assert.deepEqual(candidates.map(item => item.number), [1, 2])
  assert.equal(candidates[0].checks.pass, true)
  assert.equal(candidates[1].checks.pass, false)

  await assert.rejects(applyCandidate(dir, 'hero', candidates[1].id), /failed its checks/u)
  const { record, build } = await applyCandidate(dir, 'hero', candidates[0].id)
  assert.equal(record.source, 'generated')
  assert.equal(record.prompt, 'a fox in a red scarf')
  const afterApply = await loadManifest(dir)
  assert.equal(afterApply.slots.hero.file, `assets/hero-${candidates[0].id}.png`)
  await stat(join(dir, afterApply.slots.hero.file))
  assert.match(await readFile(build.artifact, 'utf8'), /"hero":"data:image\/png;base64,/u)
  await assert.rejects(stat(join(dir, before.slots.hero.file)), 'the replaced file moves into history')

  const reverted = await revertSlot(dir, 'hero')
  assert.equal(reverted.restored, before.slots.hero.file)
  const afterRevert = await loadManifest(dir)
  assert.deepEqual(afterRevert.slots.hero, before.slots.hero)
  assert.equal((await loadLedger(dir)).assets.hero.source, 'template')
  await assert.rejects(stat(join(dir, afterApply.slots.hero.file)), 'the reverted file is removed')
  await assert.rejects(revertSlot(dir, 'hero'), /no earlier version/u)
})

test('background slots request an opaque JPEG and switch the slot to cover mode', async (t) => {
  const { dir } = await tempProject(t)
  // Minimal JPEG header with a 1536x1024 SOF0 marker is enough for the size check.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x00, 0x06, 0x00, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])
  const { generate, calls } = fakeGenerator([jpeg])
  const { candidates: [candidate] } = await generateCandidates(dir, 'background', 'moonlit garden path', { count: 1, quality: 'low' }, generate)
  assert.equal(calls[0].background, 'opaque')
  assert.equal(calls[0].format, 'jpeg')
  assert.equal(candidate.checks.pass, true, candidate.checks.problems.join())
  assert.equal(candidate.checks.width, 1536)
  await applyCandidate(dir, 'background', candidate.id)
  const manifest = await loadManifest(dir)
  assert.equal(manifest.slots.background.tile, false)
  assert.match(manifest.slots.background.file, /\.jpg$/u)
})

test('a slot file drawn over inside the project is recorded as an edit and can be reverted', async (t) => {
  const { dir } = await tempProject(t)
  const template = await readFile(join(templateDir('collector'), 'assets', 'hero.svg'))
  await writeFile(join(dir, 'assets', 'hero.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>')
  const state = await writeState(dir)
  const ledger = await loadLedger(dir)
  assert.equal(ledger.assets.hero.source, 'edited')
  assert.equal(ledger.assets.hero.basedOn.source, 'template')
  assert.match(ledger.assets.hero.license, /Changed inside this project/u)
  assert.equal(ledger.assets.enemy.source, 'template', 'untouched slots keep their record')
  assert.equal(state.slots.hero.history, 1, 'the recorded version went into history')

  await revertSlot(dir, 'hero')
  assert.deepEqual(await readFile(join(dir, 'assets', 'hero.svg')), template)
  assert.equal((await loadLedger(dir)).assets.hero.source, 'template')
})

test('projects recorded before hashes: untouched files keep their record, edited ones are caught', async (t) => {
  const { dir } = await tempProject(t)
  const ledger = await loadLedger(dir)
  for (const record of Object.values(ledger.assets)) delete record.sha256
  await writeJson(paths.ledger(dir), ledger)
  await writeFile(join(dir, 'assets', 'enemy.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeState(dir)
  const after = await loadLedger(dir)
  assert.equal(after.assets.hero.source, 'template')
  assert.match(after.assets.hero.sha256, /^[0-9a-f]{64}$/u, 'tracking starts from here')
  assert.equal(after.assets.enemy.source, 'edited')
})

test('a version saved under the wrong record before hashes existed comes back labelled as an edit', async (t) => {
  const { dir } = await tempProject(t)
  const manifest = await loadManifest(dir)
  const { sha256: _hash, ...oldRecord } = (await loadLedger(dir)).assets.hero
  const folder = paths.history(dir, 'hero')
  const saved = join(folder, '0001-hero.svg')
  await writeJson(join(folder, '0001.json'), { savedAt: new Date().toISOString(), file: saved, spec: manifest.slots.hero, record: oldRecord })
  await writeFile(saved, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>')
  await revertSlot(dir, 'hero')
  const record = (await loadLedger(dir)).assets.hero
  assert.equal(record.source, 'edited')
  assert.equal(record.basedOn.source, 'template')
})

test('two batches reserving numbers at once never share one', async (t) => {
  const { dir } = await tempProject(t)
  const [a, b] = await Promise.all([reserveNumbers(dir, 'hero', 3), reserveNumbers(dir, 'hero', 2)])
  assert.deepEqual([...a, ...b].sort((x, y) => x - y), [1, 2, 3, 4, 5])
})

test('spend notices give the service, count and estimate; anything but a yes stops the spend', async () => {
  assert.ok(Math.abs(estimateOpenaiCost('gpt-image-2.5-flare', 'low', false, 1) - 0.00708) < 1e-9)
  assert.equal(estimateOpenaiCost('gpt-image-2.5-flare', 'high', false, 1), null, 'no made-up price for unmeasured quality')
  // Measured 2026-11-03: one low image with a reference cost 1,185 input + 196 output tokens.
  assert.ok(Math.abs(estimateOpenaiCost('gpt-image-2.5-flare', 'low', false, 1, true) - 0.01460) < 1e-9)
  const withReference = spendNotice({ provider: 'openai', model: 'gpt-image-2.5-flare', label: 'Hero', wide: false, count: 1, quality: 'low', reference: 'fox.png' })
  assert.match(withReference.zh, /预计约 \$0\.01/u)
  const high = spendNotice({ provider: 'openai', model: 'gpt-image-2.5-flare', label: 'Hero', wide: false, count: 2, quality: 'high' })
  assert.match(high.zh, /还没有估价/u)
  const codex = spendNotice({ provider: 'codex', model: '', label: 'Enemy', wide: false, count: 1, quality: 'auto' })
  assert.match(codex.en, /Codex plan/u)
  const exec = { agent: { id: 's' }, signal: new AbortController().signal }
  const answer = (outcome) => ({ request: async () => outcome })
  await askToSpend(answer('allowed-once'), exec, 'tool', high)
  await assert.rejects(askToSpend(answer('rejected'), exec, 'tool', high), /declined/u)
  await assert.rejects(askToSpend(answer('unavailable'), exec, 'tool', high), /Nobody could approve/u)
  await assert.rejects(askToSpend(answer('cancelled'), exec, 'tool', high), /cancelled/u)
  await assert.rejects(askToSpend(undefined, exec, 'tool', high), /Nobody can approve/u)
})

test('a game that asks for the three runtime gets it inlined ahead of its code; unknown runtimes are refused', async (t) => {
  const { dir } = await tempProject(t)
  const manifest = await loadManifest(dir)
  await writeJson(paths.manifest(dir), { ...manifest, runtime: ['three'] })
  const html = await readFile((await buildProject(dir)).artifact, 'utf8')
  const vendor = html.indexOf('three.js 0.187.0')
  assert.ok(vendor > 0, 'three is inlined')
  assert.ok(vendor < html.indexOf('window.GAME='), 'before the game data and code')
  assert.doesNotMatch(html, /<script[^>]+src=/u, 'still one self-contained file')
  await writeJson(paths.manifest(dir), { ...manifest, runtime: ['unity'] })
  await assert.rejects(buildProject(dir), /Unknown runtime "unity"/u)
})

test('the build tells the game which slots hold the user\'s own art', async (t) => {
  const { dir } = await tempProject(t)
  const read = async () => JSON.parse(/window\.GAME=(\{.*?\});<\/script>/u.exec(await readFile((await buildProject(dir)).artifact, 'utf8'))[1])
  assert.equal((await read()).slots.hero.custom, false)
  await writeFile(join(dir, 'assets', 'hero.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeState(dir)
  const game = await read()
  assert.equal(game.slots.hero.custom, true, 'an edited file counts as custom art')
  assert.equal(game.slots.enemy.custom, false)
})

test('texture slots ask for seamless ground and keep repeating after apply', async (t) => {
  const { dir } = await tempProject(t)
  const manifest = await loadManifest(dir)
  manifest.slots.background = { ...manifest.slots.background, tile: true, texture: true }
  await writeJson(paths.manifest(dir), manifest)
  assert.match(composePrompt(manifest, 'background', manifest.slots.background, 'mossy stones'), /seamless, tileable ground texture/u)
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x00, 0x06, 0x00, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])
  const { candidates: [candidate] } = await generateCandidates(dir, 'background', 'mossy stones', { count: 1, quality: 'low' }, fakeGenerator([jpeg]).generate)
  await applyCandidate(dir, 'background', candidate.id)
  assert.equal((await loadManifest(dir)).slots.background.tile, true)
})

test('the voxel template makes a 3D game: three.js inlined, ground as a repeating texture, voxel models by default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'game-studio-voxel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'isle')
  const manifest = await createProject(dir, { title: 'Lantern Isle', template: 'voxel' })
  assert.deepEqual(manifest.runtime, ['three'])
  assert.equal(manifest.slots.background.texture, true)
  const html = await readFile((await buildProject(dir)).artifact, 'utf8')
  assert.ok(html.indexOf('three.js 0.187.0') < html.indexOf('window.GAME='))
  const game = JSON.parse(/window\.GAME=(\{.*?\});<\/script>/u.exec(html)[1])
  assert.deepEqual(Object.values(game.slots).map(slot => slot.custom), [false, false, false, false])
  assert.match(html, /heroMode/u)
})

test('every build that changes the game is a version, and going back is itself undoable', async (t) => {
  const { dir } = await tempProject(t)
  await buildProject(dir, 'Created')
  await buildProject(dir, 'Nothing changed')
  assert.deepEqual((await listVersions(dir)).map(v => v.note), ['Created'], 'an identical build adds no version')

  const manifest = await loadManifest(dir)
  await writeJson(paths.manifest(dir), { ...manifest, rules: { ...manifest.rules, hearts: 5 } })
  await buildProject(dir, 'Five hearts')
  const { candidates: [candidate] } = await generateCandidates(dir, 'hero', 'a fox', { count: 1, quality: 'low' }, fakeGenerator([discPng(1024, 300)]).generate)
  const applied = await applyCandidate(dir, 'hero', candidate.id)
  assert.deepEqual((await listVersions(dir)).map(v => v.note), ['Applied hero #1', 'Five hearts', 'Created'])

  await withProjectLock(dir, () => restoreFiles(dir, 1))
  await buildProject(dir, 'Back to version 1')
  const back = await loadManifest(dir)
  assert.equal(back.rules.hearts, manifest.rules.hearts)
  assert.equal(back.slots.hero.file, 'assets/hero.svg')
  await assert.rejects(stat(join(dir, applied.record.file)), 'files the old version did not have are removed')
  assert.equal((await loadLedger(dir)).assets.hero.source, 'template', 'the ledger travels with the version')

  await withProjectLock(dir, () => restoreFiles(dir, 3))
  await buildProject(dir, 'Back to version 3')
  assert.equal((await loadManifest(dir)).slots.hero.file, applied.record.file)
  await stat(join(dir, applied.record.file))
  assert.deepEqual((await listVersions(dir)).map(v => v.number).slice(0, 2), [5, 4])
  await assert.rejects(withProjectLock(dir, () => restoreFiles(dir, 99)), /no version 99/u)
})

test('reference images come only from the workspace or chat attachments, and must be pictures', async (t) => {
  const { root, dir } = await tempProject(t)
  const png = discPng(64, 20)
  await writeFile(join(dir, 'ref.png'), png)
  const ok = await loadReference(dir, 'ref.png')
  assert.equal(ok.mime, 'image/png')
  assert.equal(ok.name, 'ref.png')

  const outside = await mkdtemp(join(tmpdir(), 'game-studio-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'secret.png'), png)
  await assert.rejects(loadReference(dir, join(outside, 'secret.png')), /working directory or a chat attachment/u)
  await symlink(join(outside, 'secret.png'), join(dir, 'link.png'))
  await assert.rejects(loadReference(dir, 'link.png'), /working directory or a chat attachment/u, 'a symlink cannot reach outside')

  // The Harness stores chat attachments by content hash, so the file name means nothing to the user.
  const home = join(root, 'dsh-home')
  const hash = 'd839bd29c7f7062772e3aa41565737f729ef4d25ae304d6ea9cdce30e445cd97'
  await mkdir(join(home, 'attachments', 'v1', 'objects', 'd8'), { recursive: true })
  await writeFile(join(home, 'attachments', 'v1', 'objects', 'd8', hash), png)
  process.env.DSH_HOME = home
  t.after(() => { delete process.env.DSH_HOME })
  const attached = await loadReference(dir, join(home, 'attachments', 'v1', 'objects', 'd8', hash))
  assert.equal(attached.name, 'chat-attachment.png')
  assert.equal(attached.fromChat, true)
  assert.equal(ok.fromChat, undefined)
  const notice = spendNotice({ provider: 'openai', model: 'gpt-image-2.5-flare', label: 'Fox', wide: false, count: 1, quality: 'low', reference: attached.name, referenceFromChat: true })
  assert.match(notice.zh, /按你在聊天里附上的图来画/u)
  assert.match(notice.en, /the image you attached in chat/u)
  assert.doesNotMatch(notice.zh + notice.en, /chat-attachment|d839bd/u)

  await writeFile(join(dir, 'notes.png'), 'not really a picture')
  await assert.rejects(loadReference(dir, 'notes.png'), /PNG, JPEG or WebP/u)
})

test('a phone link serves only the latest build behind its token and stops when asked', async (t) => {
  const { dir } = await tempProject(t)
  await assert.rejects(startShare(dir, 5, '127.0.0.1'), /Build the game before sharing/u)
  await buildProject(dir)
  const info = await startShare(dir, 5, '127.0.0.1')
  t.after(() => stopShare(dir))
  assert.equal(info.scope, 'lan')
  assert.match(info.qrSvg, /^<svg/u)
  const page = await fetch(info.url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<title>Moon Garden<\/title>/u)
  const base = new URL(info.url)
  assert.equal((await fetch(`${base.origin}/wrong-token/`)).status, 404)
  assert.equal((await fetch(`${base.origin}/`)).status, 404)
  assert.equal((await fetch(`${base.origin}${base.pathname.slice(0, -1)}`, { redirect: 'manual' })).status, 302)
  assert.equal(stopShare(dir), true)
  await assert.rejects(fetch(info.url), 'closed after stop')
})

const FAKE_CLOUDFLARED = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') process.exit(0)
if (process.env.FAKE_CLOUDFLARED_LOG) {
  appendFileSync(process.env.FAKE_CLOUDFLARED_LOG, JSON.stringify({
    pid: process.pid, args, forceColor: process.env.FORCE_COLOR ?? null,
  }) + '\\n')
}
process.on('SIGTERM', () => process.exit(0))
const mode = process.env.FAKE_CLOUDFLARED_MODE || 'ok'
if (mode === 'hang') {
  console.error('INF Requesting new quick Tunnel on trycloudflare.com...')
  setTimeout(() => {}, 10_000)
} else if (mode === 'fail') {
  console.error('ERR failed to request quick Tunnel: edge connection refused')
  process.exit(1)
} else if (mode === 'drop') {
  console.error('INF |  https://\\u001b[1mfake-abc\\u001b[22m.trycloudflare.com  |')
  setTimeout(() => process.exit(1), 300)
} else if (mode.startsWith('delay:')) {
  const delayMs = Number(mode.slice('delay:'.length)) || 400
  setTimeout(() => {
    console.error('INF |  https://\\u001b[1mfake-abc\\u001b[22m.trycloudflare.com  |')
  }, delayMs)
  setTimeout(() => {}, 10_000)
} else {
  console.error('INF |  https://\\u001b[1mfake-abc\\u001b[22m.trycloudflare.com  |')
  setTimeout(() => {}, 10_000)
}
`

let sharedCloudflared

async function ensureFakeCloudflared() {
  if (sharedCloudflared) return sharedCloudflared
  const binDir = await mkdtemp(join(tmpdir(), 'game-studio-cf-bin-'))
  const command = join(binDir, 'cloudflared')
  await writeFile(command, FAKE_CLOUDFLARED)
  await chmod(command, 0o755)
  spawnSync(command, ['--version'])
  process.once('exit', () => { spawnSync('rm', ['-rf', binDir]) })
  sharedCloudflared = command
  return command
}

async function fakeCloudflared(t, mode = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'game-studio-'))
  const dir = join(root, 'my-game')
  await createProject(dir, { title: 'Moon Garden', style: 'watercolor storybook' })
  await buildProject(dir)
  const command = await ensureFakeCloudflared()
  const logFile = join(root, 'cloudflared.jsonl')
  await writeFile(logFile, '')
  process.env.FAKE_CLOUDFLARED_MODE = mode
  process.env.FAKE_CLOUDFLARED_LOG = logFile
  const readLog = async () => (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  t.after(async () => {
    stopShare(dir)
    delete process.env.FAKE_CLOUDFLARED_MODE
    delete process.env.FAKE_CLOUDFLARED_LOG
    const entries = await readLog().catch(() => [])
    for (const entry of entries) {
      try { process.kill(entry.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true })
  })
  return { root, dir, command, readLog }
}

async function assertProcessDead(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { break }
    await new Promise(r => setTimeout(r, 15))
  }
  assert.throws(() => process.kill(pid, 0))
}

async function waitForLog(readLog, count = 1, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = await readLog().catch(() => [])
    if (entries.length >= count) return entries
    await new Promise(r => setTimeout(r, 15))
  }
  return readLog()
}

async function waitForCondition(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(r => setTimeout(r, 20))
  }
}

test('findCloudflared and requireCloudflared locate a configured binary or throw NO_TUNNEL with platform install hints', async (t) => {
  const { root, command } = await fakeCloudflared(t)
  assert.equal(findCloudflared(command), command)
  const missing = join(root, 'no-such-cloudflared')
  assert.equal(findCloudflared(missing), undefined)
  assert.throws(() => requireCloudflared(missing), (err) => err.code === 'NO_TUNNEL' && /brew install cloudflared/u.test(err.message))
  assert.match(cloudflaredInstallHint('darwin'), /brew install cloudflared/u)
  assert.match(cloudflaredInstallHint('win32'), /winget install --id Cloudflare\.cloudflared/u)
  assert.match(cloudflaredInstallHint('linux'), /developers\.cloudflare\.com/u)
})

test('public share binds 127.0.0.1 only, strips ANSI from cloudflared stderr, and serves behind the token with x-robots-tag', async (t) => {
  const { dir, command, readLog } = await fakeCloudflared(t, 'ok')
  process.env.FORCE_COLOR = '1'
  t.after(() => { delete process.env.FORCE_COLOR })
  const info = await startShare(dir, 5, { scope: 'public', host: '0.0.0.0', cloudflaredPath: command, tunnelTimeoutMs: 2_000 })
  assert.equal(info.scope, 'public')
  assert.match(info.url, /^https:\/\/fake-abc\.trycloudflare\.com\/[A-Za-z0-9_-]{24}\/$/u)
  assert.match(info.qrSvg, /^<svg/u)
  const bound = shareAddress(dir)
  assert.ok(bound)
  assert.equal(bound.address, '127.0.0.1')

  const tokenPath = new URL(info.url).pathname
  const localBase = `http://127.0.0.1:${bound.port}`
  const page = await fetch(`${localBase}${tokenPath}`)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.match(await page.text(), /<title>Moon Garden<\/title>/u)
  assert.equal((await fetch(`${localBase}/`)).status, 404)
  assert.equal((await fetch(`${localBase}/wrong-token/`)).status, 404)

  const [entry] = await readLog()
  assert.deepEqual(entry.args, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${bound.port}`])
  assert.equal(entry.forceColor, null, 'FORCE_COLOR is removed before spawning cloudflared')
})

test('stopShare kills the cloudflared process and closes the local HTTP server', async (t) => {
  const { dir, command, readLog } = await fakeCloudflared(t, 'ok')
  const info = await startShare(dir, 5, { scope: 'public', cloudflaredPath: command, tunnelTimeoutMs: 2_000 })
  const bound = shareAddress(dir)
  const [entry] = await readLog()
  const tokenPath = new URL(info.url).pathname

  assert.equal(stopShare(dir), true)
  assert.equal(shareInfo(dir), null)
  await assertProcessDead(entry.pid)
  await assert.rejects(fetch(`http://127.0.0.1:${bound.port}${tokenPath}`))
})

test('public share expiry stops both the HTTP server and the cloudflared process', async (t) => {
  const { dir, command, readLog } = await fakeCloudflared(t, 'ok')
  await startShare(dir, 5, { scope: 'public', cloudflaredPath: command, tunnelTimeoutMs: 2_000, ttlMs: 150 })
  const [entry] = await readLog()
  await waitForCondition(() => shareInfo(dir) === null)
  assert.equal(shareInfo(dir), null)
  await assertProcessDead(entry.pid)
})

test('tunnel timeout throws TUNNEL_TIMEOUT with stderr tail and kills the hanging cloudflared process', async (t) => {
  const { dir, command, readLog } = await fakeCloudflared(t, 'hang')
  await assert.rejects(
    startShare(dir, 5, { scope: 'public', cloudflaredPath: command, tunnelTimeoutMs: 1_500 }),
    (err) => err.code === 'TUNNEL_TIMEOUT' && /Requesting new quick Tunnel/u.test(err.message),
  )
  assert.equal(shareInfo(dir), null)
  const [entry] = await readLog()
  assert.ok(entry?.pid, 'cloudflared was started')
  await assertProcessDead(entry.pid)
})

test('early cloudflared exit before printing a URL throws TUNNEL_FAILED with stderr output', async (t) => {
  const { dir, command } = await fakeCloudflared(t, 'fail')
  await assert.rejects(
    startShare(dir, 5, { scope: 'public', cloudflaredPath: command, tunnelTimeoutMs: 2_000 }),
    (err) => err.code === 'TUNNEL_FAILED' && /edge connection refused/u.test(err.message),
  )
  assert.equal(shareInfo(dir), null)
})

test('unexpected cloudflared exit while sharing automatically cleans up the share and notifies onStopped', async (t) => {
  const { dir, command } = await fakeCloudflared(t, 'drop')
  let notified = false
  const info = await startShare(dir, 5, {
    scope: 'public',
    cloudflaredPath: command,
    tunnelTimeoutMs: 2_000,
    onStopped: () => { notified = true },
  })
  assert.equal(info.scope, 'public')
  assert.ok(shareInfo(dir) !== null)
  await waitForCondition(() => shareInfo(dir) === null && notified)
  assert.equal(shareInfo(dir), null)
  assert.equal(notified, true)
})

test('starting a new share replaces the previous share and kills its tunnel process', async (t) => {
  const { dir, command, readLog } = await fakeCloudflared(t, 'ok')
  await startShare(dir, 5, { scope: 'public', cloudflaredPath: command, tunnelTimeoutMs: 2_000 })
  const [first] = await readLog()
  const lan = await startShare(dir, 5, '127.0.0.1')
  assert.equal(lan.scope, 'lan')
  assert.equal(shareInfo(dir)?.scope, 'lan')
  await assertProcessDead(first.pid)
})

test('stopShare while tunnel is opening returns true, rejects startShare with CANCELLED, and kills cloudflared', async (t) => {
  const { dir, command, readLog } = await fakeCloudflared(t, 'delay:350')
  const pendingShare = startShare(dir, 5, { scope: 'public', cloudflaredPath: command, tunnelTimeoutMs: 2_000 })
  const [entry] = await waitForLog(readLog, 1)
  assert.ok(entry?.pid)
  assert.equal(stopShare(dir), true)
  assert.equal(stopShare(dir), false)
  await assert.rejects(pendingShare, (err) => err.code === 'CANCELLED')
  assert.equal(shareInfo(dir), null)
  await assertProcessDead(entry.pid)
})

test('stopAllShares while tunnel is opening rejects startShare with CANCELLED and kills cloudflared', async (t) => {
  const { dir, command, readLog } = await fakeCloudflared(t, 'delay:350')
  const pendingShare = startShare(dir, 5, { scope: 'public', cloudflaredPath: command, tunnelTimeoutMs: 2_000 })
  const [entry] = await waitForLog(readLog, 1)
  assert.ok(entry?.pid)
  stopAllShares()
  await assert.rejects(pendingShare, (err) => err.code === 'CANCELLED')
  assert.equal(shareInfo(dir), null)
  await assertProcessDead(entry.pid)
})

test('concurrent startShare calls on the same dir leave at most one active share and no orphan cloudflared processes after stopAllShares', async (t) => {
  const { dir, command, readLog } = await fakeCloudflared(t, 'delay:350')
  const first = startShare(dir, 5, { scope: 'public', cloudflaredPath: command, tunnelTimeoutMs: 2_000 })
  await waitForLog(readLog, 1)
  const second = startShare(dir, 5, { scope: 'public', cloudflaredPath: command, tunnelTimeoutMs: 2_000 })
  const results = await Promise.allSettled([first, second])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason?.code === 'CANCELLED').length, 1)

  const sameTick = await Promise.allSettled([
    startShare(dir, 5, { scope: 'public', cloudflaredPath: command, tunnelTimeoutMs: 2_000 }),
    startShare(dir, 5, { scope: 'public', cloudflaredPath: command, tunnelTimeoutMs: 2_000 }),
  ])
  assert.equal(sameTick.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(sameTick.filter(r => r.status === 'rejected' && r.reason?.code === 'CANCELLED').length, 1)

  stopAllShares()
  assert.equal(shareInfo(dir), null)
  const entries = await readLog()
  assert.ok(entries.length >= 2)
  for (const entry of entries) {
    await assertProcessDead(entry.pid)
  }
})

test('aborting signal while tunnel is opening rejects startShare with CANCELLED and kills cloudflared', async (t) => {
  const { dir, command, readLog } = await fakeCloudflared(t, 'delay:500')
  const controller = new AbortController()
  const pendingShare = startShare(dir, 5, {
    scope: 'public',
    cloudflaredPath: command,
    tunnelTimeoutMs: 2_000,
    signal: controller.signal,
  })
  const [entry] = await waitForLog(readLog, 1)
  assert.ok(entry?.pid)
  controller.abort()
  await assert.rejects(pendingShare, (err) => err.code === 'CANCELLED')
  assert.equal(shareInfo(dir), null)
  await assertProcessDead(entry.pid)
})

test('failed public startShare with NO_TUNNEL keeps an existing LAN share running', async (t) => {
  const { root, dir } = await tempProject(t)
  await buildProject(dir)
  const lan = await startShare(dir, 5, '127.0.0.1')
  t.after(() => stopShare(dir))
  await assert.rejects(
    startShare(dir, 5, { scope: 'public', cloudflaredPath: join(root, 'missing-cloudflared') }),
    (err) => err.code === 'NO_TUNNEL',
  )
  assert.deepEqual(shareInfo(dir), lan)
  const page = await fetch(lan.url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<title>Moon Garden<\/title>/u)
})

test('failed startShare with NO_BUILD keeps an existing share running', async (t) => {
  const { dir } = await tempProject(t)
  await buildProject(dir)
  const lan = await startShare(dir, 5, '127.0.0.1')
  t.after(() => stopShare(dir))
  await rm(paths.artifact(dir), { force: true })
  await assert.rejects(
    startShare(dir, 5, '127.0.0.1'),
    (err) => err.code === 'NO_BUILD',
  )
  assert.deepEqual(shareInfo(dir), lan)
  assert.ok(shareAddress(dir) !== null)
})

test('sidebar shareCopy selects LAN or public copy by scope', () => {
  const bind = (dict) => (key, params = {}) => dict[key].replace(/\{(\w+)\}/gu, (_, k) => params[k] ?? '')
  const zhT = bind(localeZh)
  const enT = bind(localeEn)

  const lanZh = shareCopy({ expiresAt: '2026-11-07T12:30:00.000Z', scope: 'lan' }, zhT, '20:30')
  assert.equal(lanZh.isPublic, false)
  assert.match(lanZh.hint, /同一 Wi-Fi/u)
  assert.equal(lanZh.until, '20:30 自动关闭')

  const pubZh = shareCopy({ expiresAt: '2026-11-07T12:30:00.000Z', scope: 'public' }, zhT, '20:30')
  assert.equal(pubZh.isPublic, true)
  assert.equal(pubZh.hint, '任何网络都能打开，拿到链接的人都能玩。到 20:30 自动关闭。')
  assert.equal(pubZh.until, null)

  const pubEn = shareCopy({ expiresAt: '2026-11-07T12:30:00.000Z', scope: 'public' }, enT, '20:30')
  assert.equal(pubEn.isPublic, true)
  assert.match(pubEn.hint, /Anyone on any network.*20:30/u)
})

test('sidebar commandErrorCopy localizes NO_TUNNEL by language and platform and keeps other errors unchanged', () => {
  const bind = (dict) => (key, params = {}) => dict[key].replace(/\{(\w+)\}/gu, (_, k) => params[k] ?? '')
  const zhT = bind(localeZh)
  const enT = bind(localeEn)

  const macErr = JSON.stringify({ code: 'NO_TUNNEL', platform: 'darwin', install: 'brew install cloudflared' })
  assert.equal(commandErrorCopy(macErr, zhT), '公网链接需要先安装 cloudflared。macOS 上运行：brew install cloudflared')
  assert.equal(commandErrorCopy(macErr, enT), 'A public link requires cloudflared. On macOS, run: brew install cloudflared')

  const winErr = JSON.stringify({ code: 'NO_TUNNEL', platform: 'win32', install: 'winget install --id Cloudflare.cloudflared' })
  assert.equal(commandErrorCopy(winErr, zhT), '公网链接需要先安装 cloudflared。Windows 上运行：winget install --id Cloudflare.cloudflared')
  assert.equal(commandErrorCopy(winErr, enT), 'A public link requires cloudflared. On Windows, run: winget install --id Cloudflare.cloudflared')

  const linuxErr = JSON.stringify({
    code: 'NO_TUNNEL',
    platform: 'linux',
    install: 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/',
  })
  assert.match(commandErrorCopy(linuxErr, zhT), /公网链接需要先安装 cloudflared.*developers\.cloudflare\.com/u)
  assert.match(commandErrorCopy(linuxErr, enT), /A public link requires cloudflared.*developers\.cloudflare\.com/u)

  assert.equal(commandErrorCopy('Build the game before sharing it.', zhT), 'Build the game before sharing it.')
  assert.equal(commandErrorCopy('Build the game before sharing it.', enT), 'Build the game before sharing it.')
})

test('share heartbeat file is written immediately on startShare, refreshed on interval, and removed with timer cleared on stopShare', async (t) => {
  const { dir } = await tempProject(t)
  await buildProject(dir)
  const info = await startShare(dir, 5, { host: '127.0.0.1', heartbeatMs: 40 })
  t.after(() => stopShare(dir))

  const hbPath = shareHeartbeatPath(dir)
  const beat1 = JSON.parse(await readFile(hbPath, 'utf8'))
  assert.equal(beat1.url, info.url)
  assert.ok(Number.isFinite(Date.parse(beat1.at)))

  let beat2
  await waitForCondition(async () => {
    try {
      const current = JSON.parse(await readFile(hbPath, 'utf8'))
      if (Date.parse(current.at) > Date.parse(beat1.at)) {
        beat2 = current
        return true
      }
    } catch { /* retry */ }
    return false
  })
  assert.equal(beat2.url, info.url)
  assert.ok(Date.parse(beat2.at) > Date.parse(beat1.at), 'heartbeat timestamp advances on interval')

  assert.equal(stopShare(dir), true)
  await assert.rejects(readFile(hbPath, 'utf8'), { code: 'ENOENT' })

  // Wait more than two heartbeat periods to verify the interval timer was cleared and does not recreate the file.
  await new Promise(r => setTimeout(r, 100))
  await assert.rejects(readFile(hbPath, 'utf8'), { code: 'ENOENT' })
})

test('share heartbeat file is removed on TTL expiry and on unexpected tunnel exit', async (t) => {
  const { dir: lanDir } = await tempProject(t)
  await buildProject(lanDir)
  const lan = await startShare(lanDir, 5, { host: '127.0.0.1', ttlMs: 120, heartbeatMs: 40 })
  assert.equal(JSON.parse(await readFile(shareHeartbeatPath(lanDir), 'utf8')).url, lan.url)
  await waitForCondition(async () => {
    if (shareInfo(lanDir) !== null) return false
    try { await readFile(shareHeartbeatPath(lanDir), 'utf8'); return false } catch { return true }
  })
  assert.equal(shareInfo(lanDir), null)
  await assert.rejects(readFile(shareHeartbeatPath(lanDir), 'utf8'), { code: 'ENOENT' })

  const { dir: pubDir, command } = await fakeCloudflared(t, 'drop')
  const pub = await startShare(pubDir, 5, { scope: 'public', cloudflaredPath: command, tunnelTimeoutMs: 2_000, heartbeatMs: 40 })
  assert.equal(JSON.parse(await readFile(shareHeartbeatPath(pubDir), 'utf8')).url, pub.url)
  await waitForCondition(async () => {
    if (shareInfo(pubDir) !== null) return false
    try { await readFile(shareHeartbeatPath(pubDir), 'utf8'); return false } catch { return true }
  })
  assert.equal(shareInfo(pubDir), null)
  await assert.rejects(readFile(shareHeartbeatPath(pubDir), 'utf8'), { code: 'ENOENT' })
})

test('sidebar liveShare requires a matching, fresh heartbeat and an unexpired share', () => {
  const now = Date.parse('2026-11-08T12:00:00.000Z')
  const share = {
    url: 'http://192.168.1.5:8123/tok/',
    qrSvg: '<svg/>',
    expiresAt: '2026-11-08T12:30:00.000Z',
    scope: 'lan',
  }
  const freshBeat = { url: share.url, at: '2026-11-08T11:59:45.000Z' }

  // 1. Missing heartbeat
  assert.equal(liveShare(share, null, now), undefined)
  assert.equal(liveShare(share, undefined, now), undefined)
  // 2. Stale heartbeat (> 60s old)
  assert.equal(liveShare(share, { url: share.url, at: '2026-11-08T11:58:59.000Z' }, now), undefined)
  // 3. Mismatched URL
  assert.equal(liveShare(share, { url: 'http://192.168.1.5:8123/other/', at: freshBeat.at }, now), undefined)
  // 4. Expired state.share (or null state.share)
  assert.equal(liveShare({ ...share, expiresAt: '2026-11-08T11:59:59.000Z' }, freshBeat, now), undefined)
  assert.equal(liveShare(null, freshBeat, now), undefined)
  // 5. Healthy live share
  assert.equal(liveShare(share, freshBeat, now), share)
})

test('findGh and requireGh locate a configured binary or throw NO_GH with platform install hints', async (t) => {
  const { root, command } = await fakeCloudflared(t)
  assert.equal(findGh(command), command)
  const missing = join(root, 'no-such-gh')
  assert.equal(findGh(missing), undefined)
  assert.throws(() => requireGh(missing), (err) => err.code === 'NO_GH' && /brew install gh/u.test(err.message))
  assert.match(ghInstallHint('darwin'), /brew install gh/u)
  assert.match(ghInstallHint('win32'), /winget install --id GitHub\.cli/u)
  assert.match(ghInstallHint('linux'), /https:\/\/cli\.github\.com/u)
})

test('sidebar commandErrorCopy localizes NO_GH, GH_NOT_LOGGED_IN, GH_FAILED and REPO_NOT_OURS in zh and en without agent instructions', () => {
  const bind = (dict) => (key, params = {}) => dict[key].replace(/\{(\w+)\}/gu, (_, k) => params[k] ?? '')
  const zhT = bind(localeZh)
  const enT = bind(localeEn)

  const noGhMac = JSON.stringify({ code: 'NO_GH', platform: 'darwin', install: 'brew install gh' })
  assert.match(commandErrorCopy(noGhMac, zhT), /发布到 GitHub 需要先安装 GitHub CLI（gh）。macOS 上运行：brew install gh/u)
  assert.match(commandErrorCopy(noGhMac, enT), /Publishing to GitHub requires GitHub CLI \(gh\)\. On macOS, run: brew install gh/u)
  assert.doesNotMatch(commandErrorCopy(noGhMac, zhT) + commandErrorCopy(noGhMac, enT), /do not download|Tell the user/iu)

  const noGhWin = JSON.stringify({ code: 'NO_GH', platform: 'win32', install: 'winget install --id GitHub.cli' })
  assert.match(commandErrorCopy(noGhWin, zhT), /Windows 上运行：winget install --id GitHub\.cli/u)
  assert.match(commandErrorCopy(noGhWin, enT), /On Windows, run: winget install --id GitHub\.cli/u)

  const noGhLinux = JSON.stringify({ code: 'NO_GH', platform: 'linux', install: 'https://cli.github.com' })
  assert.match(commandErrorCopy(noGhLinux, zhT), /https:\/\/cli\.github\.com/u)
  assert.match(commandErrorCopy(noGhLinux, enT), /https:\/\/cli\.github\.com/u)

  const notLoggedIn = JSON.stringify({ code: 'GH_NOT_LOGGED_IN' })
  assert.equal(commandErrorCopy(notLoggedIn, zhT), 'GitHub CLI 还没有登录。请在终端运行 gh auth login 登录你的 GitHub 账号。')
  assert.equal(commandErrorCopy(notLoggedIn, enT), 'GitHub CLI is not signed in. Run gh auth login in your terminal to sign in to your GitHub account.')
  assert.doesNotMatch(commandErrorCopy(notLoggedIn, zhT) + commandErrorCopy(notLoggedIn, enT), /Tell the user|do not run/iu)

  const ghFailed = JSON.stringify({ code: 'GH_FAILED', message: 'Could not connect to GitHub via gh: read: connection reset by peer' })
  assert.equal(commandErrorCopy(ghFailed, zhT), '连接 GitHub 失败，检查网络或代理后重试')
  assert.equal(commandErrorCopy(ghFailed, enT), 'Could not connect to GitHub; check your network or proxy and try again')

  const repoNotOurs = JSON.stringify({ code: 'REPO_NOT_OURS', repo: 'octocat/dsh-games' })
  assert.match(commandErrorCopy(repoNotOurs, zhT), /仓库 octocat\/dsh-games 已存在且不是本插件创建的.*githubRepo/u)
  assert.match(commandErrorCopy(repoNotOurs, enT), /Repository octocat\/dsh-games already exists and was not created by this plugin.*githubRepo/u)
})

test('sidebar publishState pure function distinguishes unpublished, published, outdated buildId, and deploying status', () => {
  const bind = (dict) => (key, params = {}) => dict[key].replace(/\{(\w+)\}/gu, (_, k) => params[k] ?? '')
  const zhT = bind(localeZh)
  const enT = bind(localeEn)

  // 1. Unpublished
  const unpub = publishState(null, 'build-1', zhT)
  assert.equal(unpub.status, 'unpublished')
  assert.equal(unpub.hasUpdate, false)
  assert.equal(unpub.deploying, false)
  assert.equal(unpub.buttonLabel, '发布到 GitHub')
  assert.equal(unpub.hint, null)
  assert.equal(unpub.outdatedHint, null)
  assert.equal(publishState(undefined, 'build-1', enT).buttonLabel, 'Publish to GitHub')

  const record = {
    url: 'https://octocat.github.io/dsh-games/moon-garden/',
    repo: 'octocat/dsh-games',
    slug: 'moon-garden',
    publishedAt: '2026-11-08T06:00:00.000Z',
    buildId: 'build-1',
    status: 'built',
  }

  // 2. Published and up-to-date with current buildId
  const currentZh = publishState(record, 'build-1', zhT)
  assert.equal(currentZh.status, 'published')
  assert.equal(currentZh.hasUpdate, false)
  assert.equal(currentZh.deploying, false)
  assert.equal(currentZh.buttonLabel, '发布到 GitHub')
  assert.equal(currentZh.hint, '已发布到 GitHub Pages（octocat/dsh-games）')
  assert.equal(currentZh.outdatedHint, null)

  // 3. Local build is newer than published buildId
  const outdatedZh = publishState(record, 'build-2', zhT)
  assert.equal(outdatedZh.status, 'outdated')
  assert.equal(outdatedZh.hasUpdate, true)
  assert.equal(outdatedZh.buttonLabel, '更新发布')
  assert.equal(outdatedZh.outdatedHint, '有新的构建还没发布')

  const outdatedEn = publishState(record, 'build-2', enT)
  assert.equal(outdatedEn.status, 'outdated')
  assert.equal(outdatedEn.hasUpdate, true)
  assert.equal(outdatedEn.buttonLabel, 'Update published')
  assert.equal(outdatedEn.outdatedHint, 'A newer build has not been published yet')

  // 4. Pages still deploying (status === 'building')
  const deployingZh = publishState({ ...record, status: 'building' }, 'build-1', zhT)
  assert.equal(deployingZh.deploying, true)
  assert.equal(deployingZh.hint, 'GitHub 正在部署，一两分钟后可以打开')
  const deployingEn = publishState({ ...record, status: 'building' }, 'build-1', enT)
  assert.equal(deployingEn.deploying, true)
  assert.match(deployingEn.hint, /GitHub is deploying/u)
})
