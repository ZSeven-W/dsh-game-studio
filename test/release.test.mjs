// The WeChat release wizard: checklist integrity, state persistence, what is
// blocked, and the copy-paste materials handed to the console.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  loadRelease, markExported, markMaterialsWritten, markReleaseDone, markReviewWritten, markUploaded, releaseFile, releaseFilePresence, releaseFreshness, releaseMaterials, releasePlan, releaseStatus, updateRelease,
} from '../src/release.ts'
import { createProject } from '../src/project.ts'
import { reviewRisks } from '../src/review.ts'
import { updateCommerce } from '../src/commerce.ts'

async function tempGame(t) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'my-game')
  await mkdir(dir, { recursive: true })
  return dir
}

test('the materials number their sections and every section has content', async (t) => {
  const dir = await tempGame(t)
  const exportDir = join(dir, 'export', 'wechat', 'docs')
  await mkdir(exportDir, { recursive: true })
  const materials = await releaseMaterials(dir, { exportDir, manifestTitle: 'Doc Game' })
  const text = await readFile(materials.file, 'utf8')

  const headings = [...text.matchAll(/^## (\d+)\. (.+)$/gmu)].map((match) => ({ number: Number(match[1]), title: match[2].trim() }))
  assert.ok(headings.length >= 9, `expected the full set of sections, found ${headings.length}`)
  assert.deepEqual(headings.map((heading) => heading.number), headings.map((_, index) => index + 1), 'sections are numbered 1..N in order')
  assert.match(headings[0].title, /基本信息/u)
  assert.match(headings[headings.length - 1].title, /上线前检查/u)

  // Every section must say something: a heading followed by an empty line and a heading is a copy bug.
  const bodies = text.split(/^## \d+\. .+$/gmu).slice(1)
  for (const [index, body] of bodies.entries()) {
    assert.ok(body.replace(/\s/gu, '').length > 20, `section ${headings[index].title} is empty`)
  }

  // Internal references ("第 N 节") must point at a section that exists.
  const references = [...text.matchAll(/第 (\d+) 节/gu)].map((match) => Number(match[1]))
  for (const reference of references) {
    assert.ok(headings.some((heading) => heading.number === reference), `references missing section ${reference}`)
  }
})

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
  // 小游戏备案 and 小程序(ICP)备案 are separate console flows; review needs both.\n  assert.ok(ids.includes('record-icp'))\n  assert.ok(ids.indexOf('record') < ids.indexOf('record-icp'))\n  // IAP needs a game licence, so it only appears when the user asks for it.
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
  for (const section of ['## 1. 基本信息', '## 2. 适龄提示', '## 3. 用户隐私保护指引', '## 4. 小游戏备案', '## 5. 版本审核说明', '## 6. 变现', '## 9. 上线前检查']) {
    assert.ok(text.includes(section), `missing ${section}`)
  }
  assert.match(text, /12 周岁及以上/u)
  assert.match(text, /版号/u, 'IAP must mention the game licence')
  assert.match(text, /流量主/u, 'IAA must mention the traffic-owner switch')
  assert.match(text, /无需登录/u)
  assert.match(text, /小程序（ICP）备案/u)
  assert.match(text, /game_round_start/u)
  assert.match(text, /## 8. 上线后看什么/u)
  assert.match(text, /game_memory_warning/u)
  assert.match(text, /流量主 → 数据/u)
  assert.match(text, /自检结论：本游戏不处理用户个人信息/u)
  assert.match(text, /wx.requirePrivacyAuthorize/u)
  assert.match(text, /服务内容声明 → 用户隐私保护指引/u)
  assert.match(text, /指标 \/ 事件管理/u)
  assert.match(text, /__wechatRuntime.summary\(\)/u, 'the materials must show how to self-check the event plumbing')
  assert.match(text, /以微信后台[^。]*为准/u)
  // Section 5 must describe this game, not a generic template.
  assert.match(text, /游戏名称：Lantern Isle/u)
  assert.match(text, /单局约 \d+ 秒 → 结算页可直接重开/u)
  assert.match(text, /广告位置：/u)
  assert.match(text, /插屏广告位：未填写/u)
  assert.match(text, /版号：未填写/u)
  assert.match(text, /签名服务：未配置（内购跑演示模式/u)
  assert.match(text, /注意：商业化面板里广告总开关还没打开/u)

  // The section must follow the real commerce config once it is filled in.
  await updateCommerce(dir, { enabled: true, interstitial: 'adunit-123456', rewarded: 'adunit-654321', analytics: true })
  await updateCommerce(dir, { iapEnabled: true, licenseNumber: 'ISBN 978-7-498-12345-6', merchantId: '1900000109', payUrl: 'https://pay.example.com/sign' })
  const configured = await releaseMaterials(dir, { exportDir, manifestTitle: 'Lantern Isle' })
  const configuredText = await readFile(configured.file, 'utf8')
  assert.match(configuredText, /插屏广告位：adunit-123456/u)
  assert.match(configuredText, /版号：ISBN 978-7-498-12345-6/u)
  assert.match(configuredText, /商户号：1900000109/u)
  assert.match(configuredText, /签名服务：已配置/u)
  assert.match(text, /虚拟支付：仅道具直购/u)
  assert.match(text, /voxel island 风格/u)
  assert.match(text, /已知限制：无特殊权限要求/u)
  // A three.js project must switch the limitation text; runtime is an array.
  const threeRoot = await mkdtemp(join(tmpdir(), 'wechat-release-3d-'))
  t.after(() => rm(threeRoot, { recursive: true, force: true }))
  const threeDir = join(threeRoot, 'isle')
  await createProject(threeDir, { title: 'Lantern Isle', template: 'voxel' })
  await updateRelease(threeDir, { ageRating: '8+' })
  const threeExport = join(threeDir, 'export', 'wechat', 'isle')
  await mkdir(threeExport, { recursive: true })
  const threeMaterials = await releaseMaterials(threeDir, { exportDir: threeExport, manifestTitle: 'Lantern Isle' })
  const threeText = await readFile(threeMaterials.file, 'utf8')
  assert.match(threeText, /3D 画面需要支持 WebGL2/u)
})

test('writing the materials and the review is remembered in the status', async (t) => {
  const dir = await tempGame(t)
  const before = releaseStatus(dir, await loadRelease(dir), releasePlan('none'))
  assert.equal(before.materialsAt, null)
  assert.equal(before.reviewAt, null)

  await markMaterialsWritten(dir)
  const afterMaterials = releaseStatus(dir, await loadRelease(dir), releasePlan('none'))
  assert.ok(afterMaterials.materialsAt, 'the materials timestamp is kept')
  assert.equal(afterMaterials.reviewAt, null)

  await markReviewWritten(dir)
  const afterReview = releaseStatus(dir, await loadRelease(dir), releasePlan('none'))
  assert.ok(afterReview.reviewAt, 'the review timestamp is kept')
  // The markers survive a reload, so the sidebar can show them next time.
  const reloaded = releaseStatus(dir, await loadRelease(dir), releasePlan('none'))
  assert.equal(reloaded.materialsAt, afterReview.materialsAt)
  assert.equal(reloaded.reviewAt, afterReview.reviewAt)
})

test('a deleted materials file is not reported as present', async (t) => {
  const dir = await tempGame(t)
  const before = await releaseFilePresence(dir)
  assert.deepEqual(before, { materials: false, review: false }, 'nothing generated yet')

  const exportDir = join(dir, 'export', 'wechat', 'moon-garden')
  await mkdir(exportDir, { recursive: true })
  // findWechatExport only treats a folder as an export when the project files exist.
  for (const name of ['game.js', 'game.json', 'project.config.json']) await writeFile(join(exportDir, name), '{}\n')
  await writeFile(join(exportDir, 'RELEASE.md'), '# materials\n')
  await writeFile(join(exportDir, 'REVIEW.md'), '# review\n')
  assert.deepEqual(await releaseFilePresence(dir), { materials: true, review: true })

  // The user deleted one file by hand: do not claim it is still generated.
  await rm(join(exportDir, 'RELEASE.md'))
  assert.deepEqual(await releaseFilePresence(dir), { materials: false, review: true })
})

test('uploads keep the versions that were really sent', async (t) => {
  const dir = await tempGame(t)
  await markUploaded(dir, '1.0.0', 'uploaded 1.0.0 · 主包 1 KB · upload ok')
  await markUploaded(dir, '1.0.1', 'uploaded 1.0.1 · 主包 1 KB · upload ok')

  const state = await loadRelease(dir)
  const view = releaseStatus(dir, state, releasePlan('none'))
  assert.deepEqual(view.uploads.map((entry) => entry.version), ['1.0.0', '1.0.1'])
  assert.equal(view.steps.find((step) => step.id === 'upload').status, 'done', 'the upload step is done')
  assert.match(view.uploads[1].note, /upload ok/u)

  // A retry of the same version is still recorded: the user should see it and bump.
  await markUploaded(dir, '1.0.1', 'uploaded 1.0.1 again')
  const again = releaseStatus(dir, await loadRelease(dir), releasePlan('none'))
  assert.equal(again.uploads.filter((entry) => entry.version === '1.0.1').length, 2)
})

test('materials and the review go stale when the answers or the settings change', async (t) => {
  const dir = await tempGame(t)
  await mkdir(join(dir, '.studio'), { recursive: true })
  const commerce = join(dir, '.studio', 'wechat-commerce.json')
  await writeFile(commerce, '{}\n')
  // An old settings file must not make fresh materials look stale.
  await utimes(commerce, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))

  const fresh = await releaseFreshness(dir, {
    materialsAt: '2021-01-01T00:00:00.000Z',
    reviewAt: '2021-01-01T00:00:00.000Z',
    answersAt: '2020-06-01T00:00:00.000Z',
  })
  assert.deepEqual(fresh, { materialsStale: false, reviewStale: false, exportStale: false })

  // New answers after the files were written: both are out of date.
  const changed = await releaseFreshness(dir, {
    materialsAt: '2021-01-01T00:00:00.000Z',
    reviewAt: '2021-01-01T00:00:00.000Z',
    answersAt: '2022-01-01T00:00:00.000Z',
  })
  assert.deepEqual(changed, { materialsStale: true, reviewStale: true, exportStale: false })

  // Newer monetization settings make the materials stale even without answers.
  await utimes(commerce, new Date('2023-01-01T00:00:00Z'), new Date('2023-01-01T00:00:00Z'))
  const settings = await releaseFreshness(dir, {
    materialsAt: '2021-01-01T00:00:00.000Z',
    reviewAt: '2021-01-01T00:00:00.000Z',
    answersAt: '2020-06-01T00:00:00.000Z',
  })
  assert.deepEqual(settings, { materialsStale: true, reviewStale: false, exportStale: false })

  // Regenerating clears it: nothing happened after the new timestamps.
  const regenerated = await releaseFreshness(dir, {
    materialsAt: '2024-01-01T00:00:00.000Z',
    reviewAt: '2024-01-01T00:00:00.000Z',
    answersAt: '2020-06-01T00:00:00.000Z',
  })
  assert.deepEqual(regenerated, { materialsStale: false, reviewStale: false, exportStale: false })

  // updateRelease records answersAt when an answer changes, and not for steps.
  const before = await loadRelease(dir)
  await updateRelease(dir, { ageRating: '12+' })
  const after = await loadRelease(dir)
  assert.ok(after.answersAt, 'changing the age rating records answersAt')
  const stepped = await updateRelease(dir, { step: 'appid', status: 'done' })
  assert.equal(stepped.state.answersAt, after.answersAt, 'a step change is not an answer change')
  assert.ok(before.answersAt === undefined || before.answersAt <= after.answersAt)
})

test('the materials follow the monetization settings, before and after regenerating', async (t) => {
  const dir = await tempGame(t)
  const exportDir = join(dir, 'export', 'wechat', 'monetized')
  await mkdir(exportDir, { recursive: true })

  // Start with ads only: the materials name the unit and say IAP is not chosen.
  await updateRelease(dir, { monetization: 'iaa' })
  await updateCommerce(dir, { enabled: true, interstitial: 'adunit-111111', rewarded: 'adunit-222222' })
  const first = await releaseMaterials(dir, { exportDir, manifestTitle: 'Ads Game' })
  const firstText = await readFile(first.file, 'utf8')
  assert.match(firstText, /当前选择：iaa/u)
  assert.match(firstText, /adunit-111111/u)
  assert.match(firstText, /adunit-222222/u)
  assert.match(firstText, /未选择内购变现/u)
  assert.doesNotMatch(firstText, /版号：ISBN/u)

  // Now add IAP: regenerating must describe the new state, not the old one.
  await updateRelease(dir, { monetization: 'both' })
  await updateCommerce(dir, { iapEnabled: true, licenseNumber: 'ISBN 978-7-498-12345-6', merchantId: '1900000109' })
  const second = await releaseMaterials(dir, { exportDir, manifestTitle: 'Ads Game' })
  const secondText = await readFile(second.file, 'utf8')
  assert.match(secondText, /当前选择：both/u)
  assert.match(secondText, /版号：ISBN 978-7-498-12345-6/u)
  assert.match(secondText, /商户号：1900000109/u)
  assert.match(secondText, /签名服务：未配置/u)
  assert.doesNotMatch(secondText, /未选择内购变现/u)

  // The filing blurb and the privacy draft must match the payment setup.
  assert.match(firstText, /不含社交与充值/u)
  assert.doesNotMatch(firstText, /含道具直购/u)
  assert.match(secondText, /含道具直购（虚拟支付）/u)
  assert.doesNotMatch(secondText, /不含社交与充值/u)
  assert.match(secondText, /已接入内购/u)
  assert.match(secondText, /内购为道具直购，不涉及兑换/u)

  // And the status knows the file is fresh again after the regeneration.
  const state = await loadRelease(dir)
  const freshness = await releaseFreshness(dir, state)
  assert.equal(freshness.materialsStale, false)
})

test('the age-rating card never claims a rating the user has not chosen', async (t) => {
  const dir = await tempGame(t)
  const exportDir = join(dir, 'export', 'wechat', 'rating')
  await mkdir(exportDir, { recursive: true })

  const draft = await releaseMaterials(dir, { exportDir, manifestTitle: 'Rating Game' })
  const draftText = await readFile(draft.file, 'utf8')
  assert.match(draftText, /适龄级别：尚未选择/u, 'the draft says the user has not chosen yet')
  assert.match(draftText, /草案：本游戏适合 8 周岁/u, 'the 8+ draft copy is labelled as a draft')
  assert.doesNotMatch(draftText, /适龄级别：8\+/u, 'no unqualified 8+ claim')

  // And the review agrees: the missing rating is a risk.
  const risks = await reviewRisks(dir, await loadRelease(dir), { exportDir })
  assert.ok(risks.some((risk) => risk.id === 'age-rating'), 'the review flags the missing rating')

  await updateRelease(dir, { ageRating: '12+' })
  const chosen = await releaseMaterials(dir, { exportDir, manifestTitle: 'Rating Game' })
  const chosenText = await readFile(chosen.file, 'utf8')
  assert.match(chosenText, /适龄级别：12\+/u)
  assert.match(chosenText, /本游戏适合 12 周岁/u)
})

test('the privacy draft says whether the console step is actually done', async (t) => {
  const dir = await tempGame(t)
  const exportDir = join(dir, 'export', 'wechat', 'privacy')
  await mkdir(exportDir, { recursive: true })

  const before = await releaseMaterials(dir, { exportDir, manifestTitle: 'Privacy Game' })
  const beforeText = await readFile(before.file, 'utf8')
  assert.match(beforeText, /状态：\*\*尚未完成\*\*/u, 'the draft admits the step is open')
  assert.match(beforeText, /用户隐私保护指引/u)
  // And the review agrees.
  const risks = await reviewRisks(dir, await loadRelease(dir), { exportDir })
  assert.ok(risks.some((risk) => risk.id === 'privacy'), 'the review flags the open privacy step')

  await updateRelease(dir, { step: 'privacy' })
  const after = await releaseMaterials(dir, { exportDir, manifestTitle: 'Privacy Game' })
  const afterText = await readFile(after.file, 'utf8')
  assert.match(afterText, /状态：已在后台完成「不收集」声明/u)
  assert.doesNotMatch(afterText, /状态：\*\*尚未完成\*\*/u, 'the privacy status is no longer the open one')
})

test('the filing section states whether each filing is done', async (t) => {
  const dir = await tempGame(t)
  const exportDir = join(dir, 'export', 'wechat', 'filing')
  await mkdir(exportDir, { recursive: true })

  const before = await releaseMaterials(dir, { exportDir, manifestTitle: 'Filing Game' })
  const beforeText = await readFile(before.file, 'utf8')
  assert.match(beforeText, /小游戏备案：\*\*尚未完成\*\*/u)
  assert.match(beforeText, /小程序备案（ICP）：\*\*尚未确认\*\*/u)
  // Both are real risks in the review at this point.
  const risks = await reviewRisks(dir, await loadRelease(dir), { exportDir })
  assert.ok(risks.some((risk) => risk.id === 'record'), 'record is a risk')
  assert.ok(risks.some((risk) => risk.id === 'record-icp'), 'record-icp is a risk')

  await updateRelease(dir, { step: 'record' })
  await updateRelease(dir, { step: 'record-icp' })
  const after = await releaseMaterials(dir, { exportDir, manifestTitle: 'Filing Game' })
  const afterText = await readFile(after.file, 'utf8')
  assert.match(afterText, /小游戏备案：已完成/u)
  assert.match(afterText, /小程序备案（ICP）：已完成或已确认不适用/u)
  assert.doesNotMatch(afterText, /小游戏备案：\*\*尚未完成\*\*/u)
  assert.doesNotMatch(afterText, /小程序备案（ICP）：\*\*尚未确认\*\*/u)
})

test('the review note never prints null when the rating is not chosen', async (t) => {
  const dir = await tempGame(t)
  const exportDir = join(dir, 'export', 'wechat', 'reviewnote')
  await mkdir(exportDir, { recursive: true })

  const before = await releaseMaterials(dir, { exportDir, manifestTitle: 'Note Game' })
  const beforeText = await readFile(before.file, 'utf8')
  assert.doesNotMatch(beforeText, /null/u, 'no raw null leaks into the document')
  assert.match(beforeText, /适龄提示 待选定/u)
  assert.match(beforeText, /Age rating: not chosen yet \(the export embeds a draft 8\+\)/u)

  await updateRelease(dir, { ageRating: '16+' })
  const after = await releaseMaterials(dir, { exportDir, manifestTitle: 'Note Game' })
  const afterText = await readFile(after.file, 'utf8')
  assert.match(afterText, /适龄提示 16\+/u)
  assert.match(afterText, /Age rating: 16\+/u)
})

test('the materials contain no placeholder leaks in any realistic state', async (t) => {
  const unit = 'adunit-1234567890'
  const cases = [
    { label: 'collector-no-answers', template: 'collector', release: null, commerce: null },
    { label: 'voxel-no-answers', template: 'voxel', release: null, commerce: null },
    { label: 'ads', template: 'collector', release: { monetization: 'iaa' }, commerce: { enabled: true, interstitial: unit, rewarded: unit, analytics: true } },
    { label: 'iap-demo', template: 'voxel', release: { monetization: 'iap', ageRating: '12+', category: '游戏 > 休闲游戏', appid: 'wx1234567890abcdef' }, commerce: { iapEnabled: true, licenseNumber: 'ISBN 978-7-498-12345-6', merchantId: '1900000109' } },
    { label: 'both-paid', template: 'collector', release: { monetization: 'both', ageRating: '16+' }, commerce: { enabled: true, interstitial: unit, iapEnabled: true, licenseNumber: 'ISBN 978-7', merchantId: '1900000109', payUrl: 'https://pay.example.com/sign' } },
  ]

  for (const item of cases) {
    const dir = join(await tempGame(t), item.label)
    await createProject(dir, { title: `Probe ${item.label}`, template: item.template })
    const exportDir = join(dir, 'export', 'wechat', 'g')
    await mkdir(exportDir, { recursive: true })
    if (item.release) await updateRelease(dir, item.release)
    if (item.commerce) await updateCommerce(dir, item.commerce)
    const materials = await releaseMaterials(dir, { exportDir, manifestTitle: `Probe ${item.label}` })
    const text = await readFile(materials.file, 'utf8')
    assert.ok(text.length > 1000, `${item.label}: the materials should have content`)
    for (const token of ['undefined', 'null', 'NaN', 'Infinity', '[object Object]']) {
      assert.ok(!text.includes(token), `${item.label}: "${token}" leaked into the materials`)
    }
  }
})

test('the step count follows the monetization choice, and old answers survive a switch', async (t) => {
  assert.equal(releasePlan('none').length, 15)
  assert.equal(releasePlan('iaa').length, 16)
  assert.equal(releasePlan('iap').length, 16)
  assert.equal(releasePlan('both').length, 17)
  assert.ok(releasePlan('iaa').some((step) => step.id === 'iaa'))
  assert.ok(!releasePlan('iap').some((step) => step.id === 'iaa'), 'no ad step when only IAP is chosen')

  const dir = await tempGame(t)
  // Do the ad step, then switch to IAP: the plan drops the ad step and the progress
  // counts only the current plan; switching back keeps the earlier tick.
  await updateRelease(dir, { monetization: 'iaa' })
  await updateRelease(dir, { step: 'iaa' })
  const ads = JSON.parse(JSON.stringify(releaseStatus(dir, await loadRelease(dir), releasePlan('iaa'))))
  assert.equal(ads.progress.total, 16)
  assert.equal(ads.steps.find((step) => step.id === 'iaa').status, 'done')

  await updateRelease(dir, { monetization: 'iap' })
  const switched = releaseStatus(dir, await loadRelease(dir), releasePlan('iap'))
  assert.equal(switched.progress.total, 16)
  assert.ok(!switched.steps.some((step) => step.id === 'iaa'), 'the ad step is not shown under IAP')
  assert.ok(switched.steps.some((step) => step.id === 'iap'))

  await updateRelease(dir, { monetization: 'iaa' })
  const back = releaseStatus(dir, await loadRelease(dir), releasePlan('iaa'))
  assert.equal(back.steps.find((step) => step.id === 'iaa').status, 'done', 'the earlier tick is still there')
})

test('editing the game after exporting makes the export stale', async (t) => {
  const dir = await tempGame(t)
  await writeFile(join(dir, 'game.js'), '// v1\n')
  await writeFile(join(dir, 'game.json'), '{}\n')
  await utimes(join(dir, 'game.js'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
  await utimes(join(dir, 'game.json'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
  await mkdir(join(dir, '.studio'), { recursive: true })
  const commerce = join(dir, '.studio', 'wechat-commerce.json')
  await writeFile(commerce, '{}\n')
  await utimes(commerce, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))

  const fresh = await releaseFreshness(dir, { exportAt: '2021-01-01T00:00:00.000Z', answersAt: '2020-06-01T00:00:00.000Z' })
  assert.equal(fresh.exportStale, false)

  // A later edit to game.js is enough: the exporter copies that file verbatim.
  await utimes(join(dir, 'game.js'), new Date('2022-01-01T00:00:00Z'), new Date('2022-01-01T00:00:00Z'))
  const edited = await releaseFreshness(dir, { exportAt: '2021-01-01T00:00:00.000Z', answersAt: '2020-06-01T00:00:00.000Z' })
  assert.equal(edited.exportStale, true, 'game.js changed after the export')

  // Re-exporting after the edit clears it.
  const after = await releaseFreshness(dir, { exportAt: '2023-01-01T00:00:00.000Z', answersAt: '2020-06-01T00:00:00.000Z' })
  assert.equal(after.exportStale, false)
})

test('the export goes stale when the answers or settings change after it', async (t) => {
  const dir = await tempGame(t)
  await mkdir(join(dir, '.studio'), { recursive: true })
  const commerce = join(dir, '.studio', 'wechat-commerce.json')
  await writeFile(commerce, '{}\n')
  await utimes(commerce, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))

  const fresh = await releaseFreshness(dir, { exportAt: '2021-01-01T00:00:00.000Z', answersAt: '2020-06-01T00:00:00.000Z' })
  assert.equal(fresh.exportStale, false)

  const changed = await releaseFreshness(dir, { exportAt: '2021-01-01T00:00:00.000Z', answersAt: '2022-01-01T00:00:00.000Z' })
  assert.equal(changed.exportStale, true, 'new answers make the export stale')

  await utimes(commerce, new Date('2023-01-01T00:00:00Z'), new Date('2023-01-01T00:00:00Z'))
  const settings = await releaseFreshness(dir, { exportAt: '2021-01-01T00:00:00.000Z', answersAt: '2020-06-01T00:00:00.000Z' })
  assert.equal(settings.exportStale, true, 'new monetization settings make the export stale')

  await markExported(dir)
  const state = await loadRelease(dir)
  assert.ok(state.exportAt, 'markExported records the timestamp')
  const after = await releaseFreshness(dir, state)
  assert.equal(after.exportStale, false, 're-exporting clears it')
})
