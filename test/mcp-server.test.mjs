import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  EXPECTED_MCP_TOOLS,
  installAgy,
  installClaudeCode,
  installGrok,
  uninstallAgy,
  uninstallClaudeCode,
  uninstallGrok,
} from '../scripts/install-hosts.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function spawnMcpClient(entryPath, { cwd = ROOT, env = process.env } = {}) {
  const child = spawn(process.execPath, [entryPath], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  let id = 0
  const pending = new Map()
  lines.on('line', line => {
    const msg = JSON.parse(line)
    const waiter = pending.get(msg.id)
    if (waiter) {
      pending.delete(msg.id)
      waiter(msg)
    }
  })
  return {
    request(method, params) {
      const reqId = ++id
      return new Promise((resolveReq, rejectReq) => {
        const timer = setTimeout(() => {
          pending.delete(reqId)
          rejectReq(new Error(`MCP ${method} timed out`))
        }, 30_000)
        pending.set(reqId, msg => {
          clearTimeout(timer)
          resolveReq(msg)
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params })}\n`)
      })
    },
    async close() {
      lines.close()
      child.stdin.end()
      await new Promise(r => child.once('close', r))
    },
  }
}

test('standalone MCP server works even when copied into a simulated ~/.codex/plugins/cache directory', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dgs-mcp-'))
  try {
    const fakeCachePlugin = join(tmp, '.codex', 'plugins', 'cache', 'zseven-game-studio', 'dsh-game-studio')
    await cp(join(ROOT, 'plugins', 'game-studio'), fakeCachePlugin, { recursive: true })
    const workspace = join(tmp, 'user-workspace')

    const client = spawnMcpClient(join(fakeCachePlugin, 'scripts', 'mcp-server.mjs'), {
      cwd: fakeCachePlugin,
      env: { ...process.env, DSH_GAME_STUDIO_ROOT: ROOT },
    })

    try {
      const init = await client.request('initialize', { protocolVersion: '2025-06-18' })
      assert.equal(init.result.serverInfo.name, 'dsh-game-studio')

      const list = await client.request('tools/list', {})
      const names = list.result.tools.map(t => t.name)
      assert.deepEqual(names, EXPECTED_MCP_TOOLS)

      // Calling from plugin cache without workspaceDir and with relative path must refuse safely!
      const missingWs = await client.request('tools/call', {
        name: 'game_studio_create',
        arguments: { path: 'accidental-cache-game', title: '误写缓存检查' },
      })
      assert.equal(missingWs.result.isError, true)
      assert.equal(missingWs.result.structuredContent.code, 'MISSING_WORKSPACE_DIR')

      // Passing workspaceDir creates, builds, exports Web HTML, and exports WeChat Mini Game inside user's workspace!
      const created = await client.request('tools/call', {
        name: 'game_studio_create',
        arguments: {
          workspaceDir: workspace,
          path: 'pocket-fox',
          title: '口袋小狐狸',
          template: 'voxel',
        },
      })
      assert.ok(!created.result.isError, JSON.stringify(created.result))
      assert.equal(created.result.structuredContent.title, '口袋小狐狸')
      assert.ok((await stat(join(workspace, 'pocket-fox', 'dist', 'index.html'))).size > 100_000)

      const wxExport = await client.request('tools/call', {
        name: 'game_studio_export_wechat',
        arguments: {
          workspaceDir: workspace,
          path: 'pocket-fox',
          appid: 'wxabcdef1234567890',
        },
      })
      assert.ok(!wxExport.result.isError, JSON.stringify(wxExport.result))
      assert.equal(wxExport.result.structuredContent.appid, 'wxabcdef1234567890')
      assert.ok((await stat(join(workspace, 'pocket-fox', 'wx-minigame', 'weapp-adapter.js'))).size > 1_000)

      const listed = await client.request('tools/call', {
        name: 'game_studio_list',
        arguments: { workspaceDir: workspace },
      })
      assert.equal(listed.result.structuredContent.games.length, 1)
      assert.equal(listed.result.structuredContent.games[0].path, 'pocket-fox')
    } finally {
      await client.close()
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('install-hosts installs and cleanly uninstalls Claude Code, Antigravity, and Grok configurations in isolated HOME', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'dgs-home-'))
  try {
    await installClaudeCode({ home: fakeHome })
    await installAgy({ home: fakeHome })
    await installGrok({ home: fakeHome })

    const claudeSettings = JSON.parse(await readFile(join(fakeHome, '.claude', 'settings.json'), 'utf8'))
    assert.equal(claudeSettings.enabledPlugins['dsh-game-studio@dsh-game-studio'], true)
    assert.ok(claudeSettings.permissions.allow.includes('mcp__plugin_dsh-game-studio_dsh-game-studio__game_studio_export_wechat'))

    const agyCfg = JSON.parse(await readFile(join(fakeHome, '.gemini', 'config', 'mcp_config.json'), 'utf8'))
    assert.equal(agyCfg.mcpServers['dsh-game-studio'].disabled, false)
    assert.ok((await stat(join(fakeHome, '.gemini', 'config', 'skills', 'game-studio', 'SKILL.md'))).size > 200)

    const grokToml = await readFile(join(fakeHome, '.grok', 'config.toml'), 'utf8')
    assert.match(grokToml, /\[mcp_servers\.dsh-game-studio\]/u)

    await uninstallClaudeCode({ home: fakeHome })
    await uninstallAgy({ home: fakeHome })
    await uninstallGrok({ home: fakeHome })

    const claudeAfter = JSON.parse(await readFile(join(fakeHome, '.claude', 'settings.json'), 'utf8'))
    assert.equal(claudeAfter.enabledPlugins['dsh-game-studio@dsh-game-studio'], undefined)
    const agyAfter = JSON.parse(await readFile(join(fakeHome, '.gemini', 'config', 'mcp_config.json'), 'utf8'))
    assert.equal(agyAfter.mcpServers['dsh-game-studio'], undefined)
    const grokAfter = await readFile(join(fakeHome, '.grok', 'config.toml'), 'utf8')
    assert.doesNotMatch(grokAfter, /\[mcp_servers\.dsh-game-studio\]/u)
  } finally {
    await rm(fakeHome, { recursive: true, force: true })
  }
})
