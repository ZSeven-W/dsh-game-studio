/**
 * Drive WeChat DevTools for an exported mini-game.
 *
 * WeChat ships a CLI next to the IDE (`cli.bat` on Windows, `cli` inside the
 * macOS app). It can import a project, generate a preview QR code and upload a
 * version, but only after the user turns on the IDE's service port:
 * 工具 → 设置 → 安全设置 → 服务端口. This module never changes that setting; it
 * explains how to turn it on and stops.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { StudioError } from './util.ts'

export type DevtoolsAction = 'open' | 'preview' | 'upload' | 'doctor'

export interface DevtoolsOptions {
  /** Explicit CLI path, for a non-standard install. */
  cli?: string
  version?: string
  desc?: string
  timeoutMs?: number
}

export interface DevtoolsResult {
  action: DevtoolsAction
  project: string
  output: string
  qr: string | null
  /** Parsed --info-output (compiled package sizes), when the IDE wrote one. */
  info: unknown | null
}

const DEFAULT_TIMEOUT_MS = 120_000
// eslint-disable-next-line no-control-regex -- stripping terminal escape sequences from the IDE output
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/gu

export const DEVTOOLS_PORT_HINT = 'WeChat DevTools must have its service port on: 工具 → 设置 → 安全设置 → 服务端口 → 开启，'
  + '然后重新运行。插件不会替你打开这个设置。'

export function devtoolsInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'Install WeChat DevTools from https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html'
  if (platform === 'darwin') return 'Install WeChat DevTools from https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html (it installs cli under the app bundle)'
  return 'WeChat DevTools has no Linux build; run the upload from a Mac or Windows machine, or use CI with the official devtools CLI.'
}

/** The IDE's service port, as shown in 工具 → 设置 → 安全设置 → 服务端口. */
export const DEVTOOLS_DEFAULT_PORT = 9420

export type DevtoolsProblemCode = 'cli_missing' | 'port_closed' | 'tourist_appid'

export interface DevtoolsProblem {
  /** Stable code so the sidebar can localise the fix; the hint stays for the CLI. */
  code: DevtoolsProblemCode
  hint: string
}

export interface DevtoolsDoctorReport {
  cli: string | null
  cliFound: boolean
  port: number
  portOpen: boolean
  appid: string | null
  tourist: boolean
  ready: boolean
  /** One entry per finding, oldest blocker first. */
  problems: DevtoolsProblem[]
  hints: string[]
}

/** Is something listening on the IDE's service port? A closed port is the usual blocker. */
export function probeDevtoolsPort(port = DEVTOOLS_DEFAULT_PORT, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (open: boolean): void => {
      socket.destroy()
      resolvePort(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function readProjectAppid(exportDir: string): string | null {
  try {
    const config = JSON.parse(readFileSync(join(exportDir, 'project.config.json'), 'utf8')) as { appid?: unknown }
    return typeof config.appid === 'string' ? config.appid.trim() : null
  } catch {
    return null
  }
}

/**
 * One diagnostic before the real attempt: CLI present? service port open? real
 * AppID in the project? Each finding carries the fix, so a non-coder can act on it
 * without reading the IDE's output.
 */
export async function devtoolsDoctor(
  exportDir: string,
  options: { port?: number; configuredCli?: string } = {},
): Promise<DevtoolsDoctorReport> {
  const cli = findDevtools(options.configuredCli)
  const port = options.port ?? DEVTOOLS_DEFAULT_PORT
  const appid = readProjectAppid(exportDir)
  const tourist = appid === null || appid === '' || appid === 'touristappid'
  const portOpen = await probeDevtoolsPort(port)
  const problems: DevtoolsProblem[] = []
  if (cli === undefined) problems.push({ code: 'cli_missing', hint: `WeChat DevTools CLI was not found. ${devtoolsInstallHint()}` })
  if (!portOpen) problems.push({ code: 'port_closed', hint: DEVTOOLS_PORT_HINT })
  if (tourist) problems.push({
    code: 'tourist_appid',
    hint: 'The project uses the tourist AppID: preview works, but uploading needs the real mini-game AppID (re-export with the appid).',
  })
  const hints = problems.map((problem) => problem.hint)
  const ready = cli !== undefined && portOpen && !tourist
  if (ready) hints.push('Everything the DevTools path needs is in place: preview and upload can run.')
  return { cli: cli ?? null, cliFound: cli !== undefined, port, portOpen, appid, tourist, ready, problems, hints }
}

function isFile(path: string): boolean {
  try {
    accessSync(path, constants.F_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Where the IDE CLI usually lives on each platform. */
export function devtoolsCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    const roots = [
      process.env['ProgramFiles(x86)'],
      process.env.ProgramFiles,
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
    ].filter((root): root is string => Boolean(root))
    return roots.flatMap(root => [
      join(root, 'Tencent', '微信web开发者工具', 'cli.bat'),
      join(root, 'Tencent', '微信开发者工具', 'cli.bat'),
    ])
  }
  if (platform === 'darwin') {
    return [
      '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
      '/Applications/wechatwebdevtools.app/Contents/Resources/app.nw/bin/cli',
    ]
  }
  return []
}

export function findDevtools(configured?: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (configured !== undefined && configured !== '') return isFile(configured) ? configured : undefined
  return devtoolsCandidates(platform).find(isFile)
}

export function requireDevtools(configured?: string, platform: NodeJS.Platform = process.platform): string {
  const found = findDevtools(configured, platform)
  if (found !== undefined) return found
  throw new StudioError(
    `WeChat DevTools was not found on this computer. ${devtoolsInstallHint(platform)} `
    + '(Tell the user where to download it; do not download or install it yourself.)',
    'NO_DEVTOOLS',
  )
}

/** The exact arguments passed to the IDE CLI; exported so tests can pin them. */
export function devtoolsArgs(
  action: DevtoolsAction,
  projectDir: string,
  options: { qr?: string; info?: string; version?: string; desc?: string } = {},
): string[] {
  if (action === 'open') return ['open', '--project', projectDir]
  if (action === 'preview') {
    const args = ['preview', '--project', projectDir, '--qr-format', 'image']
    if (options.qr) args.push('--qr-output', options.qr)
    if (options.info) args.push('--info-output', options.info)
    return args
  }
  const args = ['upload', '--project', projectDir, '-v', options.version ?? '1.0.0', '-d', options.desc ?? 'dsh-game-studio']
  if (options.info) args.push('--info-output', options.info)
  return args
}

/**
 * The IDE's --info-output JSON (compiled main/subpackage sizes). Older builds may
 * not write it, so a missing or unparsable file is simply null.
 */
export function readDevtoolsInfo(path: string | undefined): unknown | null {
  if (!path) return null
  try {
    const text = readFileSync(path, 'utf8').trim()
    if (!text) return null
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** Turn the IDE's own message into a coded error the agent can act on. */
export function mapDevtoolsError(output: string): StudioError | undefined {
  const text = output.replace(ANSI, '')
  if (/service port disabled|服务端口已关闭/iu.test(text)) {
    return new StudioError(`WeChat DevTools is installed but its service port is closed. ${DEVTOOLS_PORT_HINT}`, 'DEVTOOLS_PORT_CLOSED')
  }
  if (/invalid appid|invalid app id|appid.*(invalid|无效)|touristappid/iu.test(text)) {
    return new StudioError(
      'This project still uses the tourist AppID, which can be compiled and previewed but not uploaded. '
      + 'Set the real mini-game AppID in project.config.json (or re-export with the appid) before uploading.',
      'DEVTOOLS_BAD_APPID',
    )
  }
  if (/not found|is not recognized|cannot find the path/iu.test(text)) {
    return new StudioError(`WeChat DevTools CLI could not be started. ${devtoolsInstallHint()}`, 'NO_DEVTOOLS')
  }
  if (/(?:login|扫码登录|未登录|重新登录)/iu.test(text)) {
    return new StudioError('WeChat DevTools is not signed in. Open the IDE once and scan the login QR code, then retry.', 'DEVTOOLS_NOT_LOGGED_IN')
  }
  return undefined
}

function quoteWindows(arg: string): string {
  return `"${arg.replace(/"/gu, '""')}"`
}

/** Run the IDE CLI and collect its output; the IDE writes human text, not JSON. */
export async function runDevtools(cli: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ code: number | null; output: string }> {
  // cmd.exe needs the whole command wrapped in quotes (`/s` strips only the
  // outermost pair), otherwise a quoted CLI path is read as part of the name.
  const line = [quoteWindows(cli), ...args.map(quoteWindows)].join(' ')
  const child = process.platform === 'win32'
    // windowsVerbatimArguments: Node would otherwise escape the quotes we build.
    ? spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsHide: true, windowsVerbatimArguments: true })
    : spawn(cli, args, { windowsHide: true })
  let output = ''
  const collect = (chunk: Buffer) => { output += chunk.toString('utf8') }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } resolve(null) }, timeoutMs)
    child.on('error', (error) => { output += `\n${error.message}`; clearTimeout(timer); resolve(null) })
    child.on('close', (value) => { clearTimeout(timer); resolve(value) })
  })
  return { code, output: output.trim() }
}

function tail(text: string, lines = 12): string {
  return text.replace(ANSI, '').trim().split(/\r?\n/u).map(line => line.trim()).filter(Boolean).slice(-lines).join(' | ').slice(0, 900)
}

/** Newest `<game>/export/wechat/<slug>/` that looks like a real mini-game project. */
export function findWechatExport(gameDir: string): string | undefined {
  const root = join(gameDir, 'export', 'wechat')
  let names: string[]
  try { names = readdirSync(root) } catch { return undefined }
  const candidates = names
    .map(name => join(root, name))
    .filter(dir => isFile(join(dir, 'game.js')) && isFile(join(dir, 'project.config.json')))
    .map(dir => ({ dir, at: statSync(join(dir, 'game.js')).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  return candidates[0]?.dir
}

async function runAction(cli: string, action: DevtoolsAction, projectDir: string, args: string[], timeoutMs: number): Promise<DevtoolsResult> {
  const infoPath = args.includes('--info-output') ? args[args.indexOf('--info-output') + 1] : undefined
  const { code, output } = await runDevtools(cli, args, timeoutMs)
  const mapped = mapDevtoolsError(output)
  if (mapped) throw mapped
  if (code !== 0) {
    throw new StudioError(`WeChat DevTools ${action} failed: ${tail(output) || `exit code ${code}`}`, 'DEVTOOLS_FAILED')
  }
  const qr = action === 'preview' ? args[args.indexOf('--qr-output') + 1] ?? null : null
  const info = readDevtoolsInfo(infoPath)
  if (infoPath) { try { rmSync(infoPath, { force: true }) } catch { /* optional */ } }
  return { action, project: projectDir, output: tail(output), qr: qr !== null && isFile(qr) ? qr : null, info }
}

export async function openInDevtools(gameDir: string, options: DevtoolsOptions = {}): Promise<DevtoolsResult> {
  const project = findWechatExport(gameDir)
  if (!project) throw new StudioError('No WeChat mini-game export found; run the WeChat export first.', 'NO_WECHAT_EXPORT')
  const cli = requireDevtools(options.cli)
  return await runAction(cli, 'open', project, devtoolsArgs('open', project), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
}

export async function previewInDevtools(gameDir: string, options: DevtoolsOptions = {}): Promise<DevtoolsResult> {
  const project = findWechatExport(gameDir)
  if (!project) throw new StudioError('No WeChat mini-game export found; run the WeChat export first.', 'NO_WECHAT_EXPORT')
  const cli = requireDevtools(options.cli)
  const qr = join(project, 'preview.png')
  const info = join(project, '.devtools-preview.json')
  return await runAction(cli, 'preview', project, devtoolsArgs('preview', project, { qr, info }), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
}

export async function uploadFromDevtools(gameDir: string, options: DevtoolsOptions = {}): Promise<DevtoolsResult> {
  const project = findWechatExport(gameDir)
  if (!project) throw new StudioError('No WeChat mini-game export found; run the WeChat export first.', 'NO_WECHAT_EXPORT')
  const cli = requireDevtools(options.cli)
  const info = join(project, '.devtools-upload.json')
  const args = devtoolsArgs('upload', project, { version: options.version, desc: options.desc, info })
  return await runAction(cli, 'upload', project, args, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
}


