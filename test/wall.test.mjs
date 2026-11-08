// The game wall export: real template games, built the way the studio builds
// them, packed into one page; plus the two agent tools and the page itself in
// a real browser.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeState } from '../src/assets.ts'
import { buildProject, runtimeTag } from '../src/build.ts'
import {
  discoverAndFetchSource,
  fetchJsonWithLimit,
  loadFeedCache,
  loadStoredSources,
  MAX_FEED_BYTES,
  MAX_GAMES_PER_SOURCE,
  mergeSources,
  onlineGameToShelfGame,
  parseGamesFeed,
  parseLegacyManifest,
  parseWorkspaceSources,
  resolveSourceCandidates,
  resolveUnderFeedDir,
  saveFeedCache,
  saveStoredSources,
  shouldAutoRefresh,
} from '../src/client/feed.ts'
import { builtLocalGamesCount, dimensionCounts, localWallProjects, mergeShelfGames, viewGames } from '../src/client/shelf.ts'
import { createProject, paths } from '../src/project.ts'
import { listVersions } from '../src/versions.ts'
import { exportWall, listGames } from '../src/wall.ts'

// The Harness supplies @deepseek-ai/dsh-tools; here defineTool only needs to hand the definition back.
const toolsStub = `data:text/javascript,${encodeURIComponent('export function defineTool(definition) { return definition }')}`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: toolsStub, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-wall-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function makeGame(root, dir, options, { build = true } = {}) {
  const path = join(root, dir)
  await createProject(path, options)
  if (build) await writeState(path, await buildProject(path, 'Created'))
  else await writeState(path)
  return path
}

/** The page's data, read the way the page reads it: the text of one script element. */
function pageData(page) {
  const match = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/u.exec(page)
  assert.ok(match, 'the data element is intact')
  return JSON.parse(match[1])
}

test('the wall packs every built game unchanged, with one shared copy of the 3D runtime', async (t) => {
  const root = await workspace(t)
  const flat = await makeGame(root, 'moon', { title: '月光花园' })
  const cube = await makeGame(root, 'isle', { title: 'Lantern Isle', template: 'voxel' })
  const cube2 = await makeGame(root, 'more/isle-2', { title: 'Second Isle', template: 'voxel' })
  await makeGame(root, 'draft', { title: 'Draft' }, { build: false })
  const before = await Promise.all([flat, cube, cube2].map(async dir => ({
    html: await readFile(paths.artifact(dir), 'utf8'), mtime: (await stat(paths.artifact(dir))).mtimeMs, versions: (await listVersions(dir)).length,
  })))

  const result = await exportWall({ root })
  assert.equal(result.file, join(root, 'export', 'game-wall.html'))
  assert.equal(result.games, 3)
  assert.deepEqual(result.skipped, [{ path: 'draft', reason: 'not built yet' }])
  const page = await readFile(result.file, 'utf8')
  assert.equal(Buffer.byteLength(page), result.bytes)
  assert.match(page, /<html lang="zh-CN">/u, 'Chinese titles give a Chinese page')
  assert.match(page, /Content-Security-Policy" content="default-src 'none'/u)

  const data = pageData(page)
  const three = await runtimeTag('three')
  assert.equal(page.split(three.slice(8, 4008)).length - 1, 0, 'the runtime is not inlined raw in the page')
  assert.deepEqual(Object.keys(data.runtimes), ['three'])
  assert.equal(data.runtimes.three, three)
  // Round trip: putting the runtime back gives exactly the game's own build.
  for (const [index, dir] of [flat, cube, cube2].entries()) {
    const game = data.games.find(entry => entry.title === before[index].html.match(/<title>(.*?)<\/title>/u)[1])
    assert.ok(game, dir)
    const restored = game.html.replace(/<!--dsh-runtime:([a-z0-9]+)-->/gu, (_all, id) => data.runtimes[id])
    assert.equal(restored, before[index].html)
  }
  assert.ok(result.bytes < before.reduce((sum, b) => sum + b.html.length, 0), 'smaller than the three builds side by side')

  // Exporting changed nothing in the projects: no rebuild, no new version.
  for (const [index, dir] of [flat, cube, cube2].entries()) {
    assert.equal((await stat(paths.artifact(dir))).mtimeMs, before[index].mtime)
    assert.equal((await listVersions(dir)).length, before[index].versions)
  }
})

test('chosen games keep their order; unknown folders are reported and paths outside the workspace refused', async (t) => {
  const root = await workspace(t)
  await makeGame(root, 'a', { title: 'Alpha' })
  await makeGame(root, 'b', { title: 'Beta' })
  const result = await exportWall({ root, projects: ['b', join(root, 'a'), 'nope'], name: 'For Friends!', lang: 'en' })
  assert.equal(result.file, join(root, 'export', 'for-friends.html'))
  const data = pageData(await readFile(result.file, 'utf8'))
  assert.deepEqual(data.games.map(game => game.title), ['Beta', 'Alpha'])
  assert.deepEqual(result.skipped.map(item => item.path), ['nope'])
  assert.equal(data.lang, 'en')
  await assert.rejects(exportWall({ root, projects: ['../elsewhere'] }), /inside the session working directory/u)
  await assert.rejects(exportWall({ root, projects: ['nope'] }), /No built games/u)
})

test('a title that would close the script element cannot break the page', async (t) => {
  const root = await workspace(t)
  const dir = await makeGame(root, 'evil', { title: 'Boss </script><script>alert(1)</script> <!-- \u2028 end' })
  void dir
  const page = await readFile((await exportWall({ root })).file, 'utf8')
  const data = pageData(page)
  assert.equal(data.games[0].title, 'Boss </script><script>alert(1)</script> <!-- \u2028 end')
  assert.equal(page.split('<script>alert(1)').length - 1, 0, 'the title never appears as markup')
})

test('the wall does not follow links out of the workspace, for folders or covers', async (t) => {
  const root = await workspace(t)
  const outside = await workspace(t)
  await makeGame(outside, 'secret', { title: 'Outside' })
  await symlink(join(outside, 'secret'), join(root, 'linked'))
  const own = await makeGame(root, 'own', { title: 'Own' })
  // A cover that is a link to a file elsewhere is not embedded.
  await writeFile(join(outside, 'private.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  await mkdir(join(own, '.studio'), { recursive: true })
  await symlink(join(outside, 'private.jpg'), join(own, '.studio', 'cover.jpg'))
  assert.deepEqual((await listGames(root)).games.map(game => game.title), ['Own'])
  const data = pageData(await readFile((await exportWall({ root })).file, 'utf8'))
  assert.deepEqual(data.games.map(game => game.title), ['Own'])
  assert.equal(data.games[0].cover, undefined)
})

test('covers are embedded small: PNG art is shrunk, screenshots kept as JPEG', async (t) => {
  const root = await workspace(t)
  const dir = await makeGame(root, 'g', { title: 'G' })
  const { PNG } = createRequire(import.meta.url)('pngjs')
  const big = new PNG({ width: 1024, height: 1024 })
  big.data.fill(200)
  await writeFile(join(dir, 'assets', 'hero.png'), PNG.sync.write(big))
  const manifest = JSON.parse(await readFile(join(dir, 'game.json'), 'utf8'))
  manifest.slots.hero.file = 'assets/hero.png'
  await writeFile(join(dir, 'game.json'), JSON.stringify(manifest))
  let data = pageData(await readFile((await exportWall({ root })).file, 'utf8'))
  const png = Buffer.from(data.games[0].cover.split(',')[1], 'base64')
  assert.equal(png.readUInt32BE(16), 480, 'shrunk to the tile width')

  await writeFile(join(dir, '.studio', 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  data = pageData(await readFile((await exportWall({ root })).file, 'utf8'))
  assert.match(data.games[0].cover, /^data:image\/jpeg;base64,/u)
})

test('the wall filters by 2D/3D and sorts by recent, versions or name', () => {
  const game = (title, dimension, versions, updatedAt) => ({ project: `/w/${title}`, title, dimension, versions, updatedAt, orientation: 'portrait', built: true, cover: undefined })
  const games = [game('企鹅', '3d', 15, '2026-11-04T10:00Z'), game('宝石', '2d', 9, '2026-11-04T12:00Z'), game('Apex', '2d', 6, '2026-11-03T12:00Z'), game('月光', undefined, 3, '2026-11-02T12:00Z')]
  assert.deepEqual(dimensionCounts(games), { all: 4, '2d': 2, '3d': 1 })
  assert.deepEqual(viewGames(games, 'all', 'recent').map(g => g.title), ['企鹅', '宝石', 'Apex', '月光'], 'recent keeps the scan order')
  assert.deepEqual(viewGames(games, '2d', 'recent').map(g => g.title), ['宝石', 'Apex'])
  assert.deepEqual(viewGames(games, '3d', 'recent').map(g => g.title), ['企鹅'])
  assert.deepEqual(viewGames(games, 'all', 'versions').map(g => g.versions), [15, 9, 6, 3])
  const byName = viewGames(games, 'all', 'name').map(g => g.title)
  assert.deepEqual(byName.filter(title => /\p{Script=Han}/u.test(title)), ['宝石', '企鹅', '月光'], 'Chinese titles in pinyin order')
  assert.equal(byName.length, 4)
  assert.deepEqual(games.map(g => g.title), ['企鹅', '宝石', 'Apex', '月光'], 'sorting never reorders the scan itself')
})

// ---------------------------------------------------------------- tools

test('game_studio_list and game_studio_export_wall answer from the working directory', async (t) => {
  const host = await import('../lib/index.js')
  const root = await workspace(t)
  const tools = new Map()
  const ctx = {
    effect(setup) { const dispose = setup(); t.after(() => dispose?.()) },
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    workingDirectory: { ensure: async () => root },
    get: () => undefined,
    inject() {},
  }
  host.apply(ctx, {})
  const exec = { agent: { id: 'session-1' }, callId: 'call-1', signal: new AbortController().signal }
  const call = (name, args) => tools.get(name).execute(args, exec)
  await call('game_studio_create', { path: 'games/penguin', title: '企鹅冰山', template: 'voxel' })
  await call('game_studio_create', { path: 'cat', title: 'Kitchen Cat' })

  const list = await call('game_studio_list', {})
  assert.deepEqual(list.games.map(g => [g.path, g.title, g.dimension, g.built]).sort(), [['cat', 'Kitchen Cat', '2d', true], ['games/penguin', '企鹅冰山', '3d', true]])
  assert.equal(list.note, undefined)

  const wall = await call('game_studio_export_wall', { games: '["cat"]', name: 'friends' })
  assert.equal(wall.file, join('export', 'friends.html'))
  assert.equal(wall.games, 1)
  await assert.rejects(call('game_studio_export_wall', { games: '{"cat": 1}' }), /JSON array/u)
  await assert.rejects(call('game_studio_export_wall', { games: '["../x"]' }), /inside the session working directory/u)
  // The export file and folder are not games, so the list does not change.
  assert.equal((await call('game_studio_list', {})).games.length, 2)
})

// ---------------------------------------------------------------- the page in a browser

test('the exported page plays a tile in place and Esc brings the wall back', { timeout: 120_000 }, async (t) => {
  const root = await workspace(t)
  await makeGame(root, 'moon', { title: 'Moon Garden' })
  await makeGame(root, 'isle', { title: 'Lantern Isle', template: 'voxel' })
  const { file } = await exportWall({ root })
  const { chromium } = createRequire(import.meta.url)('playwright-core')
  let browser
  try { browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }) }
  catch { try { browser = await chromium.launch({ channel: 'msedge', headless: true }) } catch { return t.skip('no Chrome or Edge here') } }
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`file://${file}`)
  assert.equal(await page.locator('.tile').count(), 2)
  assert.deepEqual(await page.locator('.chip').allTextContents(), ['All 2', '2D 1', '3D 1'])
  await page.locator('.chip', { hasText: '3D' }).click()
  assert.deepEqual(await page.locator('.tile .name').allTextContents(), ['Lantern Isle'])

  for (const filter of ['3D', '2D']) {
    await page.locator('.chip', { hasText: filter }).click()
    await page.locator('.tile').first().click()
    const frame = await (await page.waitForSelector('#player.open iframe')).contentFrame()
    await frame.waitForFunction('typeof window.__gameState === "function"', undefined, { timeout: 20_000 })
    assert.equal(await frame.evaluate('window.__gameState().phase'), 'title')
    await page.keyboard.press('Enter')
    await frame.waitForFunction('window.__gameState().phase === "playing"', undefined, { timeout: 10_000 })
    await page.keyboard.press('Escape')
    await page.waitForSelector('#player.open', { state: 'detached', timeout: 5000 }).catch(() => {})
    assert.equal(await page.locator('#player.open').count(), 0, `${filter}: Esc closes the game`)
    assert.equal(await page.locator('#player iframe').count(), 0, `${filter}: the closed game stops running`)
  }
  assert.deepEqual(errors, [])
})

// ---------------------------------------------------------------- online game sources (feed.ts & shelf.ts)

test('feed source normalization and up-to-1-parent probing resolves owner/repo, github.com URL, Pages root, /wall/, single game subpath, and games.json URL', () => {
  // 1) owner/repo shorthand
  const short = resolveSourceCandidates('finiking/dsh-games')
  assert.equal(short.length, 1)
  assert.equal(short[0].baseDir, 'https://finiking.github.io/dsh-games/')
  assert.equal(short[0].feedUrl, 'https://finiking.github.io/dsh-games/games.json')
  assert.equal(short[0].label, 'finiking/dsh-games')

  // 2) github.com repository URL (with or without tree/branch subpath)
  const ghRepo = resolveSourceCandidates('https://github.com/finiking/dsh-games/tree/main/wall')
  assert.deepEqual(ghRepo.map(c => c.baseDir), ['https://finiking.github.io/dsh-games/'])
  assert.equal(ghRepo[0].label, 'finiking/dsh-games')

  // 3) User/org Pages repository (<owner>.github.io)
  const userSite = resolveSourceCandidates('finiking/finiking.github.io')
  assert.deepEqual(userSite.map(c => c.baseDir), ['https://finiking.github.io/'])

  // 4) Direct games.json URL
  const directFeed = resolveSourceCandidates('https://finiking.github.io/dsh-games/games.json')
  assert.deepEqual(directFeed.map(c => c.baseDir), ['https://finiking.github.io/dsh-games/'])
  assert.equal(directFeed[0].feedUrl, 'https://finiking.github.io/dsh-games/games.json')

  // 5) /wall/ URL is never treated as a single game; probes parent site root first
  const wallUrl = resolveSourceCandidates('https://finiking.github.io/dsh-games/wall/')
  assert.equal(wallUrl[0].baseDir, 'https://finiking.github.io/dsh-games/')

  // 6) Single game URL probes current directory and at most 1 parent directory (2 candidates total)
  const singleGame = resolveSourceCandidates('https://finiking.github.io/dsh-games/gem-blast/')
  assert.deepEqual(singleGame.map(c => c.baseDir), [
    'https://finiking.github.io/dsh-games/gem-blast/',
    'https://finiking.github.io/dsh-games/',
  ])

  // 7) Deep path probes at most 1 parent directory (never walks all the way to root beyond 1 parent)
  const deepUrl = resolveSourceCandidates('https://example.com/a/b/c/')
  assert.equal(deepUrl.length, 2)
  assert.deepEqual(deepUrl.map(c => c.baseDir), ['https://example.com/a/b/c/', 'https://example.com/a/b/'])
})

test('feed parsing and fallback: parses games.json, falls back to .dsh-game-studio.json on 404, and merges localStorage with .dsh-game-studio/sources.json', async () => {
  const routes = new Map([
    ['https://alice.github.io/dsh-games/games.json', {
      status: 200,
      body: JSON.stringify({
        format: 'dsh-games-feed',
        version: 1,
        name: "alice's games",
        author: 'alice-dev',
        updatedAt: '2026-11-05T10:00:00Z',
        games: [
          { slug: 'fox', title: 'Moon Fox', dimension: '3d', orientation: 'landscape', url: './fox/', cover: './fox/cover.jpg', publishedAt: '2026-11-05T09:00:00Z' },
        ],
        wall: 'wall/',
      }),
    }],
    ['https://bob.github.io/dsh-games/games.json', { status: 404, body: 'Not Found' }],
    ['https://bob.github.io/dsh-games/.dsh-game-studio.json', {
      status: 200,
      body: JSON.stringify({
        tool: 'dsh-game-studio',
        version: 1,
        updatedAt: '2026-11-04T08:00:00Z',
        games: {
          cat: { title: 'Kitchen Cat', publishedAt: '2026-11-04T08:00:00Z', dimension: '2d', orientation: 'portrait', cover: 'cat/cover.png' },
        },
        wall: null,
      }),
    }],
  ])
  const fakeFetch = async (url) => {
    const hit = routes.get(String(url)) ?? { status: 404, body: 'Not Found' }
    return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json' } })
  }

  // Pasting a single-game link under alice/dsh-games probes ./games.json (404) then ../games.json (200) and subscribes the whole source.
  const alice = await discoverAndFetchSource('https://alice.github.io/dsh-games/fox/', { fetchImpl: fakeFetch })
  assert.equal(alice.source.id, 'https://alice.github.io/dsh-games/')
  assert.equal(alice.source.label, "alice's games")
  assert.equal(alice.feed.author, 'alice-dev')
  assert.equal(alice.feed.games.length, 1)
  assert.equal(alice.feed.games[0].url, 'https://alice.github.io/dsh-games/fox/')
  assert.equal(alice.feed.games[0].cover, 'https://alice.github.io/dsh-games/fox/cover.jpg')
  assert.equal(alice.feed.games[0].orientation, 'landscape')

  // Fallback to .dsh-game-studio.json when games.json returns 404.
  const bob = await discoverAndFetchSource('bob/dsh-games', { fetchImpl: fakeFetch })
  assert.equal(bob.source.id, 'https://bob.github.io/dsh-games/')
  assert.equal(bob.feed.games.length, 1)
  assert.equal(bob.feed.games[0].title, 'Kitchen Cat')
  assert.equal(bob.feed.games[0].url, 'https://bob.github.io/dsh-games/cat/')
  assert.equal(bob.feed.games[0].cover, 'https://bob.github.io/dsh-games/cat/cover.png')

  // Storage round-trip and read-only merge with .dsh-game-studio/sources.json.
  const mem = new Map()
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  saveStoredSources([alice.source], storage)
  assert.equal(loadStoredSources(storage).length, 1)
  const wsSources = parseWorkspaceSources(JSON.stringify({ sources: ['bob/dsh-games', { url: 'https://alice.github.io/dsh-games/', label: 'ignored-dup' }] }))
  const merged = mergeSources(loadStoredSources(storage), wsSources)
  assert.deepEqual(merged.map(s => s.id), ['https://alice.github.io/dsh-games/', 'https://bob.github.io/dsh-games/'])

  const stateEntry = {
    sourceId: alice.source.id,
    name: alice.feed.name,
    author: alice.feed.author,
    updatedAt: alice.feed.updatedAt,
    fetchedAt: '2026-11-05T10:01:00Z',
    games: alice.feed.games,
    droppedCrossOrigin: alice.feed.droppedCrossOrigin,
    status: 'ok',
  }
  saveFeedCache({ [alice.source.id]: stateEntry }, storage)
  const cached = loadFeedCache(storage)
  assert.equal(cached[alice.source.id].games[0].title, 'Moon Fox')
  assert.equal(shouldAutoRefresh(Date.now() - 30_000, Date.now()), false, '2-minute cooldown prevents immediate re-fetch')
  assert.equal(shouldAutoRefresh(Date.now() - 130_000, Date.now()), true, 'allows refresh after 2-minute cooldown')
})

test('feed security: rejects http:, drops cross-origin or ../ sibling-path url/cover outside the feed directory, caps at 200 games, aborts streaming responses over 256 KB, and accepts unknown higher version', async () => {
  // 1) Reject http: input
  assert.throws(() => resolveSourceCandidates('http://alice.github.io/dsh-games/'), (err) => err.code === 'HTTPS_ONLY')
  const baseDir = new URL('https://alice.github.io/dsh-games/')
  assert.equal(resolveUnderFeedDir('http://alice.github.io/dsh-games/fox/', baseDir, 'game'), undefined)

  // 2) Same-origin but outside feed directory (../other-repo/) MUST be rejected!
  const feedUrl = 'https://alice.github.io/dsh-games/games.json'
  assert.equal(resolveUnderFeedDir('../other-repo/evil/', baseDir, 'game'), undefined, '../ sibling path escaping feed directory is rejected')
  assert.equal(resolveUnderFeedDir('/other-repo/evil/', baseDir, 'game'), undefined, 'root-relative path outside feed directory is rejected')
  assert.equal(resolveUnderFeedDir('https://evil.example.com/game/', baseDir, 'game'), undefined, 'cross-origin URL is rejected')
  assert.equal(resolveUnderFeedDir('./fox/', baseDir, 'game'), 'https://alice.github.io/dsh-games/fox/')

  // 3) parseGamesFeed drops cross-origin / parent-escaping entries, caps at 200 games, and accepts version: 2
  const manyGames = [
    { slug: 'escape', title: 'Escape Dir', url: '../other-repo/evil/' },
    { slug: 'cross', title: 'Cross Origin', url: 'https://evil.example.com/game/' },
    { slug: 'bad-cover', title: 'Bad Cover', url: './bad-cover/', cover: '../other-repo/steal.png' },
    ...Array.from({ length: 210 }, (_, i) => ({
      slug: `g-${i}`,
      title: `Game ${i}`,
      dimension: i % 2 === 0 ? '2d' : '3d',
      orientation: 'portrait',
      url: `./g-${i}/`,
      cover: `./g-${i}/cover.jpg`,
      publishedAt: '2026-11-05T00:00:00Z',
    })),
  ]
  const parsed = parseGamesFeed({
    format: 'dsh-games-feed',
    version: 2,
    name: 'alice games',
    author: 'alice',
    updatedAt: '2026-11-05T00:00:00Z',
    extraFutureField: { ok: true },
    games: manyGames,
  }, feedUrl, 'fallback')
  assert.equal(parsed.author, 'alice')
  assert.equal(parsed.droppedCrossOrigin, 3, 'dropped ../other-repo/evil/, cross-origin URL, and ../other-repo/steal.png cover')
  assert.equal(parsed.games.length, MAX_GAMES_PER_SOURCE, 'capped at 200 games per source')
  assert.equal(parsed.games[0].slug, 'g-0')
  assert.equal(parsed.games[0].cover, 'https://alice.github.io/dsh-games/g-0/cover.jpg')

  // 4) Legacy manifest also enforces under-feed-directory check
  const legacy = parseLegacyManifest({
    tool: 'dsh-game-studio',
    version: 99,
    games: {
      ok: { title: 'OK', cover: 'ok/cover.svg' },
      badCover: { title: 'Bad Cover', cover: '../outside/cover.svg' },
    },
  }, 'https://alice.github.io/dsh-games/.dsh-game-studio.json', 'alice')
  assert.equal(legacy.games.length, 1, 'entry with cover outside feed directory was dropped')
  assert.equal(legacy.droppedCrossOrigin, 1)
  assert.equal(legacy.games[0].slug, 'ok')

  // 5) Streaming response exceeding 256 KB without Content-Length header is aborted with FEED_TOO_LARGE
  const chunk = new Uint8Array(100 * 1024).fill(0x20)
  const oversizedStreamFetch = async () => {
    let sent = 0
    const stream = new ReadableStream({
      pull(controller) {
        if (sent >= 3) { controller.close(); return }
        sent += 1
        controller.enqueue(chunk)
      },
    })
    return new Response(stream, { status: 200 })
  }
  await assert.rejects(
    fetchJsonWithLimit('https://alice.github.io/dsh-games/games.json', { fetchImpl: oversizedStreamFetch, maxBytes: MAX_FEED_BYTES }),
    (err) => err.code === 'FEED_TOO_LARGE',
  )
})

test('localWallProjects and builtLocalGamesCount exclude online games so export and publish wall only ever receive local projects', async (t) => {
  const root = await workspace(t)
  const localDir = await makeGame(root, 'moon', { title: 'Moon Garden' })
  const localGames = (await listGames(root)).games
  const onlineTile = onlineGameToShelfGame({
    slug: 'fox',
    title: 'Online Fox',
    dimension: '3d',
    orientation: 'portrait',
    url: 'https://alice.github.io/dsh-games/fox/',
    cover: undefined,
    publishedAt: '2026-11-05T12:00:00Z',
    sourceId: 'https://alice.github.io/dsh-games/',
    sourceName: 'alice/dsh-games',
    sourceHost: 'alice.github.io',
  })

  const combined = mergeShelfGames(localGames, [onlineTile])
  assert.equal(combined.length, 2)
  assert.equal(dimensionCounts(combined, true).all, 1, 'onlineOnly filter counts only online games')
  assert.equal(viewGames(combined, 'all', 'recent', true).length, 1, 'onlineOnly view returns only online games')

  const projectsForBackend = localWallProjects(combined)
  assert.deepEqual(projectsForBackend, [localDir], 'localWallProjects strips online games')
  assert.equal(builtLocalGamesCount(combined), 1)
  assert.equal(builtLocalGamesCount([onlineTile]), 0, 'online games alone do not enable local wall export/publish')

  // Passing localWallProjects(combined) to exportWall succeeds and packs only the local game.
  const exported = await exportWall({ root, projects: projectsForBackend })
  assert.equal(exported.games, 1)
  const data = pageData(await readFile(exported.file, 'utf8'))
  assert.deepEqual(data.games.map(g => g.title), ['Moon Garden'])
})

const MINI_FAKE_GH = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('gh version 2.60.0'); process.exit(0) }
let method = 'GET', inputFile = null, endpoint = ''
for (let i = 1; i < args.length; i++) {
  if (args[i] === '-X') { method = args[++i]; continue }
  if (args[i] === '--input') { inputFile = args[++i]; continue }
  if (!endpoint) endpoint = args[i]
}
const body = inputFile ? JSON.parse(readFileSync(inputFile, 'utf8')) : null
const stateFile = process.env.FAKE_GH_STATE
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
const save = () => writeFileSync(stateFile, JSON.stringify(state))
const notFound = () => { console.error('gh: Not Found (HTTP 404)'); process.exit(1) }
if (method === 'GET' && endpoint === 'user') { console.log(JSON.stringify({ login: 'octocat' })); process.exit(0) }
if (method === 'POST' && endpoint === 'user/repos') {
  const fullName = 'octocat/' + body.name
  state.repos[fullName] = { head: 'c0', blobs: { b0: Buffer.from('# ' + body.name).toString('base64') }, trees: { t0: { 'README.md': 'b0' } }, commits: { c0: { tree: 't0' } } }
  save()
  console.log(JSON.stringify({ name: body.name, full_name: fullName, private: false, default_branch: 'main' }))
  process.exit(0)
}
const m = /^repos\\/([^/]+\\/[^/]+)(?:\\/(.*))?$/u.exec(endpoint)
if (!m) notFound()
const repo = state.repos[m[1]]
if (!repo) notFound()
const rest = (m[2] || '').split('?')[0]
if (method === 'GET' && rest === '') { console.log(JSON.stringify({ name: 'dsh-games', full_name: m[1], private: false, default_branch: 'main' })); process.exit(0) }
if (method === 'GET' && rest === 'git/ref/heads/main') { console.log(JSON.stringify({ object: { sha: repo.head } })); process.exit(0) }
if (method === 'GET' && rest.startsWith('git/commits/')) { const c = repo.commits[rest.slice(12)]; if (!c) notFound(); console.log(JSON.stringify({ sha: rest.slice(12), tree: { sha: c.tree } })); process.exit(0) }
if (method === 'GET' && rest.startsWith('git/trees/')) { const t = repo.trees[rest.slice(10)]; if (!t) notFound(); console.log(JSON.stringify({ sha: rest.slice(10), tree: Object.entries(t).map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha })), truncated: false })); process.exit(0) }
if (method === 'GET' && rest.startsWith('git/blobs/')) { const b = repo.blobs[rest.slice(10)]; if (!b) notFound(); console.log(JSON.stringify({ sha: rest.slice(10), content: b, encoding: 'base64' })); process.exit(0) }
if (method === 'POST' && rest === 'git/blobs') { const sha = 'b' + (++state.seq); repo.blobs[sha] = body.content; save(); console.log(JSON.stringify({ sha })); process.exit(0) }
if (method === 'POST' && rest === 'git/trees') { const base = { ...(repo.trees[body.base_tree] || {}) }; for (const it of body.tree || []) { if (it.sha === null) delete base[it.path]; else base[it.path] = it.sha } const sha = 't' + (++state.seq); repo.trees[sha] = base; save(); console.log(JSON.stringify({ sha })); process.exit(0) }
if (method === 'POST' && rest === 'git/commits') { const sha = 'c' + (++state.seq); repo.commits[sha] = { tree: body.tree }; save(); console.log(JSON.stringify({ sha })); process.exit(0) }
if (method === 'PATCH' && rest === 'git/refs/heads/main') { repo.head = body.sha; save(); console.log(JSON.stringify({ object: { sha: body.sha } })); process.exit(0) }
if (method === 'POST' && rest === 'pages') { console.log(JSON.stringify({ html_url: 'https://octocat.github.io/dsh-games/' })); process.exit(0) }
if (method === 'GET' && rest === 'pages') { console.log(JSON.stringify({ html_url: 'https://octocat.github.io/dsh-games/', status: 'built' })); process.exit(0) }
if (method === 'GET' && rest === 'pages/builds/latest') { console.log(JSON.stringify({ status: 'built', commit: repo.head })); process.exit(0) }
notFound()
`

test('online wall E2E: local static HTTP server serves fake gh repo output, wall/index.html loads ../games.json and covers under CSP, and plays 2D and 3D games', { timeout: 120_000 }, async (t) => {
  const host = await import('../lib/index.js')
  const root = await workspace(t)
  const ghDir = await mkdtemp(join(tmpdir(), 'wall-e2e-gh-'))
  t.after(() => rm(ghDir, { recursive: true, force: true }))
  const ghBin = join(ghDir, 'gh')
  const stateFile = join(ghDir, 'state.json')
  await writeFile(ghBin, MINI_FAKE_GH)
  await chmod(ghBin, 0o755)
  spawnSync(ghBin, ['--version'])
  await writeFile(stateFile, JSON.stringify({ seq: 0, repos: {} }))
  process.env.FAKE_GH_STATE = stateFile
  t.after(() => { delete process.env.FAKE_GH_STATE })

  const tools = new Map()
  const services = {
    approval: { request: async () => 'allowed-once' },
  }
  const ctx = {
    effect(setup) { const dispose = setup(); t.after(() => dispose?.()) },
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    workingDirectory: { ensure: async () => root },
    get: (name) => services[name],
    inject(names, callback) {
      if (names.every(name => services[name] !== undefined)) callback({ ...services, effect() {} })
    },
  }
  host.apply(ctx, { ghPath: ghBin, pagesTimeoutMs: 200 })
  const exec = { agent: { id: 'session-e2e' }, callId: 'call-e2e', signal: new AbortController().signal }
  const call = (name, args) => tools.get(name).execute(args, exec)

  await call('game_studio_create', { path: 'moon', title: 'Moon Garden' })
  await call('game_studio_create', { path: 'isle', title: 'Lantern Isle', template: 'voxel' })
  await call('game_studio_publish', { wall: true })

  // Read the published files directly from the fake gh repository tree.
  const st = JSON.parse(await readFile(stateFile, 'utf8'))
  const repo = st.repos['octocat/dsh-games']
  const tree = repo.trees[repo.commits[repo.head].tree]
  const repoFiles = new Map()
  for (const [path, bSha] of Object.entries(tree)) {
    repoFiles.set('/' + path, Buffer.from(repo.blobs[bSha], 'base64'))
  }
  assert.ok(repoFiles.has('/wall/index.html'), 'published repo has /wall/index.html')
  assert.ok(repoFiles.has('/games.json'), 'published repo has /games.json')
  assert.ok(repoFiles.has('/moon/index.html'), 'published repo has /moon/index.html')
  assert.ok(repoFiles.has('/moon/cover.svg'), 'published repo has /moon/cover.svg')
  assert.ok(repoFiles.has('/isle/index.html'), 'published repo has /isle/index.html')
  assert.ok(repoFiles.has('/isle/cover.svg'), 'published repo has /isle/cover.svg')

  const mimeOf = (p) => {
    if (p.endsWith('.html')) return 'text/html; charset=utf-8'
    if (p.endsWith('.json')) return 'application/json; charset=utf-8'
    if (p.endsWith('.svg')) return 'image/svg+xml'
    if (p.endsWith('.png')) return 'image/png'
    if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
    if (p.endsWith('.webp')) return 'image/webp'
    return 'application/octet-stream'
  }
  const requestedPaths = []
  const server = createServer((req, res) => {
    let urlPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (urlPath.endsWith('/')) urlPath += 'index.html'
    requestedPaths.push(urlPath)
    const buf = repoFiles.get(urlPath)
    if (!buf) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not Found')
      return
    }
    res.writeHead(200, { 'content-type': mimeOf(urlPath) })
    res.end(buf)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const { chromium } = createRequire(import.meta.url)('playwright-core')
  let browser
  try { browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }) }
  catch { try { browser = await chromium.launch({ channel: 'msedge', headless: true }) } catch { return t.skip('no Chrome or Edge here') } }
  t.after(() => browser.close())

  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  const errors = []
  const cspConsoleErrors = []
  const failedRequests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', msg => {
    if (msg.type() === 'error' && /Content Security Policy|Refused to/iu.test(msg.text())) {
      cspConsoleErrors.push(msg.text())
    }
  })
  page.on('requestfailed', req => failedRequests.push(`${req.url()} (${req.failure()?.errorText ?? 'failed'})`))

  await page.goto(`${baseUrl}/wall/`)
  await page.waitForFunction(() => (document.getElementById('count')?.textContent ?? '') !== '', undefined, { timeout: 10_000 })
  assert.deepEqual(cspConsoleErrors, [], 'no CSP violation console errors')
  assert.equal(await page.locator('.tile').count(), 2, 'online wall loaded 2 games from ../games.json')
  assert.ok(requestedPaths.includes('/games.json'), 'fetched /games.json from server')
  assert.deepEqual(await page.locator('.chip').allTextContents(), ['All 2', '2D 1', '3D 1'])

  // Wait for cover images to finish loading and verify naturalWidth > 0 (not blocked by CSP).
  await page.waitForFunction(
    () => {
      const imgs = Array.from(document.querySelectorAll('.tile img'))
      return imgs.length === 2 && imgs.every(img => img.complete && img.naturalWidth > 0)
    },
    undefined,
    { timeout: 10_000 },
  )

  for (const filter of ['3D', '2D']) {
    await page.locator('.chip', { hasText: filter }).click()
    await page.locator('.tile').first().click()
    const frame = await (await page.waitForSelector('#player.open iframe')).contentFrame()
    await frame.waitForFunction('typeof window.__gameState === "function"', undefined, { timeout: 20_000 })
    assert.equal(await frame.evaluate('window.__gameState().phase'), 'title')
    await page.keyboard.press('Enter')
    await frame.waitForFunction('window.__gameState().phase === "playing"', undefined, { timeout: 10_000 })
    await page.keyboard.press('Escape')
    await page.waitForSelector('#player.open', { state: 'detached', timeout: 5000 }).catch(() => {})
    assert.equal(await page.locator('#player.open').count(), 0, `${filter}: Esc closes the online game`)
    assert.equal(await page.locator('#player iframe').count(), 0, `${filter}: the closed online game stops running`)
  }

  assert.deepEqual(errors, [], 'no page errors')
  assert.deepEqual(cspConsoleErrors, [], 'no CSP violation console errors')
  assert.deepEqual(failedRequests, [], 'no failed HTTP requests')
})
