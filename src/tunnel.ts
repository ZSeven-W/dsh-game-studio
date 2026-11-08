/**
 * Cloudflare Quick Tunnel (`cloudflared tunnel --url http://127.0.0.1:<port>`):
 * opens a temporary public `https://<random>.trycloudflare.com` URL with no
 * account. The plugin never downloads or installs `cloudflared`; it only checks
 * whether the user already has it and gives the install command when missing.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { StudioError } from './util.ts'

export interface Tunnel {
  url: string
  readonly pid?: number
  stop(): void
  exited: Promise<void>
}

const DEFAULT_TIMEOUT_MS = 30_000
const LOG_LIMIT = 32 * 1024
// eslint-disable-next-line no-control-regex -- stripping terminal escape sequences from cloudflared output
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/gu
const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu

function isExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function findCloudflared(configured?: string): string | undefined {
  if (configured !== undefined && configured !== '') {
    return isExecutable(configured) ? configured : undefined
  }
  const names = process.platform === 'win32' ? ['cloudflared.exe', 'cloudflared'] : ['cloudflared']
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutable(candidate)) return candidate
    }
  }
  if (process.platform !== 'win32') {
    for (const candidate of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) {
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

export const NO_TUNNEL_AGENT_HINT = '(Tell the user how to install it; do not download or install it yourself.)'

export function cloudflaredInstallCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'winget install --id Cloudflare.cloudflared'
  if (platform === 'linux') return 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/'
  return 'brew install cloudflared'
}

export function cloudflaredInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return 'Install cloudflared with `winget install --id Cloudflare.cloudflared` (macOS: `brew install cloudflared`).'
  }
  if (platform === 'linux') {
    return 'Install cloudflared from https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ (macOS: `brew install cloudflared`).'
  }
  return 'Install cloudflared with `brew install cloudflared` (Windows: `winget install --id Cloudflare.cloudflared`; Linux: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).'
}

export function requireCloudflared(configured?: string, platform: NodeJS.Platform = process.platform): string {
  const found = findCloudflared(configured)
  if (found !== undefined) return found
  throw new StudioError(
    `cloudflared is required for a public link and was not found on this computer. ${cloudflaredInstallHint(platform)}`,
    'NO_TUNNEL',
  )
}

function tailLines(text: string, lines = 10): string {
  return text.replace(ANSI, '').trim().split(/\r?\n/u).map(line => line.trim()).filter(Boolean).slice(-lines).join(' | ').slice(0, 800)
}

export async function openTunnel(
  port: number,
  options: { command?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Tunnel> {
  const command = requireCloudflared(options.command)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  delete env.FORCE_COLOR

  const child = spawn(command, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })

  let stdoutLog = ''
  let stderrLog = ''
  let dead = false
  let stopCalled = false
  let killTimer: NodeJS.Timeout | undefined

  const exited = new Promise<void>((resolve) => {
    const onDone = () => {
      if (dead) return
      dead = true
      if (killTimer !== undefined) clearTimeout(killTimer)
      resolve()
    }
    child.once('exit', onDone)
    child.once('close', onDone)
    child.once('error', onDone)
  })

  const stop = () => {
    if (stopCalled || dead) return
    stopCalled = true
    try { child.kill('SIGTERM') } catch { /* already exited */ }
    killTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
    }, 3_000)
    killTimer.unref()
  }

  const url = await new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      fn()
    }

    const checkChunk = (combined: string) => {
      const cleaned = combined.replace(ANSI, '')
      const match = TRYCLOUDFLARE_URL.exec(cleaned)
      if (match) {
        finish(() => { resolve(match[0].toLowerCase()) })
      }
    }

    const onStdout = (chunk: Buffer) => {
      stdoutLog += chunk.toString('utf8')
      if (stdoutLog.length > LOG_LIMIT * 2) stdoutLog = stdoutLog.slice(-LOG_LIMIT)
      checkChunk(stdoutLog)
    }

    const onStderr = (chunk: Buffer) => {
      stderrLog += chunk.toString('utf8')
      if (stderrLog.length > LOG_LIMIT * 2) stderrLog = stderrLog.slice(-LOG_LIMIT)
      checkChunk(stderrLog)
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      stop()
      void Promise.race([exited, new Promise(r => setTimeout(r, 300))]).then(() => {
        child.stdout?.off('data', onStdout)
        child.stderr?.off('data', onStderr)
        const detail = tailLines(stderrLog || stdoutLog, 10)
        reject(new StudioError(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for cloudflared to open a tunnel`
          + (detail ? `: ${detail}` : '.'),
          'TUNNEL_TIMEOUT',
        ))
      })
    }, timeoutMs)

    const onAbort = () => {
      finish(() => {
        stop()
        const error = new StudioError('Public tunnel was cancelled before it started.', 'CANCELLED')
        void Promise.race([exited, new Promise(r => setTimeout(r, 300))]).then(() => { reject(error) })
      })
    }

    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)

    child.once('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        stop()
        if (err.code === 'ENOENT') {
          reject(new StudioError(`cloudflared not found at ${command}. ${cloudflaredInstallHint()}`, 'NO_TUNNEL'))
          return
        }
        reject(new StudioError(`Could not start cloudflared: ${err.message}`, 'TUNNEL_FAILED'))
      })
    })

    child.once('close', (code) => {
      finish(() => {
        const detail = tailLines(stderrLog || stdoutLog, 10)
        reject(new StudioError(
          `cloudflared exited (code ${code ?? 'null'}) before giving a tunnel URL`
          + (detail ? `: ${detail}` : '.'),
          'TUNNEL_FAILED',
        ))
      })
    })
  })

  return { url, pid: child.pid, stop, exited }
}
