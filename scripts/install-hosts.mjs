#!/usr/bin/env node
/**
 * One-click multi-host installer & verifier for `@zseven-w/dsh-game-studio`.
 *
 * Usage:
 *   node scripts/install-hosts.mjs <codex|claude|agy|grok|all|verify-codex|uninstall-codex|uninstall-claude|uninstall-agy|uninstall-grok>
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CODEX_MARKETPLACE = 'zseven-game-studio'
const CODEX_PLUGIN_ID = `dsh-game-studio@${CODEX_MARKETPLACE}`
const CODEX_SERVER_NAME = 'dsh_game_studio'
const CLAUDE_MARKETPLACE = 'dsh-game-studio'
const CLAUDE_PLUGIN_KEY = `dsh-game-studio@${CLAUDE_MARKETPLACE}`

export const EXPECTED_MCP_TOOLS = [
  'game_studio_create',
  'game_studio_build',
  'game_studio_playtest',
  'game_studio_generate_asset',
  'game_studio_apply_asset',
  'game_studio_revert_asset',
  'game_studio_list',
  'game_studio_export_wall',
  'game_studio_export',
  'game_studio_export_wechat',
  'game_studio_upload_wechat',
  'game_studio_versions',
  'game_studio_restore_version',
  'game_studio_share',
  'game_studio_publish',
]

function backupFile(file) {
  if (existsSync(file)) {
    const bak = `${file}.dsh-game-studio-backup-${Date.now()}`
    copyFileSync(file, bak)
    return bak
  }
  return null
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function tomlString(s) {
  return JSON.stringify(String(s)).replace(/\x7f/gu, '\\u007f')
}

function removeTomlSection(toml, header) {
  const lines = toml.split('\n')
  const start = lines.findIndex(l => l.trim() === `[${header}]`)
  if (start === -1) return toml
  let end = start + 1
  while (end < lines.length && !/^\s*\[/u.test(lines[end])) end++
  while (end < lines.length && lines[end].trim() === '') end++
  lines.splice(start, end - start)
  return lines.join('\n')
}

async function writeAtomicStateFile(stateDir, name, content) {
  const tempFile = join(stateDir, `.${name}-${randomUUID()}`)
  try {
    await writeFile(tempFile, `${content}\n`, { flag: 'wx', mode: 0o600 })
    await rename(tempFile, join(stateDir, name))
  } finally {
    await rm(tempFile, { force: true })
  }
}

export async function registerHostState(
  stateDir = join(homedir(), '.dsh-game-studio'),
  binary = process.execPath,
  repoRoot = ROOT,
) {
  if (!isAbsolute(binary) || /[\r\n\0]/u.test(binary)) {
    throw new Error('Invalid Node executable path.')
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeAtomicStateFile(stateDir, 'node-path', binary)
  await writeAtomicStateFile(stateDir, 'repo-root', repoRoot)
}

export function resolveCodexBinary() {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    'codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ].filter(Boolean)

  for (const bin of candidates) {
    const res = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 5_000 })
    if (res.status === 0) return bin
  }
  throw new Error('Could not find `codex` CLI in PATH or standard macOS locations.')
}

function runCodexSync(args, { cwd = ROOT } = {}) {
  const bin = resolveCodexBinary()
  const res = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
  if (res.status !== 0) {
    const detail = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim()
    throw new Error(`codex ${args.join(' ')} failed: ${detail}`)
  }
  return (res.stdout ?? '').trim()
}

/**
 * Exercise Codex's real `app-server` plugin loader to verify `dsh_game_studio`
 * loads from `dsh-game-studio@zseven-game-studio` and exposes all 15 tools cleanly.
 */
export async function verifyCodexPluginHost({ env = process.env, timeout = 30_000 } = {}) {
  const binary = resolveCodexBinary()
  const child = spawn(binary, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let id = 0
  const pending = new Map()
  const lines = createInterface({ input: child.stdout })
  const closed = new Promise(r => child.once('close', r))
  const fail = err => {
    for (const req of pending.values()) req.reject(err)
    pending.clear()
  }
  child.on('error', fail)
  child.on('exit', () => fail(new Error('Codex app-server exited before verification completed.')))
  child.stdin.on('error', fail)
  child.stderr.resume()

  lines.on('line', line => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const req = pending.get(msg.id)
    if (!req) return
    pending.delete(msg.id)
    if (msg.error) req.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
    else req.resolve(msg.result)
  })

  function request(method, params) {
    return new Promise((resolveReq, rejectReq) => {
      const current = ++id
      const timer = setTimeout(() => {
        pending.delete(current)
        rejectReq(new Error(`Codex app-server ${method} timed out after ${timeout}ms.`))
      }, timeout)
      pending.set(current, {
        resolve: val => {
          clearTimeout(timer)
          resolveReq(val)
        },
        reject: err => {
          clearTimeout(timer)
          rejectReq(err)
        },
      })
      child.stdin.write(`${JSON.stringify({ id: current, method, params })}\n`)
    })
  }

  try {
    await request('initialize', {
      clientInfo: { name: 'dsh_game_studio_host_check', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    })
    child.stdin.write('{"method":"initialized"}\n')
    const status = await request('mcpServerStatus/list', {
      serverName: CODEX_SERVER_NAME,
      detail: 'toolsAndAuthOnly',
    })
    const server = status?.data?.find(s => s.name === CODEX_SERVER_NAME)
    if (!server) {
      throw new Error(`Codex app-server did not load the \`${CODEX_SERVER_NAME}\` MCP server.`)
    }
    if (server.pluginId !== CODEX_PLUGIN_ID) {
      throw new Error(`Expected pluginId "${CODEX_PLUGIN_ID}", got "${server.pluginId}".`)
    }
    if (server.toolsError) {
      throw new Error(`Codex reported toolsError for ${CODEX_SERVER_NAME}: ${server.toolsError}`)
    }
    const missing = EXPECTED_MCP_TOOLS.filter(t => !server.tools?.[t])
    if (missing.length > 0) {
      throw new Error(`Codex loaded incomplete ${CODEX_SERVER_NAME} tools; missing: ${missing.join(', ')}`)
    }
    return {
      ok: true,
      server: server.name,
      pluginId: server.pluginId,
      toolCount: Object.keys(server.tools ?? {}).length,
      tools: EXPECTED_MCP_TOOLS,
    }
  } finally {
    lines.close()
    child.stdin.end()
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
    await closed
    clearTimeout(killTimer)
  }
}

export async function installCodex({ verify = true } = {}) {
  const actions = []
  await registerHostState()
  actions.push(`registered Node binary (${process.execPath}) & repo root in ~/.dsh-game-studio/`)

  runCodexSync(['plugin', 'marketplace', 'add', ROOT])
  actions.push(`codex: registered marketplace ${CODEX_MARKETPLACE} (${ROOT})`)

  try {
    runCodexSync(['plugin', 'remove', CODEX_PLUGIN_ID])
  } catch {
    // Ignore if not previously installed.
  }
  runCodexSync(['plugin', 'add', CODEX_PLUGIN_ID])
  actions.push(`codex: installed plugin ${CODEX_PLUGIN_ID}`)

  if (verify) {
    const check = await verifyCodexPluginHost()
    actions.push(`codex: verified via app-server (${check.pluginId}, ${check.toolCount} tools ready)`)
  }
  return { ok: true, actions }
}

export async function uninstallCodex() {
  const actions = []
  try {
    runCodexSync(['plugin', 'remove', CODEX_PLUGIN_ID])
    actions.push(`codex: removed plugin ${CODEX_PLUGIN_ID}`)
  } catch {
    actions.push(`codex: plugin ${CODEX_PLUGIN_ID} was not installed`)
  }
  try {
    runCodexSync(['plugin', 'marketplace', 'remove', CODEX_MARKETPLACE])
    actions.push(`codex: removed marketplace ${CODEX_MARKETPLACE}`)
  } catch {
    // Ignore if absent.
  }
  return { ok: true, actions }
}

export async function installClaudeCode({ home = homedir() } = {}) {
  const actions = []
  await registerHostState(join(home, '.dsh-game-studio'))
  const claudeDir = join(home, '.claude')
  const pluginsDir = join(claudeDir, 'plugins')
  mkdirSync(pluginsDir, { recursive: true })

  const knownMpFile = join(pluginsDir, 'known_marketplaces.json')
  const bakMp = backupFile(knownMpFile)
  if (bakMp) actions.push(`backup: ${bakMp}`)
  const known = readJson(knownMpFile, {})
  known[CLAUDE_MARKETPLACE] = {
    source: { source: 'directory', path: ROOT },
    installLocation: ROOT,
    lastUpdated: new Date().toISOString(),
  }
  writeFileSync(knownMpFile, `${JSON.stringify(known, null, 2)}\n`)
  actions.push(`claude: registered marketplace ${CLAUDE_MARKETPLACE} -> ${ROOT}`)

  const settingsFile = join(claudeDir, 'settings.json')
  const bakSettings = backupFile(settingsFile)
  if (bakSettings) actions.push(`backup: ${bakSettings}`)
  const settings = readJson(settingsFile, {})
  const enabled = settings.enabledPlugins && !Array.isArray(settings.enabledPlugins)
    ? settings.enabledPlugins
    : {}
  enabled[CLAUDE_PLUGIN_KEY] = true
  settings.enabledPlugins = enabled

  settings.permissions = settings.permissions ?? {}
  const allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : []
  for (const tool of EXPECTED_MCP_TOOLS) {
    const rule = `mcp__plugin_${CLAUDE_MARKETPLACE}_dsh-game-studio__${tool}`
    if (!allow.includes(rule)) allow.push(rule)
  }
  settings.permissions.allow = allow
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
  actions.push(`claude: enabled ${CLAUDE_PLUGIN_KEY} + ${EXPECTED_MCP_TOOLS.length} permission rules`)

  if (home === homedir()) {
    try {
      spawnSync('claude', ['plugin', 'marketplace', 'add', ROOT], { stdio: 'ignore', timeout: 30_000 })
      spawnSync('claude', ['plugin', 'uninstall', CLAUDE_PLUGIN_KEY], { stdio: 'ignore', timeout: 30_000 })
      const res = spawnSync('claude', ['plugin', 'install', CLAUDE_PLUGIN_KEY, '--scope', 'user', '-y'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      })
      if (res.status === 0) {
        actions.push(`claude: CLI snapshot installed (${CLAUDE_PLUGIN_KEY})`)
      }
    } catch {
      // Settings are already written; CLI refresh is best-effort.
    }
  }
  return { ok: true, actions }
}

export async function uninstallClaudeCode({ home = homedir() } = {}) {
  const actions = []
  const settingsFile = join(home, '.claude', 'settings.json')
  const settings = readJson(settingsFile, null)
  if (settings) {
    backupFile(settingsFile)
    if (settings.enabledPlugins) delete settings.enabledPlugins[CLAUDE_PLUGIN_KEY]
    if (Array.isArray(settings.permissions?.allow)) {
      settings.permissions.allow = settings.permissions.allow.filter(
        r => typeof r !== 'string' || !r.startsWith(`mcp__plugin_${CLAUDE_MARKETPLACE}_`),
      )
    }
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
    actions.push(`claude: removed ${CLAUDE_PLUGIN_KEY} from ${settingsFile}`)
  }
  if (home === homedir()) {
    try {
      spawnSync('claude', ['plugin', 'uninstall', CLAUDE_PLUGIN_KEY], { stdio: 'ignore', timeout: 30_000 })
    } catch {}
  }
  return { ok: true, actions }
}

export async function installAgy({ home = homedir() } = {}) {
  const actions = []
  await registerHostState(join(home, '.dsh-game-studio'))
  const builtServer = join(ROOT, 'lib', 'mcp-server.js')
  const bundledServer = join(ROOT, 'plugins', 'game-studio', 'scripts', 'mcp-server.mjs')
  const serverPath = existsSync(builtServer) ? builtServer : bundledServer
  const mcpFile = join(home, '.gemini', 'config', 'mcp_config.json')
  mkdirSync(dirname(mcpFile), { recursive: true })
  const bak = backupFile(mcpFile)
  if (bak) actions.push(`backup: ${bak}`)
  const cfg = readJson(mcpFile, {})
  cfg.mcpServers = cfg.mcpServers ?? {}
  cfg.mcpServers['dsh-game-studio'] = {
    command: process.execPath,
    args: [serverPath],
    disabled: false,
  }
  writeFileSync(mcpFile, `${JSON.stringify(cfg, null, 2)}\n`)
  actions.push(`agy: registered dsh-game-studio MCP server in ${mcpFile}`)

  const skillDest = join(home, '.gemini', 'config', 'skills', 'game-studio', 'SKILL.md')
  mkdirSync(dirname(skillDest), { recursive: true })
  writeFileSync(skillDest, readFileSync(join(ROOT, 'skills', 'game-studio', 'SKILL.md'), 'utf8'))
  actions.push(`agy: installed skill ${skillDest}`)
  return { ok: true, actions }
}

export async function uninstallAgy({ home = homedir() } = {}) {
  const actions = []
  const mcpFile = join(home, '.gemini', 'config', 'mcp_config.json')
  const cfg = readJson(mcpFile, null)
  if (cfg?.mcpServers?.['dsh-game-studio']) {
    backupFile(mcpFile)
    delete cfg.mcpServers['dsh-game-studio']
    writeFileSync(mcpFile, `${JSON.stringify(cfg, null, 2)}\n`)
    actions.push(`agy: removed dsh-game-studio from ${mcpFile}`)
  }
  const skillDir = join(home, '.gemini', 'config', 'skills', 'game-studio')
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true })
    actions.push(`agy: removed ${skillDir}`)
  }
  return { ok: true, actions }
}

export async function installGrok({ home = homedir() } = {}) {
  const actions = []
  await registerHostState(join(home, '.dsh-game-studio'))
  const builtServer = join(ROOT, 'lib', 'mcp-server.js')
  const bundledServer = join(ROOT, 'plugins', 'game-studio', 'scripts', 'mcp-server.mjs')
  const serverPath = existsSync(builtServer) ? builtServer : bundledServer
  const cfgFile = join(home, '.grok', 'config.toml')
  mkdirSync(dirname(cfgFile), { recursive: true })
  const bak = backupFile(cfgFile)
  if (bak) actions.push(`backup: ${bak}`)
  let toml = removeTomlSection(readText(cfgFile), 'mcp_servers.dsh-game-studio')
  if (toml.length > 0 && !toml.endsWith('\n')) toml += '\n'
  toml += `\n[mcp_servers.dsh-game-studio]\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(serverPath)}]\n`
  writeFileSync(cfgFile, toml)
  actions.push(`grok: registered [mcp_servers.dsh-game-studio] in ${cfgFile}`)
  return { ok: true, actions }
}

export async function uninstallGrok({ home = homedir() } = {}) {
  const actions = []
  const cfgFile = join(home, '.grok', 'config.toml')
  if (existsSync(cfgFile)) {
    backupFile(cfgFile)
    const next = removeTomlSection(readText(cfgFile), 'mcp_servers.dsh-game-studio')
    writeFileSync(cfgFile, next)
    actions.push(`grok: removed [mcp_servers.dsh-game-studio] from ${cfgFile}`)
  }
  return { ok: true, actions }
}

function sameFile(a, b) {
  try { return realpathSync(a) === realpathSync(b) }
  catch { return resolve(a) === resolve(b) }
}

const isMain = Boolean(
  process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url)),
)

if (isMain) {
  const cmd = process.argv[2] ?? 'codex'
  const handlers = {
    codex: () => [installCodex()],
    claude: () => [installClaudeCode()],
    agy: () => [installAgy()],
    grok: () => [installGrok()],
    all: () => [installCodex(), installClaudeCode(), installAgy(), installGrok()],
    'verify-codex': async () => {
      const res = await verifyCodexPluginHost()
      console.log(JSON.stringify(res, null, 2))
      return []
    },
    'uninstall-codex': () => [uninstallCodex()],
    'uninstall-claude': () => [uninstallClaudeCode()],
    'uninstall-agy': () => [uninstallAgy()],
    'uninstall-grok': () => [uninstallGrok()],
  }

  const fn = handlers[cmd]
  if (!fn) {
    console.error(
      'Usage: node scripts/install-hosts.mjs <codex|claude|agy|grok|all|verify-codex|uninstall-codex|uninstall-claude|uninstall-agy|uninstall-grok>',
    )
    process.exit(1)
  }

  try {
    const tasks = await fn()
    for (const task of tasks) {
      const res = await task
      for (const line of res.actions ?? []) {
        console.log('•', line)
      }
    }
  } catch (err) {
    console.error(`install-hosts (${cmd}) failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
