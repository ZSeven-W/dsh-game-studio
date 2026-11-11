// The /game-studio help lists what the command accepts. A help entry that the
// dispatcher does not handle is a dead end for the agent and for the user.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const stub = `data:text/javascript,${encodeURIComponent('export function defineTool(definition) { return definition }')}`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: stub, shortCircuit: true }
    return next(specifier, context)
  },
})
const host = await import('../lib/index.js')
const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

/** The action ids listed in COMMAND_ACTIONS (the table the help is built from). */
function listedActions() {
  const block = source.slice(source.indexOf('const COMMAND_ACTIONS'), source.indexOf('const COMMAND_HELP'))
  return [...block.matchAll(/\['([a-z-]+)',/gu)].map((match) => match[1])
}

/** Every action the command dispatcher understands. */
function dispatchedActions() {
  return new Set([...source.matchAll(/action === '([a-z-]+)'/gu)].map((match) => match[1]))
}

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-studio-actions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tools = new Map()
  const commands = new Map()
  const services = {
    credentials: { resolve: async () => ({ value: 'stub', source: 'test' }) },
    commands: { register: (command) => commands.set(command.name, command) },
  }
  host.apply({
    effect: (setup) => { setup() },
    tools: { register: (tool) => tools.set(tool.name, tool) },
    workingDirectory: { ensure: async () => root },
    get: (name) => services[name],
    inject(names, callback) {
      if (names.every((name) => services[name] !== undefined)) callback({ ...services, effect() {} })
    },
  }, {})
  return (rawInput) => commands.get('game-studio').handler({ agent: { id: 'actions' }, rawInput })
}

test('every action in the help is dispatched by the command', () => {
  const listed = listedActions()
  const dispatched = dispatchedActions()
  assert.ok(listed.length >= 15, `expected the action table, found ${listed.length}`)
  for (const action of listed) assert.ok(dispatched.has(action), `help lists "${action}" but the command does not handle it`)
})

test('no listed action is rejected as unknown at runtime', async (t) => {
  const run = await harness(t)
  for (const action of listedActions()) {
    const result = await run(`${action} {"project": "a-team-that-does-not-exist"}`)
    const text = String(result?.text ?? result ?? '')
    assert.doesNotMatch(text, /Unknown .*action|Unknown game-studio action|BAD_ACTION/u, `${action} was rejected as unknown: ${text.slice(0, 160)}`)
  }
})
