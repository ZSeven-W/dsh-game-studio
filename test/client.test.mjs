// The sidebar is the only surface a non-coder touches, and it is the easiest
// thing to break silently: dropping a translation shows a raw key like
// `tab.commerce`, and removing a panel leaves no trace in the host tools.
//
// These checks read the client sources directly; no DOM is needed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { en, zh } from '../src/client/locales.ts'

const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

/** Literal keys the sidebar asks for, e.g. t('tab.exportWechat', …). */
const used = new Set()
for (const match of source.matchAll(/\bt\('([^']+)'/gu)) used.add(match[1])

test('every literal key the sidebar asks for exists in both languages', () => {
  assert.ok(used.size > 40, `expected the sidebar to use many keys, found ${used.size}`)
  const missingZh = [...used].filter((key) => !(key in zh))
  const missingEn = [...used].filter((key) => !(key in en))
  assert.deepEqual(missingZh, [], `missing zh copy: ${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `missing en copy: ${missingEn.join(', ')}`)
})

test('the two dictionaries carry exactly the same keys, and neither is a copy', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  const untranslated = Object.keys(zh).filter((key) => zh[key] === en[key])
  assert.deepEqual(untranslated, [], `these keys were never translated: ${untranslated.join(', ')}`)
})

test('the sidebar only calls command actions and ops that the host defines', () => {
  const hostSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const block = hostSource.slice(hostSource.indexOf('const COMMAND_ACTIONS'))
  const tableStart = block.indexOf('= [')
  const tableEnd = block.indexOf('\n]', tableStart)
  assert.ok(tableStart > 0 && tableEnd > tableStart, 'the host action table must be a literal list')
  const declared = new Set([...block.slice(tableStart, tableEnd).matchAll(/\['([a-z-]+)'/gu)].map(match => match[1]))
  assert.ok(declared.size > 10, 'the host action table must have been found')

  const called = new Set([...source.matchAll(/runCommand\(sessionId, `([a-z][a-z-]+)/gu)].map(match => match[1]))
  assert.ok(called.size > 3)
  for (const action of called) {
    assert.ok(declared.has(action), `the sidebar calls unknown action "${action}"`)
  }

  const ops = new Set([...source.matchAll(/\bop: '([a-z]+)'/gu)].map(match => match[1]))
  const allowedOps = new Set(['status', 'update', 'materials', 'review', 'configure', 'open', 'preview', 'upload', 'doctor'])
  for (const op of ops) assert.ok(allowedOps.has(op), `the sidebar sends unknown op "${op}"`)
})

test('the README describes the controls the panel actually has', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  for (const label of ['检查环境', '预览二维码', '上传版本', '下一步', '上线向导']) {
    assert.ok(readme.includes(label), `README no longer mentions "${label}"`)
    assert.ok(source.includes(label), `the sidebar has no "${label}" string`)
  }
})

test('the WeChat export button, the launch wizard and the monetization panel are wired in', () => {
  // A key that exists but is never referenced means the panel was removed while
  // the copy stayed behind; referencing it without copy shows the raw key.
  for (const key of [
    'tab.exportWechat',
    'tab.release',
    'tab.releaseProgress',
    'tab.releaseMaterials',
    'tab.releaseReview',
    'tab.commerce',
    'tab.commerceSave',
    'tab.commerceDataHint',
  ]) {
    assert.ok(key in zh, `${key} is missing from the zh dictionary`)
    assert.ok(used.has(key), `${key} exists but the sidebar never renders it`)
  }
})

test('placeholder keys are called with an object, not as a bare string', () => {
  const withPlaceholders = [...used].filter((key) => /\{[a-zA-Z]+\}/u.test(zh[key] ?? ''))
  assert.ok(withPlaceholders.length > 0)
  for (const key of withPlaceholders) {
    const calls = source.match(new RegExp(`t\\('${key.replace('.', '\\.')}'(\\s*,)?`, 'gu')) ?? []
    assert.ok(calls.length > 0, `${key} is never called`)
    for (const call of calls) {
      assert.match(call, /,\s*$/u, `${key} expects placeholders and must be called with an object`)
    }
  }
})
