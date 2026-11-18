/**
 * First-class WeChat Mini Game (`wx-minigame/`) exporter, compliance auditor,
 * and CLI uploader for `dsh-game-studio`.
 *
 * Keeps `game.js` + `game.json` + `assets/` as the single source of truth so one
 * studio project builds cleanly into both:
 *   1. `dist/index.html` — zero-network single-file Web HTML
 *   2. `wx-minigame/`    — < 4 MB WeChat Mini Game package ready for DevTools &真机体验版
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { writeState } from './assets.ts'
import { buildProject, readRuntimeScript } from './build.ts'
import { launchBrowser } from './playtest.ts'
import { loadLedger, loadManifest, paths, type GameManifest, type SlotSpec } from './project.ts'
import { mimeOf, readJson, StudioError, writeFileAtomic, writeJson } from './util.ts'

export const WX_MAIN_PACKAGE_LIMIT_BYTES = 4 * 1024 * 1024 // 4.00 MB WeChat hard main-package limit

export const WX_CAPSULE_PORTRAIT = { top: 51, bottom: 83, left: 291, right: 378, width: 87, height: 32 } as const
export const WX_CAPSULE_LANDSCAPE = { top: 12, bottom: 44, left: 745, right: 832, width: 87, height: 32 } as const

const STUDIO_WX_MANIFEST = '.studio-wx-manifest.json'
const SUBMISSION_DRAFT_FILE = 'WECHAT_SUBMISSION_DRAFT.md'

/**
 * Unshadows globals inside WeChat iOS/Android `WASubContext` CommonJS wrappers,
 * where module factory parameters `(window, document, ...)` may shadow `GameGlobal`.
 */
const WX_SANDBOX_PREAMBLE = [
  '/* Auto-generated WeChat WASubContext sandbox bridge — edit root game.js instead */',
  'var __wxRoot = (typeof GameGlobal !== "undefined") ? GameGlobal : ((typeof globalThis !== "undefined") ? globalThis : this);',
  'var window = __wxRoot.window || __wxRoot;',
  'var self = __wxRoot.self || window;',
  'var document = __wxRoot.document;',
  'var navigator = __wxRoot.navigator;',
  'var performance = __wxRoot.performance;',
  'var localStorage = __wxRoot.__wxStorage;',
  'try { if (!localStorage) localStorage = __wxRoot.localStorage; } catch (_e) {}',
  'var Image = __wxRoot.Image;',
  'var AudioContext = __wxRoot.AudioContext || window.AudioContext;',
  'var webkitAudioContext = __wxRoot.webkitAudioContext || window.webkitAudioContext || AudioContext;',
  'var HTMLCanvasElement = __wxRoot.HTMLCanvasElement;',
  'var FinalizationRegistry = __wxRoot.FinalizationRegistry;',
  'var CustomEvent = __wxRoot.CustomEvent;',
  'var requestAnimationFrame = function (cb) { return (__wxRoot.requestAnimationFrame || window.requestAnimationFrame).call(window, cb); };',
  'var cancelAnimationFrame = function (id) { return (__wxRoot.cancelAnimationFrame || window.cancelAnimationFrame).call(window, id); };',
  '',
].join('\n')

export interface ExportWechatOptions {
  /** WeChat Mini Game AppID (e.g. `wx1234567890abcdef`). Preserves existing AppID on rebuild; defaults to `touristappid`. */
  appid?: string
  /** Output directory path; defaults to `<project>/wx-minigame`. */
  outDir?: string
  /** Optional default WeChat share card title. */
  shareTitle?: string
  /** Optional default Rewarded Video Ad Unit ID (`adunit-...`); leave empty before reaching 100 cumulative UV. */
  adUnitId?: string
  /** Rasterize `.svg` slot files to `.png` for 100% iOS/Android `wx.createImage` compatibility. Default true. */
  rasterizeSvg?: boolean
  /** Overwrite `wx-config.js` even if it already exists. Default false (preserves developer edits). */
  overwriteConfig?: boolean
  signal?: AbortSignal
}

export interface WechatPackageBreakdown {
  codeBytes: number
  imageBytes: number
  audioBytes: number
  otherBytes: number
}

export interface WechatExportResult {
  project: string
  outDir: string
  appid: string
  title: string
  orientation: 'portrait' | 'landscape'
  buildId: string
  packageBytes: number
  limitBytes: number
  budgetPercent: number
  breakdown: WechatPackageBreakdown
  syncedImages: string[]
  syncedAudio: string[]
  submissionDraft: string
  warnings: string[]
}

export interface UploadWechatOptions {
  /** Release version string, e.g. `1.0.0`. */
  version: string
  /** Player-facing Chinese release description (avoid git commit jargon). */
  desc?: string
  /** Optional AppID override written to `project.config.json` before upload. */
  appid?: string
  /** Custom WeChat package directory; defaults to `<project>/wx-minigame`. */
  outDir?: string
  /** CI robot number (1–30) when uploading with a private key. */
  robot?: number
  /** Optional path to `wechatide` or WeChat DevTools `cli`. */
  cliPath?: string
  /** Optional confirmation token returned by a previous `wechatide` call. */
  confirmToken?: string
  signal?: AbortSignal
}

export interface WechatUploadResult {
  project: string
  outDir: string
  appid: string
  version: string
  desc: string
  cli: string
  flavor: 'wechatide' | 'devtools-cli'
  status: 'uploaded' | 'confirmation_required'
  confirmationToken?: string
  packageBytes: number
  warnings: string[]
  output: string
  next: string
}

interface StudioWxManifest {
  schema: 1
  managedImages: string[]
  managedAudio: string[]
}

interface BgmTrackSpec {
  id?: string
  name?: string
  sub?: string
  file: string
}

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

function validateAppId(appid: string): string {
  const clean = appid.trim()
  if (!clean || /\s/u.test(clean)) {
    throw new StudioError(`Invalid WeChat AppID "${appid}". Pass "touristappid" for local preview or a real "wx..." AppID.`, 'WX_BAD_APPID')
  }
  return clean
}

async function rasterizeSvgsToPng(
  items: Array<{ slot: string; svgData: Buffer; size: [number, number] }>,
  signal?: AbortSignal,
): Promise<{ pngs: Map<string, Buffer>; fallbackReason?: string }> {
  const pngs = new Map<string, Buffer>()
  if (items.length === 0) return { pngs }
  let browserHandle: Awaited<ReturnType<typeof launchBrowser>> | undefined
  try {
    browserHandle = await launchBrowser()
  } catch (err) {
    return { pngs, fallbackReason: err instanceof Error ? err.message : String(err) }
  }
  const onAbort = () => { void browserHandle?.browser.close().catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const page = await browserHandle.browser.newPage({ viewport: { width: 512, height: 512 } })
    await page.goto('about:blank')
    for (const item of items) {
      if (signal?.aborted) throw new StudioError('WeChat export cancelled', 'CANCELLED')
      const dataUrl = `data:image/svg+xml;base64,${item.svgData.toString('base64')}`
      const outUrl = await page.evaluate(async ([src, w, h]: [string, number, number]) => {
        const img = new Image()
        img.src = src
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = w
        cv.height = h
        const g = cv.getContext('2d')!
        const iw = img.naturalWidth || w
        const ih = img.naturalHeight || h
        const scale = Math.min(w / iw, h / ih)
        const dw = iw * scale
        const dh = ih * scale
        g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
        return cv.toDataURL('image/png')
      }, [dataUrl, item.size[0], item.size[1]] as [string, number, number])
      if (typeof outUrl === 'string' && outUrl.startsWith('data:image/png;base64,')) {
        pngs.set(item.slot, Buffer.from(outUrl.slice(outUrl.indexOf(',') + 1), 'base64'))
      }
    }
    return { pngs }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await browserHandle.browser.close().catch(() => {})
  }
}

async function measureUploadablePackage(outDir: string): Promise<{ total: number; breakdown: WechatPackageBreakdown }> {
  const breakdown: WechatPackageBreakdown = { codeBytes: 0, imageBytes: 0, audioBytes: 0, otherBytes: 0 }
  const ignoreNames = new Set(['.DS_Store', STUDIO_WX_MANIFEST])

  async function walk(curr: string, relPrefix: string): Promise<void> {
    const entries = await readdir(curr, { withFileTypes: true })
    for (const entry of entries) {
      if (ignoreNames.has(entry.name)) continue
      if (entry.name.toLowerCase().endsWith('.md')) continue // Excluded via project.config.json packOptions.ignore
      const full = join(curr, entry.name)
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(full, rel)
      } else if (entry.isFile()) {
        const size = (await stat(full)).size
        const ext = extname(entry.name).toLowerCase()
        if (ext === '.js' || ext === '.json') breakdown.codeBytes += size
        else if (rel.startsWith('images/') || ['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(ext)) breakdown.imageBytes += size
        else if (rel.startsWith('audio/') || ['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) breakdown.audioBytes += size
        else breakdown.otherBytes += size
      }
    }
  }

  await walk(outDir, '')
  const total = breakdown.codeBytes + breakdown.imageBytes + breakdown.audioBytes + breakdown.otherBytes
  return { total, breakdown }
}

function auditGameForWechat(manifest: GameManifest, gameJsSource: string, appid: string): string[] {
  const warnings: string[] = []
  if (/[A-Za-z]/u.test(manifest.title)) {
    warnings.push(
      `Title "${manifest.title}" contains ASCII English letters. Personal/unlicensed WeChat Mini Games require pure simplified Chinese titles matching the MP console and in-game title screen.`,
    )
  }
  if (/\bcreateElement\s*\(\s*['"](?:div|span|button|p|section|h[1-6])['"]\s*\)/u.test(gameJsSource)) {
    warnings.push(
      'game.js creates HTML DOM elements (div/span/button), which WeChat Mini Game native JSC/V8 runtimes do not render on screen. Draw all HUD, cards, and buttons on Canvas 2D (or a Three.js CanvasTexture ortho overlay on the main WebGL canvas).',
    )
  }
  const webglRendererMatches = gameJsSource.match(/new\s+THREE\.WebGLRenderer\b/gu) ?? []
  if (webglRendererMatches.length > 1 && !/\bif\s*\(\s*!parentWindow\s*\)/u.test(gameJsSource)) {
    warnings.push(
      `game.js instantiates THREE.WebGLRenderer ${webglRendererMatches.length} times. Real iOS/Android WeChat supports only 1 active WebGL context on screenCanvas; guard any thumbnail/offscreen WebGLRenderer so it never runs in WeChat.`,
    )
  }
  if (appid === 'touristappid') {
    warnings.push(
      'AppID is currently "touristappid" (good for local WeChat DevTools preview). Pass your real `appid: "wx..."` before calling game_studio_upload_wechat.',
    )
  }
  return warnings
}

export function renderWeappAdapterSource(): string {
  return `/**
 * Universal WeChat Mini Game DOM/BOM + WebGL2 + Canvas2D + Pointer/Touch + WebAudio Adapter
 * Generated by @zseven-w/dsh-game-studio
 *
 * Invariant: The VERY FIRST wx.createCanvas() call is the on-screen main canvas (#game).
 */
(function () {
  'use strict';

  if (typeof wx === 'undefined' || !wx || typeof wx.createCanvas !== 'function') return;

  var root = (typeof GameGlobal !== 'undefined') ? GameGlobal : ((typeof window !== 'undefined') ? window : globalThis);

  function safeSet(obj, key, val) {
    if (!obj) return;
    try {
      obj[key] = val;
      if (obj[key] === val) return;
    } catch (e) { /* ignore */ }
    try {
      Object.defineProperty(obj, key, { value: val, configurable: true, writable: true });
    } catch (e2) { /* read-only in simulator WebView */ }
  }

  if (!root.window) safeSet(root, 'window', root);
  var win = root.window || root;
  if (!root.self) safeSet(root, 'self', win);
  if (!win.self) safeSet(win, 'self', win);
  safeSet(win, 'parent', win);
  safeSet(win, 'top', win);

  function readWinMetrics() {
    var w = 375, h = 667, dpr = 2, statusBar = 44;
    var safe = null;
    try {
      var info = (typeof wx.getWindowInfo === 'function') ? wx.getWindowInfo() : wx.getSystemInfoSync();
      if (info) {
        w = info.windowWidth || info.screenWidth || w;
        h = info.windowHeight || info.screenHeight || h;
        dpr = info.pixelRatio || info.devicePixelRatio || dpr;
        statusBar = info.statusBarHeight || statusBar;
        safe = info.safeArea || null;
      }
    } catch (e) { /* ignore */ }
    var cap = { top: statusBar + 4, bottom: statusBar + 36, left: Math.max(0, w - 99), right: Math.max(0, w - 12), width: 87, height: 32 };
    try {
      if (typeof wx.getMenuButtonBoundingClientRect === 'function') {
        var rect = wx.getMenuButtonBoundingClientRect();
        if (rect && rect.width > 0 && rect.bottom > 0) cap = rect;
      }
    } catch (e2) { /* ignore */ }
    return {
      w: w,
      h: h,
      dpr: dpr,
      safeArea: {
        top: (safe && safe.top) || statusBar,
        bottom: (safe && safe.bottom) || h,
        left: (safe && safe.left) || 0,
        right: (safe && safe.right) || w,
        width: (safe && safe.width) || w,
        height: (safe && safe.height) || h,
        capsule: cap,
        topHudY: cap.bottom + 8
      }
    };
  }

  var metrics = readWinMetrics();
  safeSet(win, 'innerWidth', metrics.w);
  safeSet(win, 'innerHeight', metrics.h);
  safeSet(win, 'devicePixelRatio', metrics.dpr);
  safeSet(win, '__wxSafeArea', metrics.safeArea);
  if (root !== win) {
    safeSet(root, 'innerWidth', metrics.w);
    safeSet(root, 'innerHeight', metrics.h);
    safeSet(root, 'devicePixelRatio', metrics.dpr);
    safeSet(root, '__wxSafeArea', metrics.safeArea);
  }

  if (typeof win.FinalizationRegistry === 'undefined') {
    var FR = function () {};
    FR.prototype.register = function () {};
    FR.prototype.unregister = function () {};
    safeSet(win, 'FinalizationRegistry', FR);
    safeSet(root, 'FinalizationRegistry', FR);
  }
  if (typeof win.CustomEvent === 'undefined') {
    var CE = function (type, params) {
      this.type = type;
      this.detail = params && params.detail !== undefined ? params.detail : null;
    };
    safeSet(win, 'CustomEvent', CE);
    safeSet(root, 'CustomEvent', CE);
  }

  if (!win.performance || typeof win.performance.now !== 'function') {
    var wxPerf = (typeof wx.getPerformance === 'function') ? wx.getPerformance() : null;
    var t0 = Date.now();
    var perfObj = {
      now: function () {
        if (wxPerf && typeof wxPerf.now === 'function') {
          var v = wxPerf.now();
          return v > 1e13 ? v * 0.001 : v;
        }
        return Date.now() - t0;
      }
    };
    safeSet(win, 'performance', perfObj);
    safeSet(root, 'performance', perfObj);
  }

  var sysPlatform = 'wechat';
  try {
    var devInfo = (typeof wx.getDeviceInfo === 'function') ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    if (devInfo && devInfo.platform) sysPlatform = devInfo.platform;
  } catch (e) { /* ignore */ }
  if (!win.navigator) {
    var navObj = {
      userAgent: 'Mozilla/5.0 (' + sysPlatform + ') AppleWebKit/605.1.15 MiniGame WeChat',
      platform: sysPlatform,
      language: 'zh-CN',
      maxTouchPoints: 5
    };
    safeSet(win, 'navigator', navObj);
    safeSet(root, 'navigator', navObj);
  }

  if (!win.AudioContext && !win.webkitAudioContext && typeof wx.createWebAudioContext === 'function') {
    var WxAudioCtx = function () { return wx.createWebAudioContext(); };
    safeSet(win, 'AudioContext', WxAudioCtx);
    safeSet(win, 'webkitAudioContext', WxAudioCtx);
    safeSet(root, 'AudioContext', WxAudioCtx);
    safeSet(root, 'webkitAudioContext', WxAudioCtx);
  }

  var boundRaf = (typeof win.requestAnimationFrame === 'function')
    ? win.requestAnimationFrame.bind(win)
    : ((typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame
        : function (cb) { return setTimeout(function () { cb(win.performance.now()); }, 16); });
  var boundCaf = (typeof win.cancelAnimationFrame === 'function')
    ? win.cancelAnimationFrame.bind(win)
    : ((typeof cancelAnimationFrame === 'function') ? cancelAnimationFrame : clearTimeout);
  safeSet(win, 'requestAnimationFrame', boundRaf);
  safeSet(win, 'cancelAnimationFrame', boundCaf);
  safeSet(root, 'requestAnimationFrame', boundRaf);
  safeSet(root, 'cancelAnimationFrame', boundCaf);

  var wxStorageShim = {
    getItem: function (k) {
      try {
        var v = wx.getStorageSync(String(k));
        return (v === undefined || v === null || v === '') ? null : String(v);
      } catch (e) { return null; }
    },
    setItem: function (k, v) {
      try { wx.setStorageSync(String(k), String(v)); } catch (e) { /* ignore */ }
    },
    removeItem: function (k) {
      try { wx.removeStorageSync(String(k)); } catch (e) { /* ignore */ }
    },
    clear: function () {
      try { wx.clearStorageSync(); } catch (e) { /* ignore */ }
    }
  };
  safeSet(win, '__wxStorage', wxStorageShim);
  safeSet(root, '__wxStorage', wxStorageShim);
  var hasLocalStorage = false;
  try { hasLocalStorage = !!win.localStorage; } catch (e) { hasLocalStorage = false; }
  if (!hasLocalStorage) {
    safeSet(win, 'localStorage', wxStorageShim);
    safeSet(root, 'localStorage', wxStorageShim);
  }

  var winListeners = {};
  var docListeners = {};
  var canvasListeners = {};

  function addRegListener(bag, type, fn) {
    if (!type || typeof fn !== 'function') return;
    if (!bag[type]) bag[type] = [];
    if (bag[type].indexOf(fn) === -1) bag[type].push(fn);
  }
  function removeRegListener(bag, type, fn) {
    if (!type || !bag[type]) return;
    var idx = bag[type].indexOf(fn);
    if (idx >= 0) bag[type].splice(idx, 1);
  }
  function hasRegListener(bag, type) {
    return !!(bag[type] && bag[type].length > 0);
  }
  function emitReg(bag, type, ev) {
    var list = bag[type];
    if (!list || !list.length) return;
    var copy = list.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i].call(win, ev); } catch (e) { console.error('[weapp-adapter listener]', type, e); }
    }
  }

  function patchCanvas(cv, isScreen) {
    if (!cv || cv.__dshPatched) return cv;
    cv.__dshPatched = true;
    if (!cv.style) {
      try { cv.style = {}; } catch (e) { /* ignore */ }
    }
    if (!cv.tagName) safeSet(cv, 'tagName', 'CANVAS');
    if (!cv.nodeName) safeSet(cv, 'nodeName', 'CANVAS');

    var origGetContext = cv.getContext ? cv.getContext.bind(cv) : null;
    function patch2DContext(ctx) {
      if (!ctx || ctx.__dsh2dPatched) return ctx;
      ctx.__dsh2dPatched = true;
      if (typeof ctx.roundRect !== 'function') {
        ctx.roundRect = function (rx, ry, rw, rh, radii) {
          var rr = Array.isArray(radii) ? Number(radii[0] || 0) : Number(radii || 0);
          var r = Math.max(0, Math.min(rr, Math.abs(rw) * 0.5, Math.abs(rh) * 0.5));
          ctx.moveTo(rx + r, ry);
          ctx.lineTo(rx + rw - r, ry);
          ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
          ctx.lineTo(rx + rw, ry + rh - r);
          ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
          ctx.lineTo(rx + r, ry + rh);
          ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
          ctx.lineTo(rx, ry + r);
          ctx.quadraticCurveTo(rx, ry, rx + r, ry);
          ctx.closePath();
        };
      }
      if (typeof ctx.ellipse !== 'function') {
        ctx.ellipse = function (cx, cy, rx, ry, rot, startA, endA, ccw) {
          ctx.save();
          ctx.translate(cx, cy);
          if (rot) ctx.rotate(rot);
          ctx.scale(rx || 1, ry || 1);
          ctx.arc(0, 0, 1, startA || 0, endA === undefined ? Math.PI * 2 : endA, !!ccw);
          ctx.restore();
        };
      }
      return ctx;
    }
    if (origGetContext) {
      safeSet(cv, 'getContext', function (ctxType, attrs) {
        if (ctxType === '2d') {
          return patch2DContext(origGetContext('2d', attrs));
        }
        if (ctxType === 'webgl2') {
          if (cv.__dshWebGL2Ctx) return cv.__dshWebGL2Ctx;
          var gl2 = null;
          try { gl2 = origGetContext('webgl2', attrs); } catch (e) { gl2 = null; }
          if (!gl2 || typeof gl2.createVertexArray !== 'function') {
            var merged = {};
            if (attrs && typeof attrs === 'object') {
              for (var k in attrs) merged[k] = attrs[k];
            }
            merged.version = 2;
            try { gl2 = origGetContext('webgl', merged); } catch (e2) { gl2 = null; }
          }
          if (!gl2 || typeof gl2.createVertexArray !== 'function') {
            try {
              gl2 = origGetContext('webgl2', { alpha: false, depth: true, stencil: false, antialias: true });
            } catch (e3) { gl2 = null; }
          }
          if (!gl2 || typeof gl2.createVertexArray !== 'function') {
            try {
              gl2 = origGetContext('webgl', { alpha: false, depth: true, stencil: false, antialias: true, version: 2 });
            } catch (e4) { gl2 = null; }
          }
          if (gl2 && typeof gl2.createVertexArray === 'function') {
            cv.__dshWebGL2Ctx = gl2;
            return gl2;
          }
          return null;
        }
        return origGetContext(ctxType, attrs);
      });
    }

    safeSet(cv, 'getBoundingClientRect', function () {
      var w = isScreen ? (win.innerWidth || metrics.w) : (cv.width || 0);
      var h = isScreen ? (win.innerHeight || metrics.h) : (cv.height || 0);
      return { left: 0, top: 0, right: w, bottom: h, x: 0, y: 0, width: w, height: h };
    });
    safeSet(cv, 'focus', function () {});
    safeSet(cv, 'blur', function () {});
    safeSet(cv, 'setAttribute', function () {});
    safeSet(cv, 'removeAttribute', function () {});
    safeSet(cv, 'setPointerCapture', function () {});
    safeSet(cv, 'releasePointerCapture', function () {});

    // Isolate screenCanvas listeners from Simulator Electron DOM so touch/pointer events never double-fire.
    safeSet(cv, 'addEventListener', function (type, fn) {
      if (isScreen) addRegListener(canvasListeners, type, fn);
    });
    safeSet(cv, 'removeEventListener', function (type, fn) {
      if (isScreen) removeRegListener(canvasListeners, type, fn);
    });
    safeSet(cv, 'dispatchEvent', function (ev) {
      if (isScreen && ev && ev.type) emitReg(canvasListeners, ev.type, ev);
      return true;
    });

    if (isScreen) {
      try {
        Object.defineProperty(cv, 'clientWidth', { get: function () { return win.innerWidth || metrics.w; }, configurable: true });
        Object.defineProperty(cv, 'clientHeight', { get: function () { return win.innerHeight || metrics.h; }, configurable: true });
      } catch (e) { /* ignore */ }
    }
    return cv;
  }

  var screenCanvas = patchCanvas(wx.createCanvas(), true);
  safeSet(root, '__screenCanvas', screenCanvas);
  safeSet(root, 'canvas', screenCanvas);
  safeSet(win, '__screenCanvas', screenCanvas);
  safeSet(win, 'canvas', screenCanvas);

  var NativeImage = (typeof win.Image === 'function') ? win.Image : null;
  var inCreateWxImage = false;

  function createWxImage() {
    if (inCreateWxImage && NativeImage) return new NativeImage();
    inCreateWxImage = true;
    var img;
    try {
      img = wx.createImage();
    } finally {
      inCreateWxImage = false;
    }
    if (!img || img.__dshImgPatched) return img;
    img.__dshImgPatched = true;
    var extraLoad = [];
    var extraErr = [];
    var userOnload = null;
    var userOnerror = null;
    var nativeOnloadSet = false;
    var settled = false;

    function fireLoad(ev) {
      settled = true;
      try { img.complete = true; } catch (e) { /* ignore */ }
      try {
        if (!img.naturalWidth && img.width) img.naturalWidth = img.width;
        if (!img.naturalHeight && img.height) img.naturalHeight = img.height;
      } catch (e2) { /* ignore */ }
      if (typeof userOnload === 'function') userOnload.call(img, ev);
      var copy = extraLoad.slice();
      for (var i = 0; i < copy.length; i++) copy[i].call(img, ev);
    }
    function fireErr(ev) {
      settled = true;
      if (typeof userOnerror === 'function') userOnerror.call(img, ev);
      var copy = extraErr.slice();
      for (var i = 0; i < copy.length; i++) copy[i].call(img, ev);
    }

    var descLoad = Object.getOwnPropertyDescriptor(img, 'onload') ||
                   Object.getOwnPropertyDescriptor(Object.getPrototypeOf(img) || {}, 'onload');
    var descErr  = Object.getOwnPropertyDescriptor(img, 'onerror') ||
                   Object.getOwnPropertyDescriptor(Object.getPrototypeOf(img) || {}, 'onerror');

    if (descLoad && typeof descLoad.set === 'function') {
      descLoad.set.call(img, fireLoad);
      if (descErr && typeof descErr.set === 'function') descErr.set.call(img, fireErr);
      nativeOnloadSet = true;
      try {
        Object.defineProperty(img, 'onload', {
          configurable: true,
          get: function () { return userOnload; },
          set: function (fn) { userOnload = fn; }
        });
        Object.defineProperty(img, 'onerror', {
          configurable: true,
          get: function () { return userOnerror; },
          set: function (fn) { userOnerror = fn; }
        });
      } catch (e) {
        nativeOnloadSet = false;
      }
    }

    img.addEventListener = function (type, fn) {
      if (typeof fn !== 'function') return;
      if (type === 'load') {
        if (nativeOnloadSet) {
          extraLoad.push(fn);
        } else {
          var prev = img.onload;
          img.onload = function (ev) {
            settled = true;
            try { img.complete = true; } catch (e) { /* ignore */ }
            if (typeof prev === 'function') prev.call(img, ev);
            fn.call(img, ev);
          };
        }
      } else if (type === 'error') {
        if (nativeOnloadSet) {
          extraErr.push(fn);
        } else {
          var prevE = img.onerror;
          img.onerror = function (ev) {
            settled = true;
            if (typeof prevE === 'function') prevE.call(img, ev);
            fn.call(img, ev);
          };
        }
      }
    };
    img.removeEventListener = function (type, fn) {
      var arr = type === 'load' ? extraLoad : (type === 'error' ? extraErr : null);
      if (!arr) return;
      var idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    };
    if (typeof img.decode !== 'function') {
      img.decode = function () {
        if (settled || img.complete) return Promise.resolve();
        return new Promise(function (resolve, reject) {
          img.addEventListener('load', function () { resolve(); });
          img.addEventListener('error', function (e) { reject(e || new Error('image decode failed')); });
        });
      };
    }
    return img;
  }

  var WxImageCtor = function () { return createWxImage(); };
  safeSet(win, 'Image', WxImageCtor);
  safeSet(root, 'Image', WxImageCtor);
  if (screenCanvas && screenCanvas.constructor && screenCanvas.constructor !== Object) {
    safeSet(win, 'HTMLCanvasElement', screenCanvas.constructor);
    safeSet(root, 'HTMLCanvasElement', screenCanvas.constructor);
  }

  function createElementShim(origCreate, tag) {
    var t = String(tag || '').toLowerCase();
    if (t === 'canvas') return patchCanvas(wx.createCanvas(), false);
    if (t === 'img' || t === 'image') return createWxImage();
    if (origCreate) {
      try { return origCreate(tag); } catch (e) { /* fallback stub */ }
    }
    return {
      tagName: t.toUpperCase(),
      style: {},
      textContent: '',
      innerHTML: '',
      setAttribute: function () {},
      removeAttribute: function () {},
      addEventListener: function () {},
      removeEventListener: function () {},
      appendChild: function (ch) { return ch; },
      removeChild: function (ch) { return ch; },
      getContext: function () { return null; }
    };
  }

  var doc = win.document || root.document;
  if (!doc) {
    doc = {
      hidden: false,
      visibilityState: 'visible',
      documentElement: { style: {}, appendChild: function (ch) { return ch; }, removeChild: function (ch) { return ch; } },
      head: { appendChild: function (ch) { return ch; }, removeChild: function (ch) { return ch; } },
      body: { style: {}, appendChild: function (ch) { return ch; }, removeChild: function (ch) { return ch; } },
      getElementById: function (id) {
        return (id === 'game' || !id) ? screenCanvas : null;
      },
      createElement: function (tag) { return createElementShim(null, tag); },
      createElementNS: function (_ns, tag) { return createElementShim(null, tag); },
      addEventListener: function (type, fn) { addRegListener(docListeners, type, fn); },
      removeEventListener: function (type, fn) { removeRegListener(docListeners, type, fn); },
      dispatchEvent: function (ev) { if (ev && ev.type) emitReg(docListeners, ev.type, ev); return true; }
    };
    safeSet(win, 'document', doc);
    safeSet(root, 'document', doc);
  } else {
    var origById = doc.getElementById ? doc.getElementById.bind(doc) : null;
    var origCreate = doc.createElement ? doc.createElement.bind(doc) : null;
    var origCreateNS = doc.createElementNS ? doc.createElementNS.bind(doc) : null;
    safeSet(doc, 'getElementById', function (id) {
      if (id === 'game') return screenCanvas;
      return origById ? origById(id) : null;
    });
    safeSet(doc, 'createElement', function (tag) { return createElementShim(origCreate, tag); });
    safeSet(doc, 'createElementNS', function (ns, tag) {
      var t = String(tag || '').toLowerCase();
      if (t === 'canvas' || t === 'img' || t === 'image') return createElementShim(null, t);
      return origCreateNS ? origCreateNS(ns, tag) : createElementShim(origCreate, tag);
    });
    safeSet(doc, 'addEventListener', function (type, fn) { addRegListener(docListeners, type, fn); });
    safeSet(doc, 'removeEventListener', function (type, fn) { removeRegListener(docListeners, type, fn); });
  }

  var origWinAdd = (win.addEventListener && win.addEventListener !== addWinEvent) ? win.addEventListener.bind(win) : null;
  var origWinRem = (win.removeEventListener && win.removeEventListener !== remWinEvent) ? win.removeEventListener.bind(win) : null;
  function addWinEvent(type, fn, opts) {
    addRegListener(winListeners, type, fn);
    if (origWinAdd && (type === 'error' || type === 'unhandledrejection')) {
      try { origWinAdd(type, fn, opts); } catch (e) { /* ignore */ }
    }
  }
  function remWinEvent(type, fn, opts) {
    removeRegListener(winListeners, type, fn);
    if (origWinRem && (type === 'error' || type === 'unhandledrejection')) {
      try { origWinRem(type, fn, opts); } catch (e) { /* ignore */ }
    }
  }
  safeSet(win, 'addEventListener', addWinEvent);
  safeSet(win, 'removeEventListener', remWinEvent);
  if (root !== win) {
    safeSet(root, 'addEventListener', addWinEvent);
    safeSet(root, 'removeEventListener', remWinEvent);
  }

  function normalizeTouches(list) {
    if (!list || !list.length) return [];
    var out = new Array(list.length);
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var x = t.clientX !== undefined ? t.clientX : (t.pageX !== undefined ? t.pageX : t.x);
      var y = t.clientY !== undefined ? t.clientY : (t.pageY !== undefined ? t.pageY : t.y);
      out[i] = {
        identifier: t.identifier !== undefined ? t.identifier : i,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
        target: screenCanvas
      };
    }
    return out;
  }

  function usesTouchEvents() {
    return hasRegListener(canvasListeners, 'touchstart') ||
           hasRegListener(docListeners, 'touchstart') ||
           hasRegListener(winListeners, 'touchstart');
  }

  function dispatchTouchAndPointer(touchType, pointerType, raw, isUp) {
    var touches = normalizeTouches(raw && raw.touches);
    var changed = normalizeTouches(raw && raw.changedTouches);
    if (!changed.length && touches.length) changed = touches;
    var stamp = (raw && raw.timeStamp) || win.performance.now();

    if (usesTouchEvents()) {
      var tev = {
        type: touchType,
        target: screenCanvas,
        currentTarget: screenCanvas,
        touches: touches,
        targetTouches: touches,
        changedTouches: changed,
        timeStamp: stamp,
        defaultPrevented: false,
        preventDefault: function () { this.defaultPrevented = true; },
        stopPropagation: function () {}
      };
      emitReg(canvasListeners, touchType, tev);
      emitReg(docListeners, touchType, tev);
      emitReg(winListeners, touchType, tev);
      return;
    }

    for (var i = 0; i < changed.length; i++) {
      var pt = changed[i];
      var stopped = false;
      var pev = {
        type: pointerType,
        pointerId: pt.identifier,
        pointerType: 'touch',
        isPrimary: i === 0,
        clientX: pt.clientX,
        clientY: pt.clientY,
        pageX: pt.pageX,
        pageY: pt.pageY,
        button: 0,
        buttons: isUp ? 0 : 1,
        width: 20,
        height: 20,
        pressure: isUp ? 0 : 0.5,
        target: screenCanvas,
        currentTarget: screenCanvas,
        timeStamp: stamp,
        defaultPrevented: false,
        preventDefault: function () { this.defaultPrevented = true; },
        stopPropagation: function () { stopped = true; }
      };
      emitReg(canvasListeners, pointerType, pev);
      if (!stopped) emitReg(docListeners, pointerType, pev);
      if (!stopped) emitReg(winListeners, pointerType, pev);
    }
  }

  if (typeof wx.onTouchStart === 'function') {
    wx.onTouchStart(function (res) { dispatchTouchAndPointer('touchstart', 'pointerdown', res, false); });
  }
  if (typeof wx.onTouchMove === 'function') {
    wx.onTouchMove(function (res) { dispatchTouchAndPointer('touchmove', 'pointermove', res, false); });
  }
  if (typeof wx.onTouchEnd === 'function') {
    wx.onTouchEnd(function (res) { dispatchTouchAndPointer('touchend', 'pointerup', res, true); });
  }
  if (typeof wx.onTouchCancel === 'function') {
    wx.onTouchCancel(function (res) { dispatchTouchAndPointer('touchcancel', 'pointercancel', res, true); });
  }

  if (typeof wx.onWindowResize === 'function') {
    wx.onWindowResize(function (res) {
      var next = readWinMetrics();
      var w = (res && res.windowWidth) || next.w;
      var h = (res && res.windowHeight) || next.h;
      safeSet(win, 'innerWidth', w);
      safeSet(win, 'innerHeight', h);
      safeSet(win, '__wxSafeArea', next.safeArea);
      if (root !== win) {
        safeSet(root, 'innerWidth', w);
        safeSet(root, 'innerHeight', h);
        safeSet(root, '__wxSafeArea', next.safeArea);
      }
      emitReg(winListeners, 'resize', { type: 'resize', target: win });
    });
  }
  if (typeof wx.onHide === 'function') {
    wx.onHide(function () {
      safeSet(doc, 'hidden', true);
      safeSet(doc, 'visibilityState', 'hidden');
      emitReg(docListeners, 'visibilitychange', { type: 'visibilitychange' });
      emitReg(winListeners, 'blur', { type: 'blur', target: win });
    });
  }
  if (typeof wx.onShow === 'function') {
    wx.onShow(function () {
      safeSet(doc, 'hidden', false);
      safeSet(doc, 'visibilityState', 'visible');
      emitReg(docListeners, 'visibilitychange', { type: 'visibilitychange' });
    });
  }
  if (typeof wx.onError === 'function') {
    wx.onError(function (err) {
      var msg = (typeof err === 'string') ? err : (err && err.message) || 'wx error';
      emitReg(winListeners, 'error', { type: 'error', message: msg, error: err });
    });
  }
})();
`
}

function renderWxConfigSource(opts: { title: string; shareTitle: string; adUnitId: string; shareImageUrl: string }): string {
  return `/**
 * WeChat Mini Game Operations & Zero-Interstitial IAA Monetization Config
 * Generated by @zseven-w/dsh-game-studio for《${opts.title}》
 *
 * Pre-100 UV (Review & Launch Phase):
 *   Keep adUnitIds.default = '' and noAdFallbackMode = 'free'.
 *   All voluntary reward buttons grant "首发限免" rewards cleanly with zero broken-ad popups.
 *
 * Post-100 UV (Traffic Host Enabled):
 *   Create a 6-15s Rewarded Video Ad in mp.weixin.qq.com -> 流量主 -> 广告管理,
 *   and paste its adunit-xxxxxxxxxxxxxxxx into adUnitIds.default below.
 */
module.exports = {
  adUnitIds: {
    default: ${JSON.stringify(opts.adUnitId)},
    revive: '',
    powerup: '',
    doubleCoins: '',
    unlockTheme: ''
  },
  // 'free' = instant free reward when adUnitId is empty (recommended for WeChat review)
  noAdFallbackMode: 'free',
  shareTitle: ${JSON.stringify(opts.shareTitle)},
  shareImageUrl: ${JSON.stringify(opts.shareImageUrl)},
  showBootSplash: true
};
`
}

function renderEntryGameJs(opts: { usesThree: boolean; defaultShareTitle: string; defaultShareImage: string }): string {
  return `/**
 * WeChat Mini Game Entry Point — generated by @zseven-w/dsh-game-studio
 */
var root = (typeof GameGlobal !== 'undefined') ? GameGlobal : ((typeof window !== 'undefined') ? window : globalThis);
var win = root.window || root;

var __bootModalShown = false;
function __showBootError(prefix, err) {
  var msg = prefix + ': ' + ((err && err.message) || err || 'unknown');
  try { console.error('[wx-game-boot]', err); } catch (e) { /* ignore */ }
  if (!__bootModalShown && typeof wx !== 'undefined' && wx && typeof wx.showModal === 'function') {
    __bootModalShown = true;
    try {
      wx.showModal({ title: '启动异常诊断', content: String(msg).slice(0, 300), showCancel: false });
    } catch (e2) { /* ignore */ }
  }
}

if (typeof wx !== 'undefined' && wx && typeof wx.onError === 'function') {
  wx.onError(function (err) {
    if (!win.__dshWxBootOk) __showBootError('运行时异常', err);
  });
}

try {
  require('./weapp-adapter.js');
  win = root.window || root;
${opts.usesThree ? "  require('./js/three.js');\n" : ''}  require('./js/game-assets.js');

  var wxConfig = require('./wx-config.js') || {};
  win.GAME = win.GAME || {};
  win.GAME.isWeChatMiniGame = true;
  win.GAME.wxConfig = wxConfig;
  win.GAME.adUnitIds = wxConfig.adUnitIds || {};
  win.GAME.safeArea = win.__wxSafeArea || null;

  // Singleton RewardedVideoAd helper (zero-interstitial IAA; auto-free before 100 UV)
  var __rewardAds = {};
  var __activeAdClose = null;
  var __activeAdError = null;
  win.GAME.watchRewardedAd = function (slotOrCb, maybeCb) {
    var slot = typeof slotOrCb === 'string' ? slotOrCb : 'default';
    var onReward = typeof slotOrCb === 'function' ? slotOrCb : maybeCb;
    var ids = wxConfig.adUnitIds || {};
    var unitId = (ids[slot] && String(ids[slot]).trim()) || (ids.default && String(ids.default).trim()) || '';
    if (!unitId || typeof wx === 'undefined' || typeof wx.createRewardedVideoAd !== 'function') {
      if ((wxConfig.noAdFallbackMode || 'free') === 'free') {
        if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
          try { wx.showToast({ title: '首发限免已发放', icon: 'none', duration: 1200 }); } catch (_e) {}
        }
        if (typeof onReward === 'function') onReward({ mode: 'free', slot: slot });
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    }
    var ad = __rewardAds[unitId];
    if (!ad) {
      ad = wx.createRewardedVideoAd({ adUnitId: unitId });
      __rewardAds[unitId] = ad;
    }
    if (__activeAdClose && typeof ad.offClose === 'function') ad.offClose(__activeAdClose);
    if (__activeAdError && typeof ad.offError === 'function') ad.offError(__activeAdError);

    return new Promise(function (resolve) {
      var settled = false;
      __activeAdClose = function (res) {
        if (settled) return;
        settled = true;
        if (!res || res.isEnded) {
          if (typeof onReward === 'function') onReward({ mode: 'ad', slot: slot });
          resolve(true);
        } else {
          resolve(false);
        }
      };
      __activeAdError = function () {
        if (settled) return;
        settled = true;
        if (typeof wx.showToast === 'function') {
          try { wx.showToast({ title: '广告暂未就绪，本次直接发放', icon: 'none', duration: 1400 }); } catch (_e) {}
        }
        if (typeof onReward === 'function') onReward({ mode: 'fallback', slot: slot });
        resolve(true);
      };
      ad.onClose(__activeAdClose);
      ad.onError(__activeAdError);
      ad.show().catch(function () {
        ad.load().then(function () { return ad.show(); }).catch(__activeAdError);
      });
    });
  };
  root.GAME = win.GAME;

  if (typeof wx !== 'undefined' && wx) {
    try {
      if (typeof wx.showShareMenu === 'function') {
        wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
      }
      var buildSharePayload = function () {
        var payload = {
          title: wxConfig.shareTitle || ${JSON.stringify(opts.defaultShareTitle)},
          imageUrl: wxConfig.shareImageUrl || ${JSON.stringify(opts.defaultShareImage)}
        };
        try {
          if (typeof win.__wxSharePayload === 'function') {
            var custom = win.__wxSharePayload();
            if (custom && typeof custom === 'object') {
              if (custom.title) payload.title = String(custom.title);
              if (custom.imageUrl) payload.imageUrl = String(custom.imageUrl);
            }
          }
        } catch (_e) {}
        return payload;
      };
      if (typeof wx.onShareAppMessage === 'function') wx.onShareAppMessage(buildSharePayload);
      if (typeof wx.onShareTimeline === 'function') wx.onShareTimeline(buildSharePayload);
    } catch (_e2) {}
  }

  require('./js/core-game.js');
  win.__dshWxBootOk = true;
} catch (bootErr) {
  __showBootError('初始化失败', bootErr);
}
`
}

function renderSubmissionDraft(manifest: GameManifest, appid: string): string {
  const title = manifest.title
  const orientationZh = manifest.orientation === 'landscape' ? '横屏' : '竖屏'
  return `# 《${title}》微信小游戏提审与资质审核材料草案

> 由 \`@zseven-w/dsh-game-studio\` 自动生成。提交至 \`mp.weixin.qq.com\` 前请对照游戏内实际文案做最终核对。

## 一、基础信息核对
- **游戏名称**：\`${title}\`（须保证后台注册名、软著/自审报告、启动页及主界面标题**一字不差**，纯简体中文）
- **AppID**：\`${appid}\`
- **屏幕方向**：${orientationZh}（\`game.json\` -> \`deviceOrientation: "${manifest.orientation ?? 'portrait'}"\`）
- **服务类目**：\`游戏 > 休闲游戏\`
- **网络连接**：选择 **\`单机游戏\`**（本地构建不采集手机号、相册或定位权限）

## 二、小程序介绍与版本更新说明（可直接复制）
- **小程序介绍（<=120字）**：
  > 《${title}》是一款轻松上手的原创${orientationZh}休闲小游戏。点按滑动即可随时开局，单局节奏明快，适合碎片时间放松体验。
- **版本更新说明（提交审核用，勿写 git 日志或英文术语）**：
  > 1.《${title}》首个正式版本，提供完整核心关卡与流畅触控操作体验；
  > 2. 优化右上角微信胶囊安全区排版与多机型屏幕适配；
  > 3. 完善音效震动设置开关与健康游戏忠告提示。

## 三、微信「资质审核」五大系统功能说明模板
1. **货币系统**：游戏内仅设局内闯关/结算产出的虚拟积分或代币，仅可通过正常游玩关卡与每日签到免费获取，不支持任何人民币充值购买或反向兑换。
2. **道具系统**：游戏内辅助道具仅用于单局解围或增益，均通过局内游玩产出或免费获取，无现金付费道具。
3. **设置系统**：支持玩家随时独立开启或关闭背景音乐、操作音效与触感震动反馈，并提供重新开始与返回主界面入口。
4. **商城/工坊系统**（*请将名称改为游戏内实际入口名*）：仅消耗游玩免费产出的虚拟代币解锁外观/图鉴。若含随机抽取机制，须在界面与本说明中明确公示各品质抽取概率，且声明未开通任何现金充值入口。
5. **自定义系统**：纯本地单机闯关玩法，无玩家自由输入昵称签名、无公屏聊天、无自定义图片上传等 UGC 内容。

## 四、关键截图避坑清单（实测必查）
- **图 01（启动页适龄提示）**：**必须截取微信原生启动页自带的官方绿色 \`CADPA 8+ / 12+\` 适龄角标**，严禁在 Canvas 内自绘非标准绿色适龄胶囊（会被判定样式不规范打回）。
- **右上角胶囊避让**：所有右上角分数、计时器、设置按钮顶部须低于 \`y = 88px\`（竖屏），运行 \`game_studio_playtest({ path, platform: "wechat" })\` 可直接预览胶囊叠层截图。
- **无死链广告按钮**：流量主满 100 UV 开通前，保持 \`wx-config.js\` 中 \`adUnitIds.default: ""\` 与 \`noAdFallbackMode: "free"\`，杜绝“广告加载失败”弹窗导致审核驳回。
`
}

export async function exportWechatProject(dir: string, options: ExportWechatOptions = {}): Promise<WechatExportResult> {
  const manifest = await loadManifest(dir)
  const ledger = await loadLedger(dir)
  const build = await buildProject(dir, 'Exported WeChat Mini Game')
  await writeState(dir, build)

  const outDir = options.outDir ?? join(dir, 'wx-minigame')
  const wxJsDir = join(outDir, 'js')
  const wxImgDir = join(outDir, 'images')
  await mkdir(wxJsDir, { recursive: true })
  await mkdir(wxImgDir, { recursive: true })

  // Preserve existing AppID from project.config.json unless caller passed one.
  const projectCfgPath = join(outDir, 'project.config.json')
  let existingCfg: Record<string, any> | undefined
  if (await fileExists(projectCfgPath)) {
    existingCfg = await readJson<Record<string, any>>(projectCfgPath).catch(() => undefined)
  }
  const appid = validateAppId(
    options.appid
      ?? (typeof existingCfg?.appid === 'string' && existingCfg.appid.trim() ? existingCfg.appid : 'touristappid'),
  )

  const prevStudioManifestPath = join(outDir, STUDIO_WX_MANIFEST)
  const prevStudio = await readJson<StudioWxManifest>(prevStudioManifestPath).catch(
    (): StudioWxManifest => ({ schema: 1, managedImages: [], managedAudio: [] }),
  )

  const usesThree = (manifest.runtime ?? []).includes('three')
  const wxSlots: Record<string, { tile: boolean; custom: boolean }> = {}
  const wxAssets: Record<string, string> = {}
  const svgQueue: Array<{ slot: string; spec: SlotSpec; svgData: Buffer }> = []
  const nextManagedImages = new Set<string>()
  const warnings: string[] = []

  for (const [slot, spec] of Object.entries(manifest.slots)) {
    const entry = ledger.assets[slot]
    const isCustom = entry !== undefined && entry.source !== 'template'
    wxSlots[slot] = { tile: spec.tile === true, custom: isCustom }

    // 3D Three.js templates draw non-custom slots procedurally in code; omitting unused template SVGs keeps package lean.
    // 2D Canvas games draw slot images directly, so every slot is exported.
    const shouldExportImage = usesThree ? isCustom : true
    if (!shouldExportImage) continue

    const srcFile = join(dir, spec.file)
    let raw: Buffer
    try { raw = await readFile(srcFile) }
    catch { throw new StudioError(`Asset for slot "${slot}" is missing: ${spec.file}`, 'MISSING_ASSET') }

    const ext = extname(spec.file).toLowerCase()
    if (ext === '.svg' && options.rasterizeSvg !== false) {
      svgQueue.push({ slot, spec, svgData: raw })
    } else {
      mimeOf(spec.file) // validate extension
      const fileName = `${slot}${ext}`
      await writeFileAtomic(join(wxImgDir, fileName), raw)
      wxAssets[slot] = `images/${fileName}`
      nextManagedImages.add(fileName)
    }
  }

  if (svgQueue.length > 0) {
    const { pngs, fallbackReason } = await rasterizeSvgsToPng(
      svgQueue.map(item => ({ slot: item.slot, svgData: item.svgData, size: item.spec.size })),
      options.signal,
    )
    for (const item of svgQueue) {
      const png = pngs.get(item.slot)
      if (png) {
        const fileName = `${item.slot}.png`
        await writeFileAtomic(join(wxImgDir, fileName), png)
        wxAssets[item.slot] = `images/${fileName}`
        nextManagedImages.add(fileName)
      } else {
        const fileName = `${item.slot}.svg`
        await writeFileAtomic(join(wxImgDir, fileName), item.svgData)
        wxAssets[item.slot] = `images/${fileName}`
        nextManagedImages.add(fileName)
      }
    }
    if (pngs.size < svgQueue.length && fallbackReason) {
      warnings.push(`Could not rasterize SVG slots to PNG (${fallbackReason}); copied raw .svg files as fallback.`)
    }
  }

  // Clean up previously studio-managed slot images that are no longer part of this game; keep user files (e.g. share-cover.png).
  for (const oldImg of prevStudio.managedImages) {
    if (!nextManagedImages.has(oldImg)) {
      await rm(join(wxImgDir, oldImg), { force: true }).catch(() => {})
    }
  }

  // Provide a default share cover from playtest cover.jpg if the user hasn't placed share-cover.png/jpg yet.
  let defaultShareImage = 'images/share-cover.png'
  if (await fileExists(join(wxImgDir, 'share-cover.png'))) {
    defaultShareImage = 'images/share-cover.png'
  } else if (await fileExists(join(wxImgDir, 'share-cover.jpg'))) {
    defaultShareImage = 'images/share-cover.jpg'
  } else if (await fileExists(paths.cover(dir))) {
    await copyFile(paths.cover(dir), join(wxImgDir, 'share-cover.jpg'))
    defaultShareImage = 'images/share-cover.jpg'
  }

  // Optional BGM tracks (`assets/bgm-tracks.json` or `assets/bgm.mp3`)
  const bgmCfgPath = join(dir, 'assets', 'bgm-tracks.json')
  let bgmSpecs: BgmTrackSpec[] = []
  if (await fileExists(bgmCfgPath)) {
    const parsed = await readJson<unknown>(bgmCfgPath).catch(() => null)
    if (Array.isArray(parsed)) {
      bgmSpecs = parsed.filter((t): t is BgmTrackSpec => Boolean(t && typeof t === 'object' && typeof (t as BgmTrackSpec).file === 'string'))
    }
  } else if (await fileExists(join(dir, 'assets', 'bgm.mp3'))) {
    bgmSpecs = [{ id: 'default', name: `${manifest.title}原声`, file: 'bgm.mp3' }]
  }

  const wxAudioDir = join(outDir, 'audio')
  const wxBgmTracks: Array<{ id: string; name: string; sub: string; src: string }> = []
  const nextManagedAudio = new Set<string>()
  for (const spec of bgmSpecs) {
    const baseName = basename(spec.file)
    const srcMp3 = join(dir, 'assets', baseName)
    if (!(await fileExists(srcMp3))) continue
    await mkdir(wxAudioDir, { recursive: true })
    await copyFile(srcMp3, join(wxAudioDir, baseName))
    nextManagedAudio.add(baseName)
    wxBgmTracks.push({
      id: String(spec.id ?? baseName),
      name: String(spec.name ?? '原创配乐'),
      sub: String(spec.sub ?? ''),
      src: `audio/${baseName}`,
    })
  }
  for (const oldAudio of prevStudio.managedAudio) {
    if (!nextManagedAudio.has(oldAudio)) {
      await rm(join(wxAudioDir, oldAudio), { force: true }).catch(() => {})
    }
  }
  if (wxBgmTracks.length > 0) {
    wxAssets.bgm = wxBgmTracks[0]!.src
  }

  // Runtime scripts (Three.js)
  const threeOutPath = join(wxJsDir, 'three.js')
  if (usesThree) {
    const threeSrc = await readRuntimeScript('three')
    await writeFileAtomic(threeOutPath, `${WX_SANDBOX_PREAMBLE}${threeSrc}\n__wxRoot.THREE = window.THREE;\n`)
  } else if (await fileExists(threeOutPath)) {
    await rm(threeOutPath, { force: true }).catch(() => {})
  }

  // Write js/game-assets.js
  const gamePayload: Record<string, unknown> = {
    title: manifest.title,
    rules: manifest.rules,
    ...(wxBgmTracks.length > 0 ? { bgmTitle: wxBgmTracks[0]!.name, bgmTracks: wxBgmTracks } : {}),
    slots: wxSlots,
    assets: wxAssets,
  }
  const gameAssetsJs = [
    WX_SANDBOX_PREAMBLE,
    `window.GAME = Object.assign(window.GAME || {}, ${JSON.stringify(gamePayload, null, 2)});`,
    '__wxRoot.GAME = window.GAME;',
    '',
  ].join('\n')
  await writeFileAtomic(join(wxJsDir, 'game-assets.js'), gameAssetsJs)

  // Write js/core-game.js from single-source game.js
  const coreGameSrc = await readFile(paths.code(dir), 'utf8')
  const wxCoreGameJs = `${WX_SANDBOX_PREAMBLE}${usesThree ? 'var THREE = __wxRoot.THREE || window.THREE;\n' : ''}${coreGameSrc}\n`
  await writeFileAtomic(join(wxJsDir, 'core-game.js'), wxCoreGameJs)

  // Write universal weapp-adapter.js and entry game.js
  await writeFileAtomic(join(outDir, 'weapp-adapter.js'), renderWeappAdapterSource())
  const defaultShareTitle = `快来玩《${manifest.title}》，看你能拿多少分！`
  await writeFileAtomic(
    join(outDir, 'game.js'),
    renderEntryGameJs({ usesThree, defaultShareTitle, defaultShareImage }),
  )

  // Write wx-config.js (preserve developer edits unless overwriteConfig or missing)
  const wxConfigPath = join(outDir, 'wx-config.js')
  if (options.overwriteConfig === true || !(await fileExists(wxConfigPath))) {
    await writeFileAtomic(
      wxConfigPath,
      renderWxConfigSource({
        title: manifest.title,
        shareTitle: options.shareTitle ?? defaultShareTitle,
        adUnitId: options.adUnitId ?? '',
        shareImageUrl: defaultShareImage,
      }),
    )
  }

  // Write WeChat game.json & project.config.json
  const orientation = manifest.orientation === 'landscape' ? 'landscape' : 'portrait'
  await writeJson(join(outDir, 'game.json'), {
    deviceOrientation: orientation,
    showStatusBar: false,
  })

  const projectConfig = {
    description: `${manifest.title} — WeChat Mini Game exported by dsh-game-studio`,
    setting: {
      urlCheck: true,
      es6: false,
      enhance: false,
      minified: true,
      uglifyFileName: false,
      enhanceWithBabel: false,
      ...(existingCfg?.setting && typeof existingCfg.setting === 'object' ? existingCfg.setting : {}),
    },
    compileType: 'game',
    libVersion: typeof existingCfg?.libVersion === 'string' ? existingCfg.libVersion : '3.5.8',
    appid,
    projectname: basename(dir),
    condition: {},
    packOptions: {
      ignore: [
        { type: 'file', value: STUDIO_WX_MANIFEST },
        { type: 'file', value: SUBMISSION_DRAFT_FILE },
        { type: 'glob', value: '**/*.md' },
      ],
    },
  }
  await writeJson(projectCfgPath, projectConfig)

  const studioWxManifest: StudioWxManifest = {
    schema: 1,
    managedImages: [...nextManagedImages].sort(),
    managedAudio: [...nextManagedAudio].sort(),
  }
  await writeJson(prevStudioManifestPath, studioWxManifest)

  const draftPath = join(outDir, SUBMISSION_DRAFT_FILE)
  await writeFileAtomic(draftPath, renderSubmissionDraft(manifest, appid))

  warnings.push(...auditGameForWechat(manifest, coreGameSrc, appid))

  const { total: packageBytes, breakdown } = await measureUploadablePackage(outDir)
  const budgetPercent = Math.round((packageBytes / WX_MAIN_PACKAGE_LIMIT_BYTES) * 1000) / 10
  if (packageBytes > WX_MAIN_PACKAGE_LIMIT_BYTES) {
    throw new StudioError(
      `WeChat Mini Game main package is ${(packageBytes / 1048576).toFixed(2)} MB (${packageBytes.toLocaleString()} B), `
      + `exceeding WeChat's 4.00 MB limit (code ${(breakdown.codeBytes / 1024).toFixed(0)} KB, `
      + `images ${(breakdown.imageBytes / 1024).toFixed(0)} KB, audio ${(breakdown.audioBytes / 1024).toFixed(0)} KB). `
      + 'Shrink PNG/MP3 assets or move heavy media to a WeChat subpackage / CDN.',
      'WX_PACKAGE_TOO_LARGE',
    )
  }

  return {
    project: dir,
    outDir,
    appid,
    title: manifest.title,
    orientation,
    buildId: build.buildId,
    packageBytes,
    limitBytes: WX_MAIN_PACKAGE_LIMIT_BYTES,
    budgetPercent,
    breakdown,
    syncedImages: [...nextManagedImages].sort(),
    syncedAudio: [...nextManagedAudio].sort(),
    submissionDraft: draftPath,
    warnings,
  }
}

export function findWechatCli(configuredPath?: string): { bin: string; flavor: 'wechatide' | 'devtools-cli' } | null {
  if (configuredPath) {
    if (!existsSync(configuredPath)) return null
    const lower = basename(configuredPath).toLowerCase()
    return { bin: configuredPath, flavor: lower.includes('wechatide') ? 'wechatide' : 'devtools-cli' }
  }
  const wechatIdePaths = process.platform === 'darwin'
    ? ['/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide']
    : process.platform === 'win32'
      ? [
          'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\wechatide.bat',
          'C:\\Program Files\\Tencent\\微信web开发者工具\\wechatide.bat',
        ]
      : []
  for (const bin of wechatIdePaths) {
    if (existsSync(bin)) return { bin, flavor: 'wechatide' }
  }
  for (const bin of ['wechatide', '/opt/homebrew/bin/wechatide', '/usr/local/bin/wechatide']) {
    const check = spawnSync(bin, ['--help'], { stdio: 'ignore', timeout: 4_000 })
    if (check.status === 0) return { bin, flavor: 'wechatide' }
  }
  const devToolsCandidates = process.platform === 'darwin'
    ? ['/Applications/wechatwebdevtools.app/Contents/MacOS/cli']
    : process.platform === 'win32'
      ? [
          'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
          'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
        ]
      : []
  for (const bin of devToolsCandidates) {
    if (existsSync(bin)) return { bin, flavor: 'devtools-cli' }
  }
  return null
}

export const NO_WECHAT_CLI_HINT = 'Install WeChat DevTools (`https://developers.weixin.qq.com/minigame/dev/devtools/download.html`) '
  + 'and turn on Settings → Security → Service Port, or open the exported `wx-minigame/` folder directly inside WeChat DevTools and click Upload.'

export async function uploadWechatProject(dir: string, options: UploadWechatOptions): Promise<WechatUploadResult> {
  const outDir = options.outDir ?? join(dir, 'wx-minigame')
  const cfgPath = join(outDir, 'project.config.json')
  if (!(await fileExists(cfgPath))) {
    throw new StudioError(
      `No exported WeChat Mini Game found at ${outDir}. Call game_studio_export_wechat first.`,
      'WX_NOT_EXPORTED',
    )
  }

  const version = String(options.version ?? '').trim()
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new StudioError(`version must be a clean semver string such as "1.0.0" (got "${options.version}")`, 'WX_BAD_VERSION')
  }

  const manifest = await loadManifest(dir)
  const cfg = await readJson<Record<string, any>>(cfgPath)
  if (options.appid !== undefined && options.appid.trim() !== '') {
    cfg.appid = validateAppId(options.appid)
    await writeJson(cfgPath, cfg)
  }
  const appid = String(cfg.appid ?? '').trim()
  if (!appid || appid === 'touristappid') {
    throw new StudioError(
      'Cannot upload to WeChat with placeholder AppID "touristappid". Pass your real WeChat Mini Game `appid` (e.g. "wx1234567890abcdef").',
      'WX_BAD_APPID',
    )
  }

  const warnings: string[] = []
  const desc = (options.desc?.trim() || `《${manifest.title}》v${version} 体验优化与玩法更新`).slice(0, 200)
  if (/\b(?:feat|fix|chore|refactor|merge|commit)\s*[:(]/iu.test(desc)) {
    warnings.push('Release description looks like git commit jargon; WeChat reviewers read this field, so prefer player-facing Chinese.')
  }

  const { total: packageBytes } = await measureUploadablePackage(outDir)
  if (packageBytes > WX_MAIN_PACKAGE_LIMIT_BYTES) {
    throw new StudioError(
      `WeChat package is ${(packageBytes / 1048576).toFixed(2)} MB, exceeding the 4.00 MB limit.`,
      'WX_PACKAGE_TOO_LARGE',
    )
  }

  const cliInfo = findWechatCli(options.cliPath)
  if (!cliInfo) {
    throw new StudioError(`WeChat DevTools CLI not found on this computer. ${NO_WECHAT_CLI_HINT}`, 'NO_WECHAT_CLI')
  }

  const cliArgs = cliInfo.flavor === 'wechatide'
    ? (options.confirmToken
        ? ['-c', 'dsh-game-studio', 'polling_task_result', '--task-id', options.confirmToken]
        : [
            '-c', 'dsh-game-studio',
            'upload',
            '--project', outDir,
            '--upload-version', version,
            '--desc', desc,
          ])
    : [
        'upload',
        '--project', outDir,
        '-v', version,
        '-d', desc,
      ]

  const runResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    const child = spawn(cliInfo.bin, cliArgs, {
      cwd: outDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectRun(new StudioError('WeChat CLI upload timed out after 90 seconds.', 'WX_UPLOAD_TIMEOUT'))
    }, 90_000)
    const onAbort = () => {
      clearTimeout(timer)
      child.kill('SIGTERM')
      rejectRun(new StudioError('WeChat CLI upload cancelled.', 'CANCELLED'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', err => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      rejectRun(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolveRun({ code, stdout, stderr })
    })
  })

  const combined = `${runResult.stdout}\n${runResult.stderr}`.trim()
  const tokenMatch = combined.match(/\b(confirmation_upload_[0-9a-zA-Z-]+)\b/u)
  if (tokenMatch && (!options.confirmToken || /\bpending\b|\bwaiting\b|待确认/iu.test(combined))) {
    return {
      project: dir,
      outDir,
      appid,
      version,
      desc,
      cli: cliInfo.bin,
      flavor: cliInfo.flavor,
      status: 'confirmation_required',
      confirmationToken: tokenMatch[1],
      packageBytes,
      warnings,
      output: combined.slice(0, 2_000),
      next: `WeChat DevTools opened a confirmation dialog on this computer: ask the user to click Confirm in WeChat DevTools, then call game_studio_upload_wechat again with confirmToken: "${tokenMatch[1]}".`,
    }
  }

  if (runResult.code !== 0) {
    throw new StudioError(
      `WeChat CLI upload failed (exit ${runResult.code}): ${combined.slice(0, 800) || 'no output'}. `
      + 'Ensure WeChat DevTools is signed in and Settings → Security → Service Port is enabled.',
      'WX_UPLOAD_FAILED',
    )
  }

  return {
    project: dir,
    outDir,
    appid,
    version,
    desc,
    cli: cliInfo.bin,
    flavor: cliInfo.flavor,
    status: 'uploaded',
    packageBytes,
    warnings,
    output: combined.slice(0, 2_000),
    next: 'Open https://mp.weixin.qq.com → 管理 → 版本管理, select this uploaded version as 体验版 to generate the QR code, or click 提交审核.',
  }
}
