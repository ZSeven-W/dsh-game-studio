// Pre-submission review: the rejection knowledge base and which risks a given
// project is actually heading for.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { releasePlan, updateRelease } from '../src/release.ts'
import { updateCommerce } from '../src/commerce.ts'
import { createProject } from '../src/project.ts'
import { REVIEW_REASONS, reviewGuide, reviewMarkdown, reviewRisks } from '../src/review.ts'

async function tempGame(t) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-review-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'my-game')
  await mkdir(dir, { recursive: true })
  return dir
}

async function fakeExport(gameDir, name = 'moon-garden') {
  const dir = join(gameDir, 'export', 'wechat', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'game.js'), '// exported game\n')
  await writeFile(join(dir, 'project.config.json'), '{"compileType":"game"}')
  return dir
}

test('every rejection reason points at a wizard step that exists', async (t) => {
  const dir = await tempGame(t)
  const guide = await reviewGuide(dir, {})
  const plan = releasePlan()
  const ids = new Set(plan.map((step) => step.id))
  assert.equal(REVIEW_REASONS.length, 12, 'the guide covers the twelve usual reasons')
  for (const reason of REVIEW_REASONS) {
    assert.ok(reason.step, `reason ${reason.id} has no wizard step`)
    assert.ok(ids.has(reason.step), `reason ${reason.id} points at unknown step ${reason.step}`)
    const title = plan.find((step) => step.id === reason.step).title
    assert.ok(guide.markdown.includes(`（向导步骤：${title}）`), `the guide does not show the step for ${reason.id}`)
  }
})

test('the rejection list is complete and each item says how to fix it', () => {
  const ids = REVIEW_REASONS.map(reason => reason.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  assert.ok(REVIEW_REASONS.length >= 10)
  for (const reason of REVIEW_REASONS) {
    assert.ok(reason.title && reason.why && reason.fix, `${reason.id} must be actionable`)
    assert.ok(['material', 'compliance', 'build', 'review', 'monetization'].includes(reason.stage))
  }
  const text = reviewMarkdown([], 'Demo')
  for (const label of ['名称与素材', '合规与资质', '构建与体验', '审核材料', '商业化']) assert.ok(text.includes(label), label)
  assert.match(text, /过审与备案由微信决定/u)
})

test('a fresh game is blocked by its AppID and by the missing filing', async (t) => {
  const dir = await tempGame(t)
  const risks = await reviewRisks(dir)
  const ids = risks.map(risk => risk.id)
  assert.ok(ids.includes('appid'), 'no AppID yet')
  assert.ok(ids.includes('record'), 'filing is not done')
  assert.ok(ids.includes('export'), 'nothing exported yet')
  assert.equal(risks.find(risk => risk.id === 'appid').severity, 'blocker')
  assert.equal(risks.find(risk => risk.id === 'export').severity, 'warning')
})

test('the ICP filing is a warning until it is confirmed', async (t) => {
  const dir = await tempGame(t)
  const fresh = await reviewRisks(dir)
  const icp = fresh.find(risk => risk.id === 'record-icp')
  assert.equal(icp?.severity, 'warning')
  await updateRelease(dir, { step: 'record-icp' })
  const after = await reviewRisks(dir)
  assert.ok(!after.some(risk => risk.id === 'record-icp'), 'confirming it clears the warning')
})

test('finishing the console steps and exporting removes those risks', async (t) => {
  const dir = await tempGame(t)
  await updateRelease(dir, { appid: 'wx1234567890abcdef', ageRating: '8+', category: '游戏 > 休闲游戏' })
  for (const step of ['register', 'verify', 'privacy', 'record']) await updateRelease(dir, { step })
  const exportDir = await fakeExport(dir)
  const risks = await reviewRisks(dir)
  const ids = risks.map(risk => risk.id)
  for (const gone of ['appid', 'record', 'privacy', 'age-rating', 'category', 'export']) {
    assert.ok(!ids.includes(gone), `${gone} should not be a risk anymore`)
  }
  const guide = await reviewGuide(dir)
  assert.equal(guide.file, join(exportDir, 'REVIEW.md'))
  const text = await readFile(guide.file, 'utf8')
  assert.match(text, /审核风险自查/u)
  assert.match(text, /常见驳回原因/u)
})

test('in-app purchases need the licence configured, not just the step ticked', async (t) => {
  const dir = await tempGame(t)
  await updateRelease(dir, { monetization: 'both', appid: 'wx1234567890abcdef' })

  // Nothing configured: a blocker that names the licence.
  const risks = await reviewRisks(dir)
  assert.equal(risks.find(risk => risk.id === 'iap')?.severity, 'blocker')
  assert.match(risks.find(risk => risk.id === 'iap').fix, /版号/u)

  // Ticking the step without the licence must not clear it: materials would still
  // say 版号未填写, so the review and the materials would disagree.
  await updateRelease(dir, { step: 'iap' })
  assert.equal((await reviewRisks(dir)).find(risk => risk.id === 'iap')?.severity, 'blocker',
    'a tick alone does not make the licence exist')

  // Once the licence and merchant ID are in the commerce panel, the step becomes the
  // only thing left, and the risk is a warning about the tick.
  await updateCommerce(dir, { iapEnabled: true, licenseNumber: 'ISBN 978-7-498-12345-6', merchantId: '1900000109' })
  await updateRelease(dir, { step: 'iap', status: 'todo' })
  const warning = (await reviewRisks(dir)).find(risk => risk.id === 'iap')
  assert.equal(warning?.severity, 'warning')
  assert.match(warning.title, /打勾/u)

  // And with both, the risk disappears.
  await updateRelease(dir, { step: 'iap' })
  assert.ok(!(await reviewRisks(dir)).some(risk => risk.id === 'iap'), 'configured + ticked clears it')
})

test('an export over the 4 MB main package is caught before upload', async (t) => {
  const dir = await tempGame(t)
  const exportDir = await fakeExport(dir)
  await writeFile(join(exportDir, 'big.bin'), Buffer.alloc(5 * 1024 * 1024, 1))
  const risks = await reviewRisks(dir)
  const size = risks.find(risk => risk.id === 'size')
  assert.equal(size?.severity, 'blocker')
  assert.match(size.title, /MB/u)
})

test('the review contains no placeholder leaks in any risk state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-review-leaks-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const cases = [
    { label: 'empty', template: 'collector', setup: async () => {} },
    {
      label: 'configured',
      template: 'collector',
      setup: async (dir) => {
        await updateRelease(dir, { appid: 'wx1234567890abcdef', ageRating: '12+', category: '游戏 > 休闲游戏', monetization: 'iaa' })
        for (const step of ['record', 'record-icp', 'privacy', 'iaa']) await updateRelease(dir, { step, status: 'done' })
        await updateCommerce(dir, { enabled: true, interstitial: 'adunit-1234567890', rewarded: 'adunit-1234567890', analytics: true })
      },
    },
    { label: 'iap-no-licence', template: 'voxel', setup: async (dir) => { await updateRelease(dir, { monetization: 'iap' }) } },
    {
      label: 'iap-configured',
      template: 'voxel',
      setup: async (dir) => {
        await updateRelease(dir, { monetization: 'iap', ageRating: '16+' })
        await updateCommerce(dir, { iapEnabled: true, licenseNumber: 'ISBN 978-7', merchantId: '1900000109' })
      },
    },
    {
      label: 'oversize',
      template: 'voxel',
      setup: async (dir) => {
        const exportDir = join(dir, 'export', 'wechat', 'big')
        await mkdir(exportDir, { recursive: true })
        for (const name of ['game.js', 'game.json', 'project.config.json']) await writeFile(join(exportDir, name), '{}')
        await writeFile(join(exportDir, 'big.bin'), Buffer.alloc(5 * 1024 * 1024, 1))
      },
    },
  ]

  for (const item of cases) {
    const dir = join(root, item.label)
    await createProject(dir, { title: `Review ${item.label}`, template: item.template })
    await item.setup(dir)
    const guide = await reviewGuide(dir, {})
    const text = await readFile(guide.file, 'utf8')
    assert.ok(text.length > 500, `${item.label}: the review should have content`)
    for (const token of ['undefined', 'null', 'NaN', 'Infinity', '[object Object]', '{title}', '{name}']) {
      assert.ok(!text.includes(token), `${item.label}: "${token}" leaked into the review`)
    }
  }
})
