// The last-mile check exists to stop an upload with touristappid or missing materials.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyLaunch } from '../scripts/launch-verify.mjs'

const makeProject = (appid) => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-verify-'))
  writeFileSync(join(dir, 'game.json'), JSON.stringify({ subpackages: [{ name: 'assets', root: 'assets/' }] }))
  writeFileSync(join(dir, 'project.config.json'), JSON.stringify({ appid, compileType: 'game' }))
  return dir
}

test('launch verification refuses a touristappid export', async (t) => {
  const dir = makeProject('touristappid')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = await verifyLaunch({ project: dir, skipDevtools: true, quiet: true })
  assert.equal(result.ok, false)
  const tourist = result.checks.find((entry) => entry.name.includes('touristappid'))
  assert.equal(tourist.ok, false)
  assert.match(tourist.next, /重新导出/u)
  const materials = result.checks.filter((entry) => entry.name.includes('已生成'))
  assert.ok(materials.every((entry) => entry.ok === false), 'missing materials are reported')
})

test('launch verification accepts a real appid with both documents', async (t) => {
  const dir = makeProject(`wx${'a'.repeat(16)}`)
  writeFileSync(join(dir, 'RELEASE.md'), '# release\n')
  writeFileSync(join(dir, 'REVIEW.md'), '# review\n')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = await verifyLaunch({ project: dir, skipDevtools: true, quiet: true })
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((entry) => !entry.ok)))
  assert.ok(result.checks.every((entry) => entry.ok))
})

test('a missing directory is reported, not thrown', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-verify-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = await verifyLaunch({ project: join(dir, 'nope'), skipDevtools: true, quiet: true })
  assert.equal(result.ok, false)
  assert.equal(result.checks[0].ok, false)
})
