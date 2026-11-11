// Monetization config: validation, what the exporter embeds, and what the
// runtime is allowed to do with it.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PNG } from 'pngjs'
import { commerceCheck, commerceFile, embedCommerce, loadCommerce, updateCommerce } from '../src/commerce.ts'
import { createProject, loadManifest, paths } from '../src/project.ts'
import { writeJson } from '../src/util.ts'
import { exportWechat } from '../src/wechat.ts'

function solidPng([width, height]) {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      png.data[index] = 80
      png.data[index + 1] = 130
      png.data[index + 2] = 200
      png.data[index + 3] = 255
    }
  }
  return new Uint8Array(PNG.sync.write(png))
}

async function tempGame(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-commerce-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'my-game')
  const manifest = await createProject(dir, { title: 'Moon Garden' })
  // PNG slots keep the export browser-free.
  for (const [slot, spec] of Object.entries(manifest.slots)) {
    const file = `assets/${slot}.png`
    await writeFile(join(dir, file), solidPng(spec.size))
    spec.file = file
  }
  await writeJson(paths.manifest(dir), manifest)
  return { root, dir }
}

test('monetization is off until configured, and invalid ad unit IDs are refused', async (t) => {
  const { dir } = await tempGame(t)
  const initial = await loadCommerce(dir)
  assert.equal(initial.enabled, false)
  assert.equal(embedCommerce(initial), null)

  await assert.rejects(
    updateCommerce(dir, { enabled: true, interstitial: 'not-an-ad-unit' }),
    /adunit-/u,
  )
  await assert.rejects(updateCommerce(dir, { enabled: true }), /没有填任何广告位 ID/u)
  assert.equal(await loadCommerce(dir).then(state => state.enabled), false, 'a refused update is not saved')

  const saved = await updateCommerce(dir, { enabled: true, interstitial: 'adunit-abc123def456', rewarded: 'adunit-rew987' })
  assert.equal(saved.enabled, true)
  assert.deepEqual(embedCommerce(saved), {
    enabled: true,
    analytics: true,
    interstitial: 'adunit-abc123def456',
    rewarded: 'adunit-rew987',
  })
  const check = commerceCheck(saved)
  assert.equal(check.ok, true)
  assert.match(check.notes.join(' '), /流量主/u)
  assert.match(JSON.parse(await readFile(commerceFile(dir), 'utf8')).ads.rewarded, /rew987/u)
})

test('the exporter embeds the ad unit IDs into the exported game', async (t) => {
  const { dir } = await tempGame(t)
  await updateCommerce(dir, { enabled: true, interstitial: 'adunit-abc123def456', rewarded: null })
  const result = await exportWechat(dir)
  assert.deepEqual(result.monetization, { enabled: true, analytics: true, interstitial: 'adunit-abc123def456' })
  const game = await readFile(join(result.dir, 'game.js'), 'utf8')
  assert.match(game, /"monetization":\{"enabled":true,"analytics":true,"interstitial":"adunit-abc123def456"\}/u)
})

test('a game without ads carries no monetization payload at all', async (t) => {
  const { dir } = await tempGame(t)
  const result = await exportWechat(dir)
  assert.equal(result.monetization, null)
  assert.doesNotMatch(await readFile(join(result.dir, 'game.js'), 'utf8'), /"monetization":\{/u)
})


test('in-app purchases stay off until a licence and a merchant ID are recorded', async (t) => {
  const { dir } = await tempGame(t)
  await assert.rejects(updateCommerce(dir, { iapEnabled: true }), /版号/u)
  await assert.rejects(
    updateCommerce(dir, { iapEnabled: true, licenseNumber: 'ISBN 978-7-498-12345-6' }),
    /商户号/u,
  )

  const withLicence = await updateCommerce(dir, {
    iapEnabled: true, licenseNumber: 'ISBN 978-7-498-12345-6', merchantId: '1900000109',
  })
  assert.deepEqual(embedCommerce(withLicence), {
    enabled: true,
    analytics: true,
    iap: { enabled: true, dryRun: true },
  })
  assert.match(commerceCheck(withLicence).notes.join(' '), /演示模式/u)

  await assert.rejects(updateCommerce(dir, { payUrl: 'http://insecure.example/pay' }), /https/u)
  const withServer = await updateCommerce(dir, { payUrl: 'https://pay.example.com/sign' })
  assert.deepEqual(embedCommerce(withServer).iap, { enabled: true, dryRun: false, payUrl: 'https://pay.example.com/sign' })
})
