// Package budget: what the export weighs and what to cut before uploading.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { analyzeWechatPackage } from '../src/size.ts'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-size-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function write(dir, name, bytes) {
  await mkdir(join(dir, name, '..'), { recursive: true })
  await writeFile(join(dir, name), Buffer.alloc(bytes, 1))
}

test('a small export is under the limit and says so', async (t) => {
  const dir = await tempDir(t)
  await write(dir, 'game.js', 200 * 1024)
  await write(dir, 'assets/hero.png', 120 * 1024)
  await write(dir, 'assets/enemy.png', 90 * 1024)
  const report = await analyzeWechatPackage(dir)
  assert.equal(report.warnings.length, 0, report.warnings.join('; '))
  assert.equal(report.totalBytes, 410 * 1024)
  assert.equal(report.assets.length, 2)
  assert.equal(report.largest[0].file, 'game.js')
  assert.match(report.suggestions.join(' '), /包体在限制内/u)
})

test('a single oversized texture is called out first', async (t) => {
  const dir = await tempDir(t)
  await write(dir, 'game.js', 300 * 1024)
  await write(dir, 'assets/background.png', 900 * 1024)
  const report = await analyzeWechatPackage(dir)
  assert.ok(report.warnings.some(line => /background\.png/u.test(line)), report.warnings.join('; '))
  assert.match(report.suggestions.join(' '), /压小/u)
})

test('an export over 4 MB is blocked with the subpackage route', async (t) => {
  const dir = await tempDir(t)
  await write(dir, 'game.js', 500 * 1024)
  for (let index = 0; index < 4; index++) await write(dir, `assets/tex${index}.png`, 1100 * 1024)
  const report = await analyzeWechatPackage(dir)
  assert.ok(report.warnings.some(line => /4 MB 主包限制/u.test(line)), report.warnings.join('; '))
  assert.match(report.suggestions.join(' '), /分包/u)
  assert.equal(report.largest.length, 5)
  assert.ok(report.largest[0].bytes >= report.largest[1].bytes, 'largest first')
})

test('a 3D-sized game.js is explained rather than flagged as waste', async (t) => {
  const dir = await tempDir(t)
  await write(dir, 'game.js', 1500 * 1024)
  await write(dir, 'assets/hero.png', 64 * 1024)
  const report = await analyzeWechatPackage(dir)
  assert.match(report.suggestions.join(' '), /three\.js/u)
})

test('many small assets still add up to a suggestion', async (t) => {
  const dir = await tempDir(t)
  await write(dir, 'game.js', 200 * 1024)
  for (let index = 0; index < 9; index++) await write(dir, `assets/tex${index}.png`, 40 * 1024)
  const report = await analyzeWechatPackage(dir)
  assert.match(report.suggestions.join(' '), /一共 9 个素材/u)
})
