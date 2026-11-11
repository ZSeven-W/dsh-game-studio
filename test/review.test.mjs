// Pre-submission review: the rejection knowledge base and which risks a given
// project is actually heading for.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { updateRelease } from '../src/release.ts'
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

test('in-app purchases without a licence are a blocker, not a warning', async (t) => {
  const dir = await tempGame(t)
  await updateRelease(dir, { monetization: 'both', appid: 'wx1234567890abcdef' })
  const risks = await reviewRisks(dir)
  const iap = risks.find(risk => risk.id === 'iap')
  assert.equal(iap?.severity, 'blocker')
  assert.match(iap.fix, /版号/u)
  await updateRelease(dir, { step: 'iap' })
  const after = await reviewRisks(dir)
  assert.ok(!after.some(risk => risk.id === 'iap'), 'marking the licence step clears it')
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

