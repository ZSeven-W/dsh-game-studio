// Real cloudflared integration tests (skipped by default unless DGS_REAL_TUNNEL=1).
import assert from 'node:assert/strict'
import { setDefaultResultOrder } from 'node:dns'
import { resolve4, resolveNs, Resolver } from 'node:dns/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildProject } from '../src/build.ts'
import { createProject } from '../src/project.ts'
import { shareHeartbeatPath, shareInfo, shareTunnelPid, startShare, stopAllShares, stopShare } from '../src/share.ts'
import { findCloudflared } from '../src/tunnel.ts'

function skipReason() {
  if (process.env.DGS_REAL_TUNNEL !== '1') return 'skipped unless DGS_REAL_TUNNEL=1 is set'
  if (!findCloudflared()) return 'skipped because cloudflared is not installed on this machine'
  return undefined
}

async function tempBuiltProject(t, title) {
  const root = await mkdtemp(join(tmpdir(), 'game-studio-real-tunnel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'game')
  await createProject(dir, { title, style: 'watercolor storybook' })
  await buildProject(dir)
  return dir
}

setDefaultResultOrder('ipv4first')

let authResolverPromise
async function getAuthResolver() {
  if (!authResolverPromise) {
    authResolverPromise = (async () => {
      const nsHosts = await resolveNs('trycloudflare.com')
      const ips = (await Promise.all(nsHosts.map(ns => resolve4(ns).catch(() => [])))).flat()
      const resolver = new Resolver({ timeout: 2_000, tries: 1 })
      if (ips.length > 0) resolver.setServers(ips)
      return resolver
    })()
  }
  return authResolverPromise
}

async function waitForAuthoritativeDns(hostname, timeoutMs = 20_000) {
  const resolver = await getAuthResolver()
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    try {
      const records = await resolver.resolve4(hostname)
      if (records.length > 0) {
        // Give Cloudflare's edge DNS nodes a brief moment after authoritative registration before recursive resolvers query it.
        await new Promise(r => setTimeout(r, 1_500))
        return
      }
    } catch {
      // Not published on authoritative NS yet; retry without touching recursive resolvers.
    }
    await new Promise(r => setTimeout(r, 400))
  }
}

async function waitFor200(url, expectedTitle, timeoutMs = 30_000) {
  const started = Date.now()
  const hostname = new URL(url).hostname
  await waitForAuthoritativeDns(hostname, Math.min(20_000, timeoutMs))
  let lastDetail = 'no response'
  while (Date.now() - started <= timeoutMs) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8_000),
        headers: { 'cache-control': 'no-cache' },
      })
      const body = await res.text()
      if (res.status === 200) {
        assert.match(body, new RegExp(`<title>${expectedTitle}</title>`, 'u'))
        return { elapsedMs: Date.now() - started, status: res.status }
      }
      lastDetail = `HTTP ${res.status}`
    } catch (error) {
      lastDetail = error instanceof Error ? (error.cause?.code ?? error.code ?? error.message) : String(error)
    }
    await new Promise(r => setTimeout(r, 500))
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for 200 from ${url} (last: ${lastDetail})`)
}

async function waitForUrlDead(url, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8_000),
        headers: { 'cache-control': 'no-cache' },
      })
      await res.text().catch(() => '')
      if (res.status !== 200) {
        return { elapsedMs: Date.now() - started, statusOrError: `HTTP ${res.status}` }
      }
    } catch (error) {
      const detail = error instanceof Error ? (error.cause?.code ?? error.message) : String(error)
      return { elapsedMs: Date.now() - started, statusOrError: `Error (${detail})` }
    }
    await new Promise(r => setTimeout(r, 500))
  }
  assert.fail(`Public tunnel URL ${url} still returned 200 after ${timeoutMs}ms`)
}

async function waitForPidDead(pid, timeoutMs = 5_000) {
  assert.equal(typeof pid, 'number', 'expected numeric tunnel pid')
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error && error.code === 'ESRCH') return Date.now() - started
      throw error
    }
    await new Promise(r => setTimeout(r, 50))
  }
  assert.fail(`cloudflared process ${pid} is still alive after ${timeoutMs}ms`)
}

test('real tunnel 1 (manual stopShare): serves 200 then invalidates URL, exits process, and deletes heartbeat after stopShare', async (t) => {
  const reason = skipReason()
  if (reason) { t.skip(reason); return }

  const dir = await tempBuiltProject(t, 'Real Tunnel Manual Stop')
  t.after(() => stopShare(dir))

  const t0 = Date.now()
  const info = await startShare(dir, 5, { scope: 'public' })
  const openMs = Date.now() - t0
  const pid = shareTunnelPid(dir)
  assert.equal(typeof pid, 'number')
  assert.equal(JSON.parse(await readFile(shareHeartbeatPath(dir), 'utf8')).url, info.url)

  const first200 = await waitFor200(info.url, 'Real Tunnel Manual Stop', 30_000)

  assert.equal(stopShare(dir), true)
  assert.equal(shareInfo(dir), null)
  const pidDeadMs = await waitForPidDead(pid)
  await assert.rejects(readFile(shareHeartbeatPath(dir), 'utf8'), { code: 'ENOENT' })
  const dead = await waitForUrlDead(info.url, 30_000)

  t.diagnostic(`[case 1 manual stop] url=${info.url} pid=${pid} openMs=${openMs} first200Ms=${first200.elapsedMs} deadMs=${dead.elapsedMs} deadResult=${dead.statusOrError} pidExitMs=${pidDeadMs}`)
})

test('real tunnel 2 (TTL expiry): expires after ttlMs, invalidates URL, exits process, and deletes heartbeat', async (t) => {
  const reason = skipReason()
  if (reason) { t.skip(reason); return }

  const dir = await tempBuiltProject(t, 'Real Tunnel Expiry')
  t.after(() => stopShare(dir))

  const ttlMs = 15_000
  const t0 = Date.now()
  const info = await startShare(dir, 5, { scope: 'public', ttlMs })
  const openMs = Date.now() - t0
  const openedAt = Date.now()
  const pid = shareTunnelPid(dir)
  assert.equal(typeof pid, 'number')
  assert.equal(JSON.parse(await readFile(shareHeartbeatPath(dir), 'utf8')).url, info.url)

  const first200 = await waitFor200(info.url, 'Real Tunnel Expiry', 30_000)

  // Wait until TTL elapses and shareInfo(dir) clears.
  const waitRemaining = Math.max(0, openedAt + ttlMs - Date.now()) + 200
  await new Promise(r => setTimeout(r, waitRemaining))
  const expiryWaitStart = Date.now()
  while (shareInfo(dir) !== null && Date.now() - expiryWaitStart < 3_000) {
    await new Promise(r => setTimeout(r, 50))
  }
  assert.equal(shareInfo(dir), null, 'share should be cleared after TTL expiry')

  const pidDeadMs = await waitForPidDead(pid)
  await assert.rejects(readFile(shareHeartbeatPath(dir), 'utf8'), { code: 'ENOENT' })
  const dead = await waitForUrlDead(info.url, 30_000)

  t.diagnostic(`[case 2 ttl expiry] url=${info.url} pid=${pid} ttlMs=${ttlMs} openMs=${openMs} first200Ms=${first200.elapsedMs} deadAfterExpiryMs=${dead.elapsedMs} deadResult=${dead.statusOrError} pidExitMs=${pidDeadMs}`)
})

test('real tunnel 3 (plugin unload / stopAllShares): invalidates URL, exits process, and deletes heartbeat', async (t) => {
  const reason = skipReason()
  if (reason) { t.skip(reason); return }

  const dir = await tempBuiltProject(t, 'Real Tunnel Unload')
  t.after(() => stopShare(dir))

  const t0 = Date.now()
  const info = await startShare(dir, 5, { scope: 'public' })
  const openMs = Date.now() - t0
  const pid = shareTunnelPid(dir)
  assert.equal(typeof pid, 'number')
  assert.equal(JSON.parse(await readFile(shareHeartbeatPath(dir), 'utf8')).url, info.url)

  const first200 = await waitFor200(info.url, 'Real Tunnel Unload', 30_000)

  stopAllShares()
  assert.equal(shareInfo(dir), null)
  const pidDeadMs = await waitForPidDead(pid)
  await assert.rejects(readFile(shareHeartbeatPath(dir), 'utf8'), { code: 'ENOENT' })
  const dead = await waitForUrlDead(info.url, 30_000)

  t.diagnostic(`[case 3 stopAllShares] url=${info.url} pid=${pid} openMs=${openMs} first200Ms=${first200.elapsedMs} deadMs=${dead.elapsedMs} deadResult=${dead.statusOrError} pidExitMs=${pidDeadMs}`)
})

test('real tunnel 4 (wrong token): returns 404 for / and random path on the same tunnel host', async (t) => {
  const reason = skipReason()
  if (reason) { t.skip(reason); return }

  const dir = await tempBuiltProject(t, 'Real Tunnel Token Check')
  t.after(() => stopShare(dir))

  const t0 = Date.now()
  const info = await startShare(dir, 5, { scope: 'public' })
  const openMs = Date.now() - t0
  const pid = shareTunnelPid(dir)
  assert.equal(typeof pid, 'number')

  const first200 = await waitFor200(info.url, 'Real Tunnel Token Check', 30_000)

  const origin = new URL(info.url).origin
  const rootRes = await fetch(`${origin}/`, { signal: AbortSignal.timeout(8_000) })
  await rootRes.text().catch(() => '')
  assert.equal(rootRes.status, 404)

  const randomRes = await fetch(`${origin}/wrong-token-${Date.now()}/`, { signal: AbortSignal.timeout(8_000) })
  await randomRes.text().catch(() => '')
  assert.equal(randomRes.status, 404)

  stopShare(dir)
  const pidDeadMs = await waitForPidDead(pid)
  await assert.rejects(readFile(shareHeartbeatPath(dir), 'utf8'), { code: 'ENOENT' })
  const dead = await waitForUrlDead(info.url, 30_000)

  t.diagnostic(`[case 4 wrong token] url=${info.url} pid=${pid} openMs=${openMs} first200Ms=${first200.elapsedMs} rootStatus=${rootRes.status} randomStatus=${randomRes.status} deadMs=${dead.elapsedMs} deadResult=${dead.statusOrError} pidExitMs=${pidDeadMs}`)
})
