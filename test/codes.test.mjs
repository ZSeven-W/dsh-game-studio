// The WeChat tools raise coded errors, and docs/RELEASE.md promises every code
// names a fix. This test keeps the two in sync: a new code that is not documented
// fails, and a documented code that no longer exists fails too.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const files = ['wechat.ts', 'devtools.ts', 'ci.ts', 'commerce.ts', 'release.ts']
const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const doc = readFileSync(new URL('../docs/RELEASE.md', import.meta.url), 'utf8')

// Shared with the general build path, documented in the export README instead.
const SHARED = new Set(['BAD_MANIFEST', 'BAD_ASSET', 'MISSING_ASSET', 'MISSING_CODE', 'MISSING_RUNTIME'])

function codesIn(source) {
  return new Set([...source.matchAll(/'([A-Z][A-Z0-9]+_[A-Z0-9_]+)'/gu)].map((match) => match[1]))
}

const fromSource = new Set()
for (const file of files) {
  for (const code of codesIn(read(file))) if (!SHARED.has(code)) fromSource.add(code)
}
// The command layer raises BAD_ACTION for the WeChat actions as well.
fromSource.add('BAD_ACTION')

const fromDocs = new Set([...doc.matchAll(/^\| `([A-Z][A-Z0-9]+_[A-Z0-9_]+)`/gmu)].map((match) => match[1]))

test('every WeChat error code is documented, and the docs list no stale code', () => {
  assert.ok(fromSource.size >= 12, `expected the WeChat modules to raise codes, found ${fromSource.size}`)
  assert.ok(fromDocs.size >= 10, `expected the code table in docs/RELEASE.md, found ${fromDocs.size}`)

  const undocumented = [...fromSource].filter((code) => !fromDocs.has(code)).sort()
  assert.deepEqual(undocumented, [], `codes raised but missing from docs/RELEASE.md: ${undocumented.join(', ')}`)

  const stale = [...fromDocs].filter((code) => !fromSource.has(code)).sort()
  assert.deepEqual(stale, [], `codes documented but never raised: ${stale.join(', ')}`)
})

test('each documented code names what the user should do', () => {
  for (const line of doc.split('\n')) {
    const match = line.match(/^\| `([A-Z][A-Z0-9]+_[A-Z0-9_]+)` \| (.+?) \| (.+?) \|$/u)
    if (!match) continue
    const [, code, when, what] = match
    assert.ok(when.trim().length > 5, `${code}: describe when it appears`)
    assert.ok(what.trim().length > 5, `${code}: describe what the user does`)
  }
})
