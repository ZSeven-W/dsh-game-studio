import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { buildProject } from '../src/build.ts'
import { launchBrowser, playtest } from '../src/playtest.ts'
import { createProject } from '../src/project.ts'
import {
  exportWechatProject,
  uploadWechatProject,
  WX_MAIN_PACKAGE_LIMIT_BYTES,
} from '../src/wechat.ts'

async function hasBrowser() {
  try {
    const { browser } = await launchBrowser()
    await browser.close()
    return true
  } catch {
    return false
  }
}

test('exportWechatProject exports a 2D game under 4 MB, rasterizes SVGs when browser exists, and preserves AppID & user share-cover', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dgs-wx-2d-'))
  try {
    const dir = join(ws, 'lantern-meadow')
    await createProject(dir, { title: '月光提灯录', template: 'collector' })

    const first = await exportWechatProject(dir, { appid: 'wx1234567890abcdef' })
    assert.equal(first.appid, 'wx1234567890abcdef')
    assert.equal(first.orientation, 'portrait')
    assert.ok(first.packageBytes > 0 && first.packageBytes < WX_MAIN_PACKAGE_LIMIT_BYTES)
    assert.equal(first.syncedImages.length, 4)

    // Place a user-owned share cover and re-export without passing appid: both must be preserved.
    const shareCover = join(first.outDir, 'images', 'share-cover.png')
    await writeFile(shareCover, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const second = await exportWechatProject(dir)
    assert.equal(second.appid, 'wx1234567890abcdef')
    assert.ok((await stat(shareCover)).size === 4)

    const draft = await readFile(second.submissionDraft, 'utf8')
    assert.match(draft, /月光提灯录/u)
    assert.match(draft, /CADPA 8\+/u)
    assert.match(draft, /单机游戏/u)
    assert.ok(!second.warnings.some(w => w.includes('ASCII English')))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('exportWechatProject exports a 3D Three.js game, flags English title & HTML DOM HUD warnings, and boots inside a simulated WeChat CommonJS sandbox', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dgs-wx-3d-'))
  try {
    const dir = join(ws, 'voxel-isle')
    await createProject(dir, { title: 'Lantern Isle 3D', template: 'voxel' })
    await buildProject(dir, 'initial')

    const exported = await exportWechatProject(dir)
    assert.equal(exported.appid, 'touristappid')
    assert.ok(exported.packageBytes < WX_MAIN_PACKAGE_LIMIT_BYTES)
    // Non-custom 3D template slots are drawn in code, so unused template SVGs are omitted.
    assert.equal(exported.syncedImages.length, 0)
    assert.ok((await stat(join(exported.outDir, 'js', 'three.js'))).size > 100_000)
    assert.ok(exported.warnings.some(w => w.includes('ASCII English')))
    assert.ok(exported.warnings.some(w => w.includes('HTML DOM elements')))

    // Boot weapp-adapter.js + wx-config.js + watchRewardedAd + touch->pointer synthesis in Node!
    const touchHandlers = {}
    let canvasCount = 0
    const fakeScreenCanvas = {
      width: 390,
      height: 844,
      style: {},
      getContext: () => ({
        save() {}, restore() {}, scale() {}, translate() {}, rotate() {},
        beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {},
        fillRect() {}, clearRect() {}, arc() {}, fill() {}, stroke() {},
        createLinearGradient: () => ({ addColorStop() {} }),
        measureText: () => ({ width: 20 }),
        fillText() {}, strokeText() {}, setTransform() {},
      }),
    }
    const fakeWx = {
      createCanvas: () => {
        canvasCount++
        return canvasCount === 1 ? fakeScreenCanvas : { width: 64, height: 64, style: {}, getContext: fakeScreenCanvas.getContext }
      },
      createImage: () => ({ src: '', width: 64, height: 64 }),
      getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, pixelRatio: 2, statusBarHeight: 47 }),
      getMenuButtonBoundingClientRect: () => ({ top: 51, bottom: 83, left: 291, right: 378, width: 87, height: 32 }),
      getDeviceInfo: () => ({ platform: 'ios' }),
      getStorageSync: () => '',
      setStorageSync: () => {},
      onTouchStart: fn => { touchHandlers.start = fn },
      onTouchMove: fn => { touchHandlers.move = fn },
      onTouchEnd: fn => { touchHandlers.end = fn },
      onTouchCancel: fn => { touchHandlers.cancel = fn },
      showToast: () => {},
      showShareMenu: () => {},
      onShareAppMessage: () => {},
      onShareTimeline: () => {},
    }

    // Also test 2D collector booting & transitioning title -> playing via wx.onTouchStart -> pointerdown!
    const dir2d = join(ws, 'wx-2d-boot')
    await createProject(dir2d, { title: '星光森林', template: 'collector' })
    const exp2d = await exportWechatProject(dir2d, { rasterizeSvg: false })

    globalThis.wx = fakeWx
    globalThis.GameGlobal = {
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
    }
    try {
      const req = createRequire(join(exp2d.outDir, 'game.js'))
      req('./game.js')
      assert.equal(globalThis.GameGlobal.window.GAME.isWeChatMiniGame, true)
      assert.equal(globalThis.GameGlobal.window.GAME.safeArea.topHudY, 91)

      // Test pre-100 UV watchRewardedAd instant free reward
      let rewarded = null
      await globalThis.GameGlobal.window.GAME.watchRewardedAd('revive', info => { rewarded = info })
      assert.deepEqual(rewarded, { mode: 'free', slot: 'revive' })

      // Verify initial phase is title, then fire wx.onTouchStart -> synthesized pointerdown -> phase becomes playing!
      assert.equal(globalThis.GameGlobal.window.__gameState().phase, 'title')
      touchHandlers.start({
        touches: [{ identifier: 0, clientX: 195, clientY: 420 }],
        changedTouches: [{ identifier: 0, clientX: 195, clientY: 420 }],
      })
      assert.equal(globalThis.GameGlobal.window.__gameState().phase, 'playing')
    } finally {
      delete globalThis.wx
      delete globalThis.GameGlobal
    }
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('exportWechatProject enforces the 4.00 MB main-package limit with WX_PACKAGE_TOO_LARGE', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dgs-wx-limit-'))
  try {
    const dir = join(ws, 'too-big')
    await createProject(dir, { title: '超包测试', template: 'collector' })
    await mkdir(join(dir, 'assets'), { recursive: true })
    await writeFile(join(dir, 'assets', 'bgm.mp3'), Buffer.alloc(WX_MAIN_PACKAGE_LIMIT_BYTES + 64_000, 0x55))

    await assert.rejects(
      () => exportWechatProject(dir, { rasterizeSvg: false }),
      err => err.code === 'WX_PACKAGE_TOO_LARGE',
    )
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('uploadWechatProject refuses touristappid, surfaces confirmation_upload token, and completes upload with fake wechatide', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dgs-wx-upload-'))
  try {
    const dir = join(ws, 'upload-game')
    await createProject(dir, { title: '一箱见底测试', template: 'collector' })
    await exportWechatProject(dir, { rasterizeSvg: false })

    // 1. Rejects touristappid
    await assert.rejects(
      () => uploadWechatProject(dir, { version: '1.0.0' }),
      err => err.code === 'WX_BAD_APPID',
    )

    // Create a fake wechatide executable matching WeChat DevTools' `wechatide -c <client> upload / polling_task_result`
    const fakeCli = join(ws, 'wechatide-mock')
    await writeFile(
      fakeCli,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('wechatide skill-cli'); process.exit(0); }
if (args.includes('upload')) {
  console.log(JSON.stringify({ status: 'pending', taskId: 'confirmation_upload_abc12345' }));
  process.exit(0);
}
if (args.includes('polling_task_result') && args.includes('confirmation_upload_abc12345')) {
  console.log(JSON.stringify({ status: 'done', uploaded: true }));
  process.exit(0);
}
process.exit(1);
`,
    )
    await chmod(fakeCli, 0o755)

    // 2. First call returns confirmation_required
    const step1 = await uploadWechatProject(dir, {
      appid: 'wxb30466d4fdc08460',
      version: '1.0.1',
      desc: '优化翻箱手感与音效',
      cliPath: fakeCli,
    })
    assert.equal(step1.status, 'confirmation_required')
    assert.equal(step1.confirmationToken, 'confirmation_upload_abc12345')

    // 3. Second call with confirmToken succeeds
    const step2 = await uploadWechatProject(dir, {
      version: '1.0.1',
      desc: '优化翻箱手感与音效',
      confirmToken: step1.confirmationToken,
      cliPath: fakeCli,
    })
    assert.equal(step2.status, 'uploaded')
    assert.equal(step2.appid, 'wxb30466d4fdc08460')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('playtest with platform: "wechat" simulates WeChat capsule safe-area and wx.* runtime in headless browser', async t => {
  if (!(await hasBrowser())) {
    t.skip('No Chrome or Edge installed')
    return
  }
  const ws = await mkdtemp(join(tmpdir(), 'dgs-wx-playtest-'))
  try {
    const dir = join(ws, 'wx-play')
    await createProject(dir, { title: '胶囊试玩', template: 'collector' })
    const report = await playtest(dir, {
      platform: 'wechat',
      seconds: 4,
      rules: { duration: 2 },
    })
    assert.equal(report.platform, 'wechat')
    assert.deepEqual(report.capsuleRect, { top: 51, bottom: 83, left: 291, right: 378, width: 87, height: 32 })
    assert.equal(report.errors.length, 0)
    assert.ok(report.shots.length >= 2)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})
