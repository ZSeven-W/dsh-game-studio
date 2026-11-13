// The release materials tell the user what to put in the WeChat console. They
// must describe the same game the export actually produces: the ad units it
// embeds, the age rating it renders, the round length it runs, and the events it
// reports. This test compares the two artefacts instead of trusting either.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PNG } from 'pngjs'
import { createProject, loadManifest, paths } from '../src/project.ts'
import { updateCommerce } from '../src/commerce.ts'
import { releaseMaterials, updateRelease } from '../src/release.ts'
import { writeJson } from '../src/util.ts'
import { exportWechat } from '../src/wechat.ts'

/** An opaque size×size PNG; exporting then needs no browser for SVG art. */
function solidPng([width, height]) {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      png.data[i] = 60
      png.data[i + 1] = 120
      png.data[i + 2] = 180
      png.data[i + 3] = 255
    }
  }
  return new Uint8Array(PNG.sync.write(png))
}

async function pngProject(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-studio-consistency-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'my-game')
  await createProject(dir, { title: 'Moon Garden', style: 'watercolor storybook' })
  const manifest = await loadManifest(dir)
  for (const [slot, spec] of Object.entries(manifest.slots)) {
    const file = `assets/${slot}.png`
    await writeFile(join(dir, file), solidPng(spec.size))
    spec.file = file
  }
  await writeJson(paths.manifest(dir), manifest)
  return { dir, manifest }
}

test('the release materials agree with what the exported game actually embeds', async (t) => {
  const { dir, manifest } = await pngProject(t)
  await updateCommerce(dir, {
    enabled: true,
    interstitial: 'adunit-123456',
    rewarded: 'adunit-654321',
    analytics: true,
    iapEnabled: true,
    licenseNumber: 'ISBN 978-7-498-12345-6',
    merchantId: '1900000109',
    payUrl: 'https://pay.example.com/sign',
  })
  await updateRelease(dir, { ageRating: '12+', monetization: 'both', appid: 'wx1234567890abcdef' })
  manifest.rules = { ...manifest.rules, duration: 45 }
  await writeJson(paths.manifest(dir), manifest)

  const exported = await exportWechat(dir)
  const game = await readFile(join(exported.dir, 'game.js'), 'utf8')
  const materials = await releaseMaterials(dir, { exportDir: exported.dir, manifestTitle: manifest.title })
  const text = await readFile(materials.file, 'utf8')

  // Ad units: embedded in the game, named in the materials.
  for (const id of ['adunit-123456', 'adunit-654321']) {
    assert.ok(game.includes(id), `game.js must embed ${id}`)
    assert.ok(text.includes(`广告位：${id}`), `materials must name ${id}`)
  }
  // Age rating and round length come from the same state the game uses.
  assert.match(game, /"ageRating":"12\+"/u)
  assert.match(text, /适龄级别：12\+/u)
  assert.match(text, /单局约 45 秒/u)
  assert.equal(manifest.rules.duration, 45)
  // The client is told purchases are on; the materials explain the signing hop.
  assert.match(game, /"iap":\{"enabled":true/u)
  assert.match(text, /签名服务：已配置/u)

  // The English summary must repeat the same facts, or an English-speaking reviewer
  // gets a different game description than a Chinese one.
  assert.match(text, /## English summary/u)
  assert.ok(text.includes(`Game: ${manifest.title}`), 'English summary names the game')
  assert.ok(text.includes('Age rating: 12+'), 'English summary repeats the age rating')
  assert.match(text, /3D \(three\.js|2D canvas/u)
  assert.match(text, /one round ≈ 45 s/u)
  for (const id of ['adunit-123456', 'adunit-654321']) assert.ok(text.includes(id), `English summary names ${id}`)
  assert.match(text, /Monetization: both/u)

  // Every event the materials tell the user to register must really be reported.
  const runtime = await readFile(new URL('../src/wechat-runtime.js', import.meta.url), 'utf8')
  const listed = [...text.matchAll(/`game_([a-z_]+)`/gu)].map((match) => match[1])
  assert.ok(listed.length >= 8, `expected the event list, found ${listed.length}`)
  for (const event of new Set(listed)) {
    assert.ok(runtime.includes(`report('${event}'`), `the runtime never reports game_${event}`)
  }

  // And the other way round: every event the runtime emits must be documented,
  // otherwise the user never registers it and the dashboard silently drops it.
  const emitted = new Set([...runtime.matchAll(/report\('([a-z_]+)'/gu)].map((match) => match[1]))
  assert.ok(emitted.size >= 10, `expected the runtime to emit many events, found ${emitted.size}`)
  for (const event of emitted) {
    assert.ok(text.includes(`game_${event}`), `materials never mention game_${event}`)
  }
})

test('every ad error code the materials name is a real code with a fix', async (t) => {
  const { dir, manifest } = await pngProject(t)
  const exported = await exportWechat(dir)
  const materials = await releaseMaterials(dir, { exportDir: exported.dir, manifestTitle: manifest.title })
  const text = await readFile(materials.file, 'utf8')
  const runtime = await readFile(new URL('../src/wechat-runtime.js', import.meta.url), 'utf8')

  // The runtime's hint table: one entry per WeChat ad error code.
  const hints = new Map([...runtime.matchAll(/(\d{4}): '([^']+)'/gu)].map((match) => [Number(match[1]), match[2]]))
  assert.ok(hints.size >= 9, `expected the ad hint table, found ${hints.size} codes`)
  for (const [code, hint] of hints) assert.match(hint, /[\u4e00-\u9fff]/u, `code ${code} has no Chinese hint`)

  // The materials' "why did the ad fail" row lists the same codes: a code the
  // user is sent to read must exist, and a runtime code must be documented.
  const row = text.split('\n').find((line) => line.includes('广告为什么失败'))
  assert.ok(row, 'the materials must keep the ad-failure row')
  const named = new Set([...row.matchAll(/\b(1\d{3})\b/gu)].map((match) => Number(match[1])))
  assert.deepEqual([...named].sort(), [...hints.keys()].sort(), 'materials and runtime list different ad codes')
})

test('materials do not claim ads the game does not carry', async (t) => {
  const { dir } = await pngProject(t)
  // The wizard says "ads", but the commerce panel was never configured.
  await updateRelease(dir, { monetization: 'iaa' })
  const exported = await exportWechat(dir)
  const game = await readFile(join(exported.dir, 'game.js'), 'utf8')
  assert.doesNotMatch(game, /"monetization"/u)
  const materials = await releaseMaterials(dir, { exportDir: exported.dir, manifestTitle: 'Moon Garden' })
  const text = await readFile(materials.file, 'utf8')
  assert.match(text, /插屏广告位：未填写/u)
  assert.match(text, /注意：商业化面板里广告总开关还没打开/u)
})
