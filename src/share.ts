/**
 * Play on a phone or share with a friend: a temporary, read-only link on the
 * local network (or a public Cloudflare Quick Tunnel) that serves exactly one
 * file, the project's latest build, behind a random token, with a QR code to
 * scan. It stops by itself after a set time, when asked, when the tunnel exits,
 * or when the plugin unloads. Nothing else on the computer is reachable.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import qrcode from 'qrcode-generator'
import { paths } from './project.ts'
import { openTunnel, requireCloudflared, type Tunnel } from './tunnel.ts'
import { StudioError } from './util.ts'

export type ShareScope = 'lan' | 'public'
export const SHARE_HEARTBEAT_INTERVAL_MS = 20_000

export function shareHeartbeatPath(dir: string): string {
  return join(paths.studio(dir), 'share-alive.json')
}

export interface ShareInfo {
  url: string
  /** QR code of the url as an SVG document. */
  qrSvg: string
  expiresAt: string
  scope: ShareScope
}

export interface ShareOptions {
  scope?: ShareScope
  /** Bind address for LAN sharing (for tests). Ignored when scope is 'public'. */
  host?: string
  /** Override TTL in milliseconds (for tests). */
  ttlMs?: number
  /** Override heartbeat write interval in milliseconds (for tests). */
  heartbeatMs?: number
  /** Path to cloudflared executable (from config or tests). */
  cloudflaredPath?: string
  /** Tunnel startup timeout in milliseconds (for tests). */
  tunnelTimeoutMs?: number
  /** Abort signal to cancel while starting the share. */
  signal?: AbortSignal
  /** Called when the share stops on its own (TTL expiry or unexpected tunnel exit). */
  onStopped?: () => void
}

interface Share extends ShareInfo { server: Server; timer: NodeJS.Timeout; heartbeat: NodeJS.Timeout; tunnel?: Tunnel }

const shares = new Map<string, Share>()
const pending = new Map<string, number>()
let nextGeneration = 0

/** This computer's address on the local network (Wi-Fi or Ethernet), preferring private ranges. */
export function lanAddress(): string | undefined {
  const candidates: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) candidates.push(entry.address)
    }
  }
  const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(ip)
  return candidates.find(isPrivate) ?? candidates[0]
}

function qrSvg(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}

export function shareInfo(dir: string): ShareInfo | null {
  const share = shares.get(dir)
  return share ? { url: share.url, qrSvg: share.qrSvg, expiresAt: share.expiresAt, scope: share.scope } : null
}

/** Local HTTP server bind address and port of an active share (for tests). */
export function shareAddress(dir: string): { address: string; port: number } | null {
  const addr = shares.get(dir)?.server.address()
  return addr && typeof addr === 'object' ? { address: addr.address, port: addr.port } : null
}

/** Tunnel subprocess PID of an active public share (for tests). */
export function shareTunnelPid(dir: string): number | undefined {
  return shares.get(dir)?.tunnel?.pid
}

function writeHeartbeat(dir: string, url: string): void {
  try {
    const file = shareHeartbeatPath(dir)
    mkdirSync(paths.studio(dir), { recursive: true })
    const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(temp, `${JSON.stringify({ url, at: new Date().toISOString() })}\n`)
    renameSync(temp, file)
  } catch {
    // Heartbeat is best-effort.
  }
}

function removeHeartbeat(dir: string): void {
  try { rmSync(shareHeartbeatPath(dir), { force: true }) } catch { /* ignore */ }
}

function closeRegisteredShare(dir: string): boolean {
  const share = shares.get(dir)
  if (!share) return false
  shares.delete(dir)
  clearTimeout(share.timer)
  clearInterval(share.heartbeat)
  removeHeartbeat(dir)
  share.tunnel?.stop()
  share.server.closeAllConnections()
  share.server.close()
  return true
}

export function stopShare(dir: string): boolean {
  const hadPending = pending.delete(dir)
  const hadShare = closeRegisteredShare(dir)
  return hadPending || hadShare
}

export function stopAllShares(): void {
  for (const dir of new Set([...pending.keys(), ...shares.keys()])) stopShare(dir)
}

/** Start (or restart) sharing a project's latest build for `minutes`; `hostOrOptions` is for scope/tests. */
export async function startShare(dir: string, minutes: number, hostOrOptions?: string | ShareOptions): Promise<ShareInfo> {
  const options: ShareOptions = typeof hostOrOptions === 'string' ? { host: hostOrOptions } : (hostOrOptions ?? {})
  const scope: ShareScope = options.scope ?? 'lan'
  const bindHost = scope === 'public' ? '127.0.0.1' : (options.host ?? lanAddress())
  const generation = ++nextGeneration
  pending.set(dir, generation)
  const cancelled = () => pending.get(dir) !== generation || Boolean(options.signal?.aborted)
  try {
    if (bindHost === undefined) throw new StudioError('This computer has no local network address; connect to Wi-Fi first.', 'NO_NETWORK')
    try { await readFile(paths.artifact(dir)) } catch { throw new StudioError('Build the game before sharing it.', 'NO_BUILD') }
    if (cancelled()) throw new StudioError('Share was cancelled before it started.', 'CANCELLED')
    const command = scope === 'public' ? requireCloudflared(options.cloudflaredPath) : undefined
    closeRegisteredShare(dir)
    const token = randomBytes(18).toString('base64url')
    const server = createServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
      if (req.url === `/${token}`) { res.writeHead(302, { location: `/${token}/` }).end(); return }
      if (req.url !== `/${token}/`) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return }
      // Read on every request so a rebuild shows up on the phone after a refresh.
      readFile(paths.artifact(dir)).then((html) => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
          'x-robots-tag': 'noindex, nofollow',
        })
        res.end(req.method === 'HEAD' ? undefined : html)
      }, () => { res.writeHead(404).end() })
    })
    const closeServer = () => {
      server.closeAllConnections()
      server.close()
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, bindHost, () => { server.off('error', reject); resolve() })
    })
    if (cancelled()) {
      closeServer()
      throw new StudioError('Share was cancelled before it started.', 'CANCELLED')
    }
    const port = (server.address() as { port: number }).port
    let tunnel: Tunnel | undefined
    if (scope === 'public') {
      try {
        tunnel = await openTunnel(port, { command, timeoutMs: options.tunnelTimeoutMs, signal: options.signal })
      } catch (error) {
        closeServer()
        throw error
      }
      if (cancelled()) {
        tunnel.stop()
        closeServer()
        throw new StudioError('Share was cancelled before it started.', 'CANCELLED')
      }
    }
    const ttl = options.ttlMs ?? Math.min(240, Math.max(1, Math.round(minutes))) * 60_000
    const heartbeatMs = Math.max(10, options.heartbeatMs ?? SHARE_HEARTBEAT_INTERVAL_MS)
    const url = tunnel ? `${tunnel.url}/${token}/` : `http://${bindHost}:${port}/${token}/`
    const stopThis = () => {
      if (shares.get(dir) !== share) return
      stopShare(dir)
      options.onStopped?.()
    }
    writeHeartbeat(dir, url)
    const heartbeat = setInterval(() => {
      writeHeartbeat(dir, url)
    }, heartbeatMs)
    heartbeat.unref()
    const share: Share = {
      url, qrSvg: qrSvg(url), expiresAt: new Date(Date.now() + ttl).toISOString(), scope, server,
      ...(tunnel ? { tunnel } : {}),
      timer: setTimeout(stopThis, ttl),
      heartbeat,
    }
    share.timer.unref()
    shares.set(dir, share)
    if (tunnel) void tunnel.exited.then(stopThis)
    return shareInfo(dir)!
  } finally {
    if (pending.get(dir) === generation) pending.delete(dir)
  }
}
