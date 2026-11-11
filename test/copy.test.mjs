// A non-coder reads the Chinese copy in errors, materials and the sidebar. Two
// cheap regressions make it look unfinished: half-width punctuation inside a
// Chinese sentence ("错误,请重试") and replacement characters from a bad edit.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = new URL('../src/', import.meta.url)
const files = [
  ...readdirSync(root).filter((name) => name.endsWith('.ts') || name.endsWith('.js')),
  join('client', 'index.tsx'),
  join('client', 'locales.ts'),
]

const HAN = /[\u3400-\u9fff]/u
// Half-width punctuation that touches a Han character on either side.
const MIXED = /[\u3400-\u9fff][,;:!?]|[,;:!?][\u3400-\u9fff]/u

function scan(file) {
  const text = readFileSync(new URL(file.replace(/\\/gu, '/'), root), 'utf8')
  const problems = []
  text.split('\n').forEach((line, index) => {
    if (!HAN.test(line)) return
    // Only judge lines that look like string content (quoted or template text).
    if (!/['"`]/u.test(line)) return
    if (MIXED.test(line)) problems.push(`${file}:${index + 1}: half-width punctuation in Chinese copy`)
    if (line.includes('\uFFFD')) problems.push(`${file}:${index + 1}: replacement character`)
  })
  return problems
}

test('Chinese copy uses full-width punctuation and no broken characters', () => {
  const problems = files.flatMap(scan)
  assert.deepEqual(problems, [], `copy problems:\n${problems.join('\n')}`)
})

test('the scan really looks at the Chinese copy', () => {
  const chineseLines = files
    .map((file) => readFileSync(new URL(file.replace(/\\/gu, '/'), root), 'utf8').split('\n').filter((line) => HAN.test(line)).length)
    .reduce((sum, count) => sum + count, 0)
  assert.ok(chineseLines > 200, `expected the sources to carry lots of Chinese copy, found ${chineseLines} lines`)
})
