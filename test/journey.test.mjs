// Walks the launch wizard the way a user would, step by step, and checks that
// the checklist never points at a step that is still blocked, that progress
// moves in order, and that 提交审核 really waits for both filings and the upload.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  loadRelease, markReleaseDone, releaseMaterials, releasePlan, releaseStatus, updateRelease,
} from '../src/release.ts'

async function tempGame(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-studio-journey-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'my-game')
  await mkdir(dir, { recursive: true })
  return dir
}

async function statusOf(dir) {
  const state = await loadRelease(dir)
  return releaseStatus(dir, state, releasePlan(state.monetization ?? 'none'))
}

test('a user can walk the whole wizard without meeting a dead end', async (t) => {
  const dir = await tempGame(t)
  const plan = releasePlan('none')
  const ids = plan.map(step => step.id)

  let status = await statusOf(dir)
  assert.equal(status.next[0].id, 'register', 'the first thing to do is register the account')
  assert.equal(status.progress.done, 0)
  assert.ok(status.blocked.some(step => step.id === 'submit'), 'submitting starts blocked')

  let previousDone = 0
  for (const step of plan) {
    // What the user (or the plugin) actually does for this step.
    if (step.id === 'appid') await updateRelease(dir, { appid: 'wx1234567890abcdef', step: step.id })
    else if (step.id === 'age-rating') await updateRelease(dir, { ageRating: '8+', step: step.id })
    else if (step.owner === 'plugin') await markReleaseDone(dir, step.id, 'simulated by the journey test')
    else await updateRelease(dir, { step: step.id, note: 'done in the console' })

    status = await statusOf(dir)
    assert.equal(status.progress.done, previousDone + 1, `${step.id} must count exactly once`)
    previousDone += 1
    // Whatever the wizard offers next must be actionable right now.
    for (const next of status.next) {
      const entry = status.steps.find(candidate => candidate.id === next.id)
      assert.equal(entry.blocked, false, `next suggests blocked step ${next.id}`)
    }
    // Blocked steps may only wait on real steps.
    for (const blocked of status.blocked) {
      for (const missing of blocked.missing) assert.ok(ids.includes(missing), `${blocked.id} waits on unknown ${missing}`)
    }
  }

  status = await statusOf(dir)
  assert.equal(status.progress.percent, 100)
  assert.deepEqual(status.next, [])
  assert.deepEqual(status.blocked, [])
  assert.equal(status.appid, 'wx1234567890abcdef')
  assert.equal(status.ageRating, '8+')
})

test('提交审核 waits for both filings and the upload, not only one', async (t) => {
  const dir = await tempGame(t)
  for (const step of ['register', 'verify', 'basic-info', 'category']) {
    await updateRelease(dir, { step })
  }
  await updateRelease(dir, { step: 'appid', appid: 'wx1234567890abcdef' })
  await markReleaseDone(dir, 'export', 'exported')
  await markReleaseDone(dir, 'upload', 'uploaded')
  await updateRelease(dir, { step: 'record' })

  let status = await statusOf(dir)
  let submit = status.steps.find(step => step.id === 'submit')
  assert.equal(submit.blocked, true, 'one filing is not enough')
  assert.deepEqual(status.blocked.find(step => step.id === 'submit')?.missing, ['record-icp'])

  await updateRelease(dir, { step: 'record-icp' })
  status = await statusOf(dir)
  submit = status.steps.find(step => step.id === 'submit')
  assert.equal(submit.blocked, false)

  // The materials can be generated at any point and stay copy-pasteable.
  const exportDir = join(dir, 'export', 'wechat', 'journey')
  await mkdir(exportDir, { recursive: true })
  const materials = await releaseMaterials(dir, { exportDir, manifestTitle: 'Journey' })
  const text = await readFile(materials.file, 'utf8')
  assert.match(text, /## 9. 上线前检查/u)
  assert.match(text, /小程序（ICP）备案/u)
})
