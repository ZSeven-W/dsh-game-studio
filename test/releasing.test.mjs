// docs/RELEASING.md is the checklist a maintainer follows. Its commands rot like
// any other doc, so the file is checked here: every script exists, the order is
// bump → build → test → pack → install → series, and the failure drill stays.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const text = readFileSync(new URL('../docs/RELEASING.md', import.meta.url), 'utf8')
const scripts = Object.keys(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts ?? {})

test('every command in the release checklist exists', () => {
  for (const name of ['build', 'test', 'acceptance', 'shots', 'trace', 'installed', 'upstream']) {
    const invocation = name === 'test' ? /npm (?:run )?test\b/u : new RegExp(`npm run ${name}\\b`, 'u')
    assert.match(text, invocation, `checklist never runs ${name}`)
    assert.ok(scripts.includes(name), `package.json has no "${name}" script`)
  }
  assert.match(text, /npm version 0\.1\.0-rc\.\d+ --no-git-tag-version/u)
  assert.match(text, /npm pack --pack-destination/u)
  assert.match(text, /plugin_manager install_bundle file:/u)
  assert.match(text, /git format-patch 93459aa\.\.HEAD/u)
})

test('the checklist keeps the order that makes the evidence meaningful', () => {
  const index = (needle) => text.indexOf(needle)
  assert.ok(index('npm run build') < index('npm test'), 'build before tests')
  assert.ok(index('npm test') < index('npm pack --pack-destination'), 'tests before packing')
  assert.ok(index('npm pack --pack-destination') < index('plugin_manager install_bundle'), 'pack before installing')
  assert.ok(index('plugin_manager install_bundle') < index('npm run installed'), 'install before verifying the install')
  assert.ok(index('npm run installed') < index('git format-patch 93459aa..HEAD'), 'verify before regenerating the series')
})

test('the failure drill stays in the checklist', () => {
  assert.match(text, /ACCEPTANCE_FORCE_FAIL=1 npm run acceptance/u)
  assert.match(text, /must exit 1/u)
})
