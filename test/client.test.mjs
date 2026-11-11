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
