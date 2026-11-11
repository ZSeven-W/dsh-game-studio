// WeChat DevTools automation: argument shapes, the IDE's error messages mapped
// to coded errors the agent can act on, and finding the newest export.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  devtoolsArgs, devtoolsCandidates, findDevtools, findWechatExport, mapDevtoolsError,
  requireDevtools, runDevtools,
} from '../src/devtools.ts'

test('devtoolsArgs builds the documented CLI calls', () => {
  assert.deepEqual(devtoolsArgs('open', 'C:/g/export/wechat/isle'), ['open', '--project', 'C:/g/export/wechat/isle'])
  assert.deepEqual(
    devtoolsArgs('preview', 'C:/g/export/wechat/isle', { qr: 'C:/g/export/wechat/isle/preview.png' }),
    ['preview', '--project', 'C:/g/export/wechat/isle', '--qr-format', 'image', '--qr-output', 'C:/g/export/wechat/isle/preview.png'],
  )
  assert.deepEqual(
    devtoolsArgs('preview', 'C:/g/export/wechat/isle'),
    ['preview', '--project', 'C:/g/export/wechat/isle', '--qr-format', 'image'],
  )
  assert.deepEqual(
    devtoolsArgs('upload', 'C:/g/export/wechat/isle', { version: '1.2.3', desc: 'first build' }),
    ['upload', '--project', 'C:/g/export/wechat/isle', '-v', '1.2.3', '-d', 'first build'],
  )
  assert.deepEqual(
    devtoolsArgs('upload', 'C:/g/export/wechat/isle'),
    ['upload', '--project', 'C:/g/export/wechat/isle', '-v', '1.0.0', '-d', 'dsh-game-studio'],
  )
})

test('the IDE messages become coded errors with a fix', () => {
  const port = mapDevtoolsError('[error] IDE service port disabled. To use CLI Call, please enter y to confirm enabling CLI capability')
  assert.equal(port?.code, 'DEVTOOLS_PORT_CLOSED')
  assert.match(port.message, /服务端口/u)

  const portZh = mapDevtoolsError('[error] 工具的服务端口已关闭。要使用命令行调用工具，请手动打开工具 -> 设置 -> 安全设置，将服务端口开启。')
  assert.equal(portZh?.code, 'DEVTOOLS_PORT_CLOSED')

  const appid = mapDevtoolsError('error: invalid appid, please check project.config.json')
  assert.equal(appid?.code, 'DEVTOOLS_BAD_APPID')
  assert.match(appid.message, /tourist AppID/u)

  const missing = mapDevtoolsError('cmd.exe: The system cannot find the path specified.')
  assert.equal(missing?.code, 'NO_DEVTOOLS')

  const login = mapDevtoolsError('[error] 未登录，请先扫码登录')
  assert.equal(login?.code, 'DEVTOOLS_NOT_LOGGED_IN')

  assert.equal(mapDevtoolsError('✔ compiled successfully'), undefined)
})

test('a bogus CLI path is refused instead of run', () => {
  assert.equal(findDevtools('C:/nope/cli.bat'), undefined)
  const error = (() => { try { requireDevtools('C:/nope/cli.bat'); return null } catch (thrown) { return thrown } })()
  assert.equal(error?.code, 'NO_DEVTOOLS')
  assert.match(error.message, /WeChat DevTools was not found/u)
  assert.ok(devtoolsCandidates('win32').some(path => path.includes('微信web开发者工具')))
  assert.equal(devtoolsCandidates('linux').length, 0)
})

test('findWechatExport picks the newest complete export folder', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-devtools-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const game = join(root, 'isle')
  const older = join(game, 'export', 'wechat', 'older')
  const newer = join(game, 'export', 'wechat', 'newer')
  const broken = join(game, 'export', 'wechat', 'broken')
  for (const dir of [older, newer, broken]) await mkdir(dir, { recursive: true })
  for (const dir of [older, newer]) {
    await writeFile(join(dir, 'game.js'), '// game')
    await writeFile(join(dir, 'project.config.json'), '{"compileType":"game"}')
  }
  await writeFile(join(broken, 'game.js'), '// only the game, no project config')
  await utimes(join(older, 'game.js'), new Date('2026-01-01'), new Date('2026-01-01'))
  await utimes(join(newer, 'game.js'), new Date('2026-02-01'), new Date('2026-02-01'))
  assert.equal(findWechatExport(game), newer)
  assert.equal(findWechatExport(join(root, 'nothing-here')), undefined)
})

test('runDevtools captures the CLI output and exit code', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fake = join(root, 'cli.bat')
  await writeFile(fake, '@echo off\r\necho [error] IDE service port disabled.\r\nexit /b 1\r\n')
  const { code, output } = await runDevtools(fake, ['open', '--project', 'C:/some dir/with space'], 30_000)
  assert.equal(code, 1)
  assert.match(output, /service port disabled/u)
  assert.equal(mapDevtoolsError(output)?.code, 'DEVTOOLS_PORT_CLOSED')
})
