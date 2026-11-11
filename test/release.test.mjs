// The WeChat release wizard: checklist integrity, state persistence, what is
// blocked, and the copy-paste materials handed to the console.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  loadRelease, markReleaseDone, releaseFile, releaseMaterials, releasePlan, releaseStatus, updateRelease,
} from '../src/release.ts'

async function tempGame(t) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'my-game')
  await mkdir(dir, { recursive: true })
  return dir
}

test('the plan is coherent and gates monetization steps', () => {
  const plan = releasePlan('none')
  const ids = plan.map(step => step.id)
  assert.equal(new Set(ids).size, ids.length, 'step ids are unique')
  for (const step of plan) {
    for (const need of step.needs ?? []) assert.ok(ids.includes(need), `${step.id} needs unknown ${need}`)
    assert.ok(step.how.length > 0, `${step.id} must say how`)
  }
  // Order: the account has to exist before the rest.
  assert.ok(ids.indexOf('register') < ids.indexOf('record'))
  assert.ok(ids.indexOf('record') < ids.indexOf('submit'))
  assert.ok(ids.indexOf('submit') < ids.indexOf('publish'))
  // IAP needs a game licence, so it only appears when the user asks for it.
  assert.ok(!ids.includes('iaa') && !ids.includes('iap'))
  assert.ok(releasePlan('iaa').some(step => step.id === 'iaa'))
  assert.ok(!releasePlan('iaa').some(step => step.id === 'iap'))
  assert.ok(releasePlan('both').some(step => step.id === 'iap'))
})

test('a fresh checklist starts at the console steps and blocks the build ones', async (t) => {
  const dir = await tempGame(t)
  const state = await loadRelease(dir)
  const status = releaseStatus(dir, state, releasePlan('none'))
  assert.equal(status.progress.done, 0)
  assert.deepEqual(status.next.map(step => step.id), ['register', 'age-rating', 'export'])
  assert.ok(status.blocked.some(step => step.id === 'upload' && step.missing.includes('appid')))
  assert.ok(status.blocked.some(step => step.id === 'submit' && step.missing.includes('record')))
})

test('marking steps moves progress and unblocks dependants, and is persisted', async (t) => {
  const dir = await tempGame(t)
  await updateRelease(dir, { step: 'register', status: 'done' })
  const saved = JSON.parse(await readFile(releaseFile(dir), 'utf8'))
  assert.equal(saved.steps.register.status, 'done')

  const { status } = await updateRelease(dir, { appid: 'wx1234567890abcdef', monetization: 'iaa' })
  assert.equal(status.appid, 'wx1234567890abcdef')
  assert.ok(status.steps.some(step => step.id === 'iaa'), 'choosing ads adds the traffic-owner step')
  assert.deepEqual(status.next.map(step => step.id), ['verify', 'appid', 'basic-info'])
  // upload needs the appid step and the DevTools step, not just the AppID value.
  assert.ok(status.blocked.some(step => step.id === 'upload'))
})

test('unknown steps and statuses are refused', async (t) => {
  const dir = await tempGame(t)
  await assert.rejects(updateRelease(dir, { step: 'launch-rocket' }), /Unknown release step/u)
  await assert.rejects(updateRelease(dir, { step: 'register', status: 'maybe' }), /Unknown release status/u)
})

test('the plugin may only mark work it really did', async (t) => {
  const dir = await tempGame(t)
  await markReleaseDone(dir, 'export', 'exported by the plugin')
  const status = releaseStatus(dir, await loadRelease(dir), releasePlan('none'))
  const exportStep = status.steps.find(step => step.id === 'export')
  assert.equal(exportStep.status, 'done')
  assert.equal(exportStep.note, 'exported by the plugin')
  assert.equal(status.steps.find(step => step.id === 'devtools').blocked, false, 'the export unblocks the IDE step')
})

test('materials are written next to the export with everything the console asks for', async (t) => {
  const dir = await tempGame(t)
  const exportDir = join(dir, 'export', 'wechat', 'lantern-isle')
  await mkdir(exportDir, { recursive: true })
  await updateRelease(dir, { monetization: 'both', ageRating: '12+', appid: 'wx1234567890abcdef' })
  const materials = await releaseMaterials(dir, { exportDir, manifestTitle: 'Lantern Isle', style: 'voxel island', orientation: 'portrait' })
  assert.equal(materials.file, join(exportDir, 'RELEASE.md'))
  const text = await readFile(materials.file, 'utf8')
  for (const section of ['## 1. 基本信息', '## 2. 适龄提示', '## 3. 用户隐私保护指引', '## 4. 小游戏备案', '## 5. 版本审核说明', '## 6. 变现', '## 7. 上线前检查']) {
    assert.ok(text.includes(section), `missing ${section}`)
  }
  assert.match(text, /12 周岁及以上/u)
  assert.match(text, /版号/u, 'IAP must mention the game licence')
  assert.match(text, /流量主/u, 'IAA must mention the traffic-owner switch')
  assert.match(text, /无需登录/u)
  assert.match(text, /以微信后台[^。]*为准/u)
})

