// Boots an exported WeChat mini-game project in a browser with a fake wx.*
// surface, so the runtime adapter can be exercised outside WeChat DevTools.
//
// Used by test/wechat.test.mjs and by scripts/acceptance.mjs: the acceptance run
// must boot the exact same way the tests do, otherwise it proves nothing.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function launchBrowser() {
  const { chromium } = await import('playwright-core')
  // SwiftShader keeps WebGL2 available on machines (and CI) without a GPU.
  const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  try { return await chromium.launch({ channel: 'chrome', headless: true, args }) }
  catch { try { return await chromium.launch({ channel: 'msedge', headless: true, args }) } catch { return null } }
}

const MOCK_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}canvas{display:block;width:100vw;height:100vh;touch-action:none}</style></head><body><canvas id="game"></canvas><script src="/mock-inject.js"></script></body></html>'

// Loads the exported game.js the way a mini-game would: one global object
// (GameGlobal === window) and a wx.* surface, with no DOM above the canvas.
// `with (GameGlobal)` is what makes the free identifiers inside game.js
// (window, document, THREE, ...) resolve against the fake global, exactly as
// they do in WeChat, where GameGlobal *is* the global object.
const MOCK_INJECT = `(function () {
  var main = document.getElementById('game');
  var mainUsed = false;
  var G = {};
  window.__wxAds = { interstitial: 0, rewarded: 0, events: [] };
  window.__wxIap = { request: null, payment: null };
  window.__wxLogs = [];
  window.__wxSubpackages = [];
  window.__wxAudio = { files: [], played: [] };
  var wx = {
    createCanvas: function () {
      if (!mainUsed) { mainUsed = true; return main; }
      return document.createElement('canvas');
    },
    getSystemInfoSync: function () {
      return {
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        pixelRatio: typeof window.__pixelRatio === 'number' ? window.__pixelRatio : 1,
        benchmarkLevel: typeof window.__benchmarkLevel === 'number' ? window.__benchmarkLevel : undefined
      };
    },
    setPreferredFramesPerSecond: function () {},
    env: { USER_DATA_PATH: '/wxdata' },
    getFileSystemManager: function () {
      return {
        writeFileSync: function (path, data) {
          window.__wxAudio.files.push({ path: path, bytes: data && (data.byteLength || data.length) || 0 });
        }
      };
    },
    createInnerAudioContext: function () {
      var player = {
        src: '',
        onEnded: null,
        onError: null,
        play: function () {
          window.__wxAudio.played.push(this.src);
          if (this.onEnded) setTimeout(this.onEnded, 5);
        },
        destroy: function () {}
      };
      return player;
    },
    createImage: function () { return new Image(); },
    reportEvent: function (id, data) { window.__wxAds.events.push({ id: id, data: data }); },
    request: function (options) {
      window.__wxIap.request = { url: options.url, data: options.data };
      setTimeout(function () { options.success({ statusCode: 200, data: { signData: '{"offerId":"x"}', paySig: 'pay-sig', signature: 'sig' } }); }, 10);
    },
    requestMidasPaymentGameItem: function (options) {
      window.__wxIap.payment = { api: 'midas', signData: options.signData, paySig: options.paySig, signature: options.signature };
      setTimeout(function () { options.success({ errMsg: 'requestMidasPaymentGameItem:ok' }); }, 10);
    },
    requestVirtualPayment: function (options) {
      window.__wxIap.payment = { signData: options.signData, paySig: options.paySig, signature: options.signature, mode: options.mode };
      setTimeout(function () { options.success({ errMsg: 'requestVirtualPayment:ok' }); }, 10);
    },
    createInterstitialAd: function () {
      return { show: function () { window.__wxAds.interstitial += 1; return Promise.resolve(); }, onError: function () {} };
    },
    createRewardedVideoAd: function () {
      var close = null;
      var onError = null;
      window.__wxAds.failRewarded = function (code) {
        if (onError) onError({ errCode: code, errMsg: 'mock ad error ' + code });
      };
      return {
        show: function () { window.__wxAds.rewarded += 1; setTimeout(function () { if (close) close({ isEnded: true }); }, 40); return Promise.resolve(); },
        load: function () { return Promise.resolve(); },
        onClose: function (fn) { close = fn; },
        onError: function (fn) { onError = fn; }
      };
    },
    onTouchStart: function (fn) { window.__touch = function (event) { fn(event); }; },
    onTouchMove: function () {}, onTouchEnd: function () {}, onTouchCancel: function () {},
    onHide: function () {}, onShow: function () {}, onWindowResize: function () {},
    onError: function (fn) { window.__wxError = fn; },
    loadSubpackage: function (options) {
      window.__wxSubpackages.push(options.name);
      setTimeout(function () { if (options.success) options.success({ errMsg: 'loadSubpackage:ok' }); }, 30);
      return { onProgress: function () {} };
    },
    onUnhandledRejection: function (fn) { window.__wxRejection = fn; },
    getRealtimeLogManager: function () {
      return {
        error: function () { window.__wxLogs.push([].slice.call(arguments)); },
        info: function () { window.__wxLogs.push([].slice.call(arguments)); }
      };
    },
    getStorageSync: function (key) { try { return localStorage.getItem(key) || ''; } catch (error) { return ''; } },
    setStorageSync: function (key, value) { try { localStorage.setItem(key, value); } catch (error) {} },
    removeStorageSync: function (key) { try { localStorage.removeItem(key); } catch (error) {} },
    clearStorageSync: function () { try { localStorage.clear(); } catch (error) {} }
  };
  window.__G = G;
  fetch('/game.js').then(function (response) { return response.text(); }).then(function (code) {
    new Function('GameGlobal', 'wx', 'with (GameGlobal) {\\n' + code + '\\n}')(G, wx);
    window.__ready = true;
  }).catch(function (error) { window.__bootError = String(error && error.stack || error); });
})();`

/** Serves one exported project plus a page that fakes the wx.* surface on a real canvas. */
export async function serveMockWx(root) {
  const mime = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/plain', '.html': 'text/html',
  }
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname === '/mock.html') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(MOCK_HTML); return }
      if (url.pathname === '/mock-inject.js') { response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); response.end(MOCK_INJECT); return }
      if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return }
      const file = join(root, decodeURIComponent(url.pathname).replace(/^\/+/u, ''))
      const data = await readFile(file)
      response.writeHead(200, { 'content-type': mime[file.slice(file.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream' })
      response.end(data)
    } catch {
      response.writeHead(404); response.end('not found')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

/**
 * Opens an exported project in a mock-wx page and waits until its script ran.
 * Returns null when neither Chrome nor Edge is installed, and throws when the
 * export failed to boot, so callers can skip or fail on purpose.
 */
export async function openMockPage(exportedDir, options = {}) {
  const browser = await launchBrowser()
  if (!browser) return null
  const { server, port } = await serveMockWx(exportedDir)
  const page = await browser.newPage({ viewport: { width: 500, height: 900 }, deviceScaleFactor: 1 })
  if (options.benchmarkLevel !== undefined || options.pixelRatio !== undefined) {
    await page.addInitScript((values) => {
      if (typeof values.benchmarkLevel === 'number') window.__benchmarkLevel = values.benchmarkLevel
      if (typeof values.pixelRatio === 'number') window.__pixelRatio = values.pixelRatio
    }, options)
  }
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error?.message ?? error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  const close = async () => {
    await page.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    await new Promise((resolve) => server.close(resolve))
  }
  await page.goto(`http://127.0.0.1:${port}/mock.html`)
  await page.waitForFunction('window.__ready === true || window.__bootError', undefined, { timeout: 20000 })
  const boot = await page.evaluate(() => ({ ready: window.__ready === true, error: window.__bootError ?? '' }))
  return { browser, page, errors, boot, close }
}

