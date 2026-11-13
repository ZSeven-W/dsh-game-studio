// What `npm pack` would publish must be the runtime only: no sources, tests, scripts
// or docs, and within the size budget. The host's installed-build smoke runs from the
// built package, so a CI step covers it separately.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))

test('every declared dependency is locked with a concrete version', () => {
  assert.equal(lock.lockfileVersion, 3)
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const entry = lock.packages?.[`node_modules/${name}`]
    assert.ok(entry?.version, `${name} is not locked`)
  }
})

test('the packed tarball ships runtime files only, within budget', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', shell: process.platform === 'win32', timeout: 120_000,
  })
  const start = out.indexOf('[')
  const entry = JSON.parse(out.slice(start))[0]
  const files = entry.files.map((file) => file.path)
  assert.ok(files.includes('lib/index.js'), 'the build output must be packed')
  const leaked = files.filter((file) => /^(src|test|scripts|docs)\//u.test(file) || file.endsWith('.ts'))
  assert.deepEqual(leaked, [], `sources, tests or docs are packed: ${leaked.slice(0, 3).join(', ')}`)
  assert.ok(entry.size <= 2 * 1024 * 1024, `tarball is ${(entry.size / 1048576).toFixed(2)} MB, budget is 2 MB`)
  assert.equal(entry.version, pkg.version)
})
