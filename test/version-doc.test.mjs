// The README advertises the current plugin release in its header. That line has
// drifted before (0.1.0-rc.5 while the package was rc.72), so it is compared with
// package.json here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the README advertises the version in package.json', () => {
  const claimed = readme.match(/Current plugin release: <code>([^<]+)<\/code>/u)?.[1]
  assert.ok(claimed, 'the README header should state the current release')
  assert.equal(claimed, pkg.version, `README says ${claimed}, package.json says ${pkg.version}`)
})

test('the release example has the rc.N shape', () => {
  const example = readme.match(/npm version ([0-9][^ ]*) --no-git-tag-version/u)?.[1]
    ?? readFileSync(new URL('../docs/RELEASING.md', import.meta.url), 'utf8')
      .match(/npm version ([0-9][^ ]*) --no-git-tag-version/u)?.[1]
  assert.ok(example, 'no npm version example found')
  // The exact number is illustrative (it cannot stay "the next one" forever); the
  // README badge test enforces the real version.
  assert.match(example, /^0\.1\.0-rc\.\d+$/u, `the example should look like 0.1.0-rc.N, got ${example}`)
})
