// The DevTools "doctor": one probe that reports what is missing before the user
// attempts a preview or upload (CLI present, service port open, real AppID).
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { devtoolsDoctor } from '../src/devtools.ts'

async function project(t, appid) {
  const dir = await mkdtemp(join(tmpdir(), 'devtools-doctor-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'project.config.json'), JSON.stringify({ appid }), 'utf8')
  return dir
}

/** A closed-looking install: an explicit CLI path that does not exist. */
const NO_CLI = join(tmpdir(), 'definitely-missing-cli-for-doctor')

async function quietPort(t) {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('a tourist AppID is named, and a closed port points at the IDE setting', async (t) => {
  const dir = await project(t, 'touristappid')
  const port = await quietPort(t)
  const report = await devtoolsDoctor(dir, { port, configuredCli: NO_CLI })
  assert.equal(report.cliFound, false)
  assert.equal(report.portOpen, false)
  assert.equal(report.tourist, true)
  assert.equal(report.ready, false)
  assert.ok(report.hints.some((hint) => /service port|服务端口/u.test(hint)), 'the port hint stays')
  assert.ok(report.hints.some((hint) => /AppID/u.test(hint)), 'the AppID hint stays')
  assert.ok(report.hints.some((hint) => /DevTools CLI was not found/u.test(hint)))
})

test('an open port and a real AppID are reported as ready', async (t) => {
  const dir = await project(t, 'wx1234567890abcdef')
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const report = await devtoolsDoctor(dir, { port, configuredCli: NO_CLI })
  assert.equal(report.portOpen, true)
  assert.equal(report.appid, 'wx1234567890abcdef')
  assert.equal(report.tourist, false)
  // The CLI is still missing on this machine, so it cannot be "ready".
  assert.equal(report.ready, false)
  assert.ok(report.hints.some((hint) => /DevTools CLI was not found/u.test(hint)))
})
