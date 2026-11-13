// The upload path end to end, with a fake DevTools CLI: the command runs the CLI
// we point it at, and on success the wizard's upload step is marked done. This is
// the link between "upload ran" and "the sidebar shows progress".
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PNG } from 'pngjs'

const stub = `data:text/javascript,${encodeURIComponent('export function defineTool(definition) { return definition }')}`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: stub, shortCircuit: true }
    return next(specifier, context)
  },
})
const { apply } = await import('../src/index.ts')

/** A CLI stand-in: writes the QR/info files the real IDE would write, then exits 0. */
async function fakeCli(t, root) {
  await mkdir(root, { recursive: true })
  const script = join(root, 'fake-cli.mjs')
  await writeFile(script, `import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const qr = args.indexOf('--qr-output')
const info = args.indexOf('--info-output')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
if (qr >= 0) writeFileSync(args[qr + 1], png)
if (info >= 0) writeFileSync(args[info + 1], JSON.stringify({ mainPackage: 1024 }))
console.log(args[0] + ' ok')
`, 'utf8')
  if (process.platform === 'win32') {
    const cmd = join(root, 'fake-cli.cmd')
    await writeFile(cmd, `@echo off\r\nnode "${script}" %*\r\n`, 'utf8')
    t.after(() => rm(root, { recursive: true, force: true }))
    return cmd
  }
  const sh = join(root, 'fake-cli.sh')
  await writeFile(sh, `#!/bin/sh\nexec node "${script}" "$@"\n`, 'utf8')
  const { chmod } = await import('node:fs/promises')
  await chmod(sh, 0o755)
  t.after(() => rm(root, { recursive: true, force: true }))
  return sh
}

test('upload runs the CLI it is pointed at and marks the wizard step done', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'devtools-command-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cli = await fakeCli(t, join(root, 'cli'))

  const tools = new Map()
  const commands = new Map()
  const services = {
    credentials: { resolve: async () => ({ value: 'stub', source: 'devtools-command' }) },
    commands: { register: (command) => commands.set(command.name, command) },
  }
  apply({
    effect: (scope) => scope(),
    tools: { register: (tool) => tools.set(tool.name, tool) },
    workingDirectory: { ensure: async () => root },
    get: (name) => services[name],
    inject(names, callback) {
      if (names.every((name) => services[name] !== undefined)) callback({ ...services, effect() {} })
    },
  }, {})
  const run = (input) => commands.get('game-studio').handler({ agent: { id: 'devtools-command' }, rawInput: input })

  const game = join(root, 'upload-game')
  await tools.get('game_studio_create').execute({ path: game, title: 'Upload Game' }, { agent: { id: 'devtools-command' } })
  const manifest = JSON.parse(await readFile(join(game, 'game.json'), 'utf8'))
  for (const [slot, spec] of Object.entries(manifest.slots)) {
    const png = new PNG({ width: spec.size[0], height: spec.size[1] })
    png.data.fill(120)
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255
    const file = `assets/${slot}.png`
    await writeFile(join(game, file), PNG.sync.write(png))
    spec.file = file
  }
  await writeFile(join(game, 'game.json'), JSON.stringify(manifest, null, 2))
  const exported = await run(`export-wechat ${JSON.stringify({ project: game, appid: 'wx1234567890abcdef' })}`)
  assert.equal(exported.kind, 'success', exported.text)

  const preview = await run(`wechat-devtools ${JSON.stringify({ project: game, op: 'preview', cli })}`)
  assert.equal(preview.kind, 'success', preview.text)
  const previewResult = JSON.parse(preview.text)
  assert.ok(previewResult.qr, 'preview returns the QR file it wrote')
  assert.ok((await readFile(previewResult.qr)).length > 0, 'the QR file exists')

  const upload = await run(`wechat-devtools ${JSON.stringify({ project: game, op: 'upload', version: '1.2.3', cli })}`)
  assert.equal(upload.kind, 'success', upload.text)

  // markReleaseDone ran: the wizard's upload step is now done.
  const status = await run(`wechat-release ${JSON.stringify({ project: game, op: 'status' })}`)
  const view = JSON.parse(status.text)
  const step = view.steps.find((entry) => entry.id === 'upload')
  assert.equal(step.status, 'done')
  assert.ok(view.progress.done >= 1)
  // The note records what was uploaded and what the IDE said, not just 'done'.
  assert.match(step.note, /1\.2\.3/u)
  assert.match(step.note, /主包 1 KB/u)
  assert.match(step.note, /upload ok/u)
  assert.deepEqual(view.uploads.map((entry) => entry.version), ['1.2.3'], 'the uploaded version is kept in the status')
  assert.equal(view.uploadStale, false, 'a fresh upload is not stale')
  assert.equal(view.uploads[0].note, step.note)
})
