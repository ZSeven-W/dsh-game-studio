// The plugin's tool surface is part of what users read about: the README names every
// tool and advertises a count in its header. A tool added without a README row (or a
// README row for a removed tool) would mislead the agent's user.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

const registered = [...new Set([...source.matchAll(/name: '(game_studio_[a-z_]+)'/gu)].map((match) => match[1]))]
const documented = new Set([...readme.matchAll(/`(game_studio_[a-z_]+)`/gu)].map((match) => match[1]))

test('every registered tool is named in the README, and nothing else is', () => {
  assert.ok(registered.length >= 15, `expected the tool registrations, found ${registered.length}`)
  const missing = registered.filter((name) => !documented.has(name))
  assert.deepEqual(missing, [], `tools registered but not in README: ${missing.join(', ')}`)
  const ghosts = [...documented].filter((name) => !registered.includes(name))
  assert.deepEqual(ghosts, [], `README names tools that are not registered: ${ghosts.join(', ')}`)
})

test('the tool count in the README header matches the registrations', () => {
  const claimed = readme.match(/(\d+) agent tools/u)?.[1]
  assert.ok(claimed, 'the README header should state the tool count')
  assert.equal(Number(claimed), registered.length, `README says ${claimed} tools, ${registered.length} are registered`)
})
