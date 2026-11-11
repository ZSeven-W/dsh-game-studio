// The target's boundaries are promises the product must NOT make: no guarantee of
// review, filing, revenue or device frame rate. This scans the user-facing copy
// for over-claiming and requires the honest statements to stay in place.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const files = [
  'src/release.ts',
  'src/review.ts',
  'src/commerce.ts',
  'src/wechat.ts',
  'src/client/locales.ts',
  'README.md',
  'docs/RELEASE.md',
  'docs/CHANGELOG.md',
  'docs/RELEASING.md',
  ...readdirSync(new URL('.', root)).filter((name) => /^README\.[a-z]{2}\.md$/u.test(name)).map((name) => name),
]

// Phrases a product that cannot control review, revenue or devices must never print.
const OVERCLAIMS = [
  '包过', '必过', '保证过审', '保证通过审核', '确保过审', '一定能过', '100% 通过',
  '保证收益', '稳定收益', '躺赚', '稳赚', '保证上线', '官方合作', '微信官方',
]

test('no user-facing copy promises approval, revenue or a partnership', () => {
  assert.ok(files.length >= 15, `expected the copy scan to cover many files, found ${files.length}`)
  const hits = []
  for (const file of files) {
    const text = read(file)
    for (const phrase of OVERCLAIMS) {
      if (text.includes(phrase)) hits.push(`${file}: "${phrase}"`)
    }
  }
  assert.deepEqual(hits, [], `over-claiming copy:\n${hits.join('\n')}`)
})

test('the materials keep saying who decides review and filings', () => {
  const release = read('src/release.ts')
  assert.match(release, /过审与备案由微信和主管部门决定/u)
  assert.match(release, /不承诺过审、备案或收入/u)
})

test('the licence and filing gates stay visible where they matter', () => {
  const release = read('src/release.ts')
  assert.match(release, /版号/u, 'the materials must name the licence')
  assert.match(release, /小游戏备案/u)
  assert.match(release, /小程序备案/u)
  const review = read('src/review.ts')
  assert.match(review, /版号/u, 'the pre-review must warn about the licence')
  const commerce = read('src/commerce.ts')
  assert.match(commerce, /版号/u, 'the monetization check must gate on the licence')
})

test('the 3D limits are stated instead of promised away', () => {
  const release = read('src/release.ts')
  assert.match(release, /WebGL2/u)
  assert.match(release, /降低分辨率与帧率|低端机/u)
  const review = read('src/review.ts')
  assert.match(review, /WebGL2/u)
})
