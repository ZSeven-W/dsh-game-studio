/* dsh-game-studio — WeChat mini-game runtime adapter (classic script).
 *
 * The exporter inlines this file before the original game.js and then sets
 * window.GAME. It gives the browser-style game a minimal window/document/
 * canvas/Image/localStorage/pointer environment on top of wx.*.
 *
 * Two rendering modes share one on-screen canvas:
 *  - 2D games get the screen canvas's 2D context and draw straight to it.
 *  - three.js games get an offscreen canvas with a WebGL2 context; each frame is
 *    copied onto the screen canvas, which then also draws the HUD. Mini-games
 *    have no DOM and only one on-screen canvas, so this is what makes a DOM HUD
 *    (the voxel template's score, hearts, timer and title card) visible at all.
 */
(function () {
  'use strict';
  if (typeof wx === 'undefined') return;

  var G = typeof GameGlobal !== 'undefined' ? GameGlobal : this;
  var sys = wx.getSystemInfoSync();
  var cssW = Math.max(1, sys.windowWidth || 375);
  var cssH = Math.max(1, sys.windowHeight || 667);
  // Weak phones pay for every extra pixel twice (fill rate and memory). WeChat
  // reports a benchmarkLevel (higher is faster); cap the render scale instead of
  // shipping a game that looks right only on flagship phones.
  var benchmarkLevel = typeof sys.benchmarkLevel === 'number' ? sys.benchmarkLevel : null;
  var quality = benchmarkLevel === null ? 'unknown' : benchmarkLevel >= 30 ? 'high' : benchmarkLevel >= 10 ? 'medium' : 'low';
  var dprCap = quality === 'low' ? 1 : quality === 'medium' ? 1.5 : 2;
  var dpr = Math.min(dprCap, sys.pixelRatio || 1);
  var safeTop = sys.safeArea && typeof sys.safeArea.top === 'number' ? sys.safeArea.top : 0;
  if (quality === 'low' && wx.setPreferredFramesPerSecond) {
    // A steady 30 fps on a weak device feels better than a wobbling 45 and saves battery.
    try { wx.setPreferredFramesPerSecond(30); } catch (error) { /* optional */ }
  }
  var mainCanvas = wx.createCanvas();
  // Boot timing: WeChat reports a high-resolution clock on newer base libraries,
  // and a stopwatch on the first frame is the only startup number that matters.
  function clockNow() {
    try {
      var perf = wx.getPerformance && wx.getPerformance();
      if (perf && typeof perf.now === 'function') return perf.now();
    } catch (error) { /* fall back to Date */ }
    return Date.now();
  }
  var startedAt = clockNow();
  var frames = 0;
  var firstFrameAt = null;
  var frameTimes = [];
  var canvasEvents = {};
  var windowEvents = {};
  var documentEvents = {};
  /** How many nodes the game appended to document.body: a DOM HUD exists. */
  var uiNodes = 0;

  function on(map, type, fn) {
    if (typeof fn !== 'function') return;
    (map[type] || (map[type] = [])).push(fn);
  }
  function off(map, type, fn) {
    var list = map[type];
    if (!list) return;
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  function emit(map, type, event) {
    var list = map[type];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](event); } catch (error) { console.error(error); }
    }
  }

  function decorateCanvas(canvas, isMain) {
    canvas.id = isMain ? 'game' : '';
    canvas.tabIndex = 0;
    // Real browser canvases (used by the mock harness) already own these.
    if (!canvas.style) canvas.style = {};
    if (canvas.clientWidth === undefined) canvas.clientWidth = cssW;
    if (canvas.clientHeight === undefined) canvas.clientHeight = cssH;
    canvas.getBoundingClientRect = function () {
      return { left: 0, top: 0, right: cssW, bottom: cssH, width: cssW, height: cssH };
    };
    canvas.setPointerCapture = function () {};
    canvas.releasePointerCapture = function () {};
    canvas.focus = function () {};
    canvas.addEventListener = function (type, fn) { on(canvasEvents, type, fn); };
    canvas.removeEventListener = function (type, fn) { off(canvasEvents, type, fn); };
    return canvas;
  }

  mainCanvas = decorateCanvas(mainCanvas, true);
  mainCanvas.width = Math.round(cssW * dpr);
  mainCanvas.height = Math.round(cssH * dpr);

  // The screen canvas is always a 2D canvas. It is asked for lazily: taking the
  // 2D context eagerly would be fine here, but keeping it lazy avoids allocating
  // it for games that end up failing before their first frame.
  var mainCtx = null;
  function mainContext() {
    if (!mainCtx) { try { mainCtx = mainCanvas.getContext('2d'); } catch (error) { mainCtx = null; } }
    return mainCtx;
  }

  /** Offscreen canvas three.js renders into; copied onto the screen each frame. */
  var webglCanvas = null;
  var blitFailed = false;

  // What the game sees as document.getElementById('game'): a canvas that hands
  // out either the screen 2D context or an offscreen WebGL2 context.
  var gameCanvas = (function () {
    var mode = null;
    var proxy = {
      id: 'game',
      tabIndex: 0,
      style: {},
      setPointerCapture: function () {},
      releasePointerCapture: function () {},
      focus: function () {},
      getBoundingClientRect: function () {
        return { left: 0, top: 0, right: cssW, bottom: cssH, width: cssW, height: cssH };
      },
      addEventListener: function (type, fn) { on(canvasEvents, type, fn); },
      removeEventListener: function (type, fn) { off(canvasEvents, type, fn); },
      getContext: function (type) {
        var name = String(type || '').toLowerCase();
        if (name === 'webgl2' || name === 'webgl' || name === 'experimental-webgl') {
          if (!webglCanvas) {
            webglCanvas = wx.createCanvas();
            webglCanvas.width = mainCanvas.width;
            webglCanvas.height = mainCanvas.height;
          }
          mode = 'webgl';
          return webglCanvas.getContext(name);
        }
        mode = '2d';
        return mainContext();
      }
    };
    // Width/height describe whichever canvas the context came from, so three's
    // setSize() lands on the offscreen buffer and 2D games resize the screen.
    Object.defineProperty(proxy, 'width', {
      get: function () { return mode === 'webgl' ? webglCanvas.width : mainCanvas.width; },
      set: function (value) { if (mode === 'webgl') webglCanvas.width = value; else mainCanvas.width = value; }
    });
    Object.defineProperty(proxy, 'height', {
      get: function () { return mode === 'webgl' ? webglCanvas.height : mainCanvas.height; },
      set: function (value) { if (mode === 'webgl') webglCanvas.height = value; else mainCanvas.height = value; }
    });
    Object.defineProperty(proxy, 'clientWidth', { get: function () { return cssW; } });
    Object.defineProperty(proxy, 'clientHeight', { get: function () { return cssH; } });
    return proxy;
  })();

  function newCanvas() {
    // The first wx.createCanvas() call is the on-screen canvas; later calls are offscreen.
    var canvas = wx.createCanvas();
    decorateCanvas(canvas, false);
    return canvas;
  }

  var body = {
    style: {}, clientWidth: cssW, clientHeight: cssH,
    appendChild: function (node) { uiNodes++; return node; }
  };
  var documentElement = { style: {}, clientWidth: cssW, clientHeight: cssH, appendChild: function () {} };

  var doc = {
    hidden: false,
    visibilityState: 'visible',
    body: body,
    documentElement: documentElement,
    getElementById: function (id) { return id === 'game' ? gameCanvas : null; },
    createElement: function (tag) {
      var name = String(tag || '').toLowerCase();
      if (name === 'canvas') return newCanvas();
      if (name === 'img' || name === 'image') return wx.createImage();
      return { style: {}, appendChild: function () {}, addEventListener: function () {}, removeEventListener: function () {} };
    },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function (type, fn) { on(documentEvents, type, fn); },
    removeEventListener: function (type, fn) { off(documentEvents, type, fn); }
  };

  function ImageCtor() { return wx.createImage(); }

  var storage = {
    getItem: function (key) {
      try {
        var value = wx.getStorageSync(String(key));
        return value === '' || value === undefined || value === null ? null : String(value);
      } catch (error) { return null; }
    },
    setItem: function (key, value) {
      try { wx.setStorageSync(String(key), String(value)); } catch (error) { /* ignore */ }
    },
    removeItem: function (key) {
      try { wx.removeStorageSync(String(key)); } catch (error) { /* ignore */ }
    },
    clear: function () {
      try { wx.clearStorageSync(); } catch (error) { /* ignore */ }
    },
    key: function () { return null; },
    length: 0
  };

  var nativeRaf = G.requestAnimationFrame || function (callback) {
    return setTimeout(function () { callback(Date.now()); }, 16);
  };
  var nativeCaf = G.cancelAnimationFrame || function (id) { clearTimeout(id); };

  /** Copy the offscreen WebGL frame onto the screen canvas. */
  function blit() {
    if (blitFailed || !webglCanvas) return;
    var ctx = mainContext();
    if (!ctx) { blitFailed = true; return; }
    try {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(webglCanvas, 0, 0, mainCanvas.width, mainCanvas.height);
      ctx.restore();
    } catch (error) {
      // A device that cannot draw a canvas into a canvas still plays the game;
      // it just shows the raw WebGL surface underneath.
      blitFailed = true;
    }
  }

  /* ---- HUD -----------------------------------------------------------------
   * Mini-games have no DOM, so the text a game would have put into div/span
   * elements has to be drawn. Games following the studio contract expose
   * window.__gameState(); the HUD is only drawn when the game actually built a
   * DOM HUD (uiNodes > 0), so canvas-drawn 2D HUDs are never duplicated. */
  function font(size) {
    return 'bold ' + Math.round(size) + 'px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  }
  function repeat(text, count) {
    var out = '';
    for (var i = 0; i < count; i++) out += text;
    return out;
  }
  function pill(ctx, text, x, y, align, size, color) {
    ctx.font = font(size);
    var width = ctx.measureText(text).width + size * 1.35;
    var height = Math.round(size * 1.9);
    var left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    ctx.fillStyle = 'rgba(10,14,32,0.45)';
    ctx.fillRect(left, y, width, height);
    ctx.fillStyle = color || '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(text, left + width / 2, y + height / 2);
  }
  function centerText(ctx, text, x, y, size, color) {
    ctx.font = font(size);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y);
  }

  /* ---- Monetization ---------------------------------------------------------
   * Never forced: one interstitial between two rounds when one is configured,
   * and a rewarded video only when the player taps 看广告复活 after losing. The
   * ad unit IDs come from window.GAME.monetization, which the exporter embeds
   * from the game's .studio/wechat-commerce.json. Analytics uses whatever the
   * base library has (reportEvent, else reportAnalytics). */
  var money;
  var ads = { interstitial: null, rewarded: null, shown: 0, rewardedShown: 0, lastError: '' };
  var reviveVisible = false;
  var reviveRect = null;
  var lastPhase = 'title';
  var adBusy = false;

  function readState() {
    try { return G.__gameState ? G.__gameState() : null; } catch (error) { return null; }
  }

  function report(event, data) {
    if (!money || money.analytics === false) return;
    try {
      if (wx.reportEvent) wx.reportEvent('game_' + event, data || {});
      else if (wx.reportAnalytics) wx.reportAnalytics('game_' + event, data || {});
    } catch (error) { /* analytics is optional */ }
  }

  function initAds() {
    if (!money || !money.enabled) return;
    try {
      if (money.interstitial && wx.createInterstitialAd) {
        ads.interstitial = wx.createInterstitialAd({ adUnitId: money.interstitial });
        if (ads.interstitial && ads.interstitial.onError) {
          ads.interstitial.onError(function (error) { ads.lastError = String((error && error.errMsg) || error); });
        }
      }
    } catch (error) { ads.lastError = String((error && error.message) || error); }
    try {
      if (money.rewarded && wx.createRewardedVideoAd) {
        ads.rewarded = wx.createRewardedVideoAd({ adUnitId: money.rewarded });
        if (ads.rewarded && ads.rewarded.onError) {
          ads.rewarded.onError(function (error) { ads.lastError = String((error && error.errMsg) || error); });
        }
      }
    } catch (error) { ads.lastError = String((error && error.message) || error); }
  }

  function moneyConfig() {
    if (money === undefined) {
      money = (G.GAME && G.GAME.monetization) || null;
      initAds();
    }
    return money;
  }

  function showInterstitial() {
    if (!ads.interstitial || adBusy) return;
    adBusy = true;
    try {
      var shown = ads.interstitial.show();
      if (shown && shown.catch) shown.catch(function () { ads.lastError = 'interstitial show failed'; });
      ads.shown += 1;
      report('ad_interstitial', {});
    } catch (error) { ads.lastError = String((error && error.message) || error); }
    setTimeout(function () { adBusy = false; }, 1200);
  }

  function showRewarded(done) {
    if (!ads.rewarded || adBusy) return;
    adBusy = true;
    var handled = false;
    function finish(ok) {
      if (handled) return;
      handled = true;
      adBusy = false;
      if (ok) ads.rewardedShown += 1;
      report('ad_rewarded', { completed: ok ? 1 : 0 });
      if (ok) done();
    }
    try {
      ads.rewarded.onClose(function (res) { finish(!res || res.isEnded !== false); });
      var shown = ads.rewarded.show();
      if (shown && shown.catch) {
        shown.catch(function () {
          ads.rewarded.load().then(function () { ads.rewarded.show(); }).catch(function () { finish(false); });
        });
      }
    } catch (error) {
      ads.lastError = String((error && error.message) || error);
      finish(false);
    }
    // A player who closes the mini-game mid-ad must not lock the button forever.
    setTimeout(function () { finish(false); }, 30000);
  }

  function revive() {
    if (!ads.rewarded) return;
    showRewarded(function () {
      reviveVisible = false;
      // The templates start a new round on a tap on the screen.
      setTimeout(function () {
        dispatchTouch('pointerdown', { identifier: 9001, clientX: cssW / 2, clientY: cssH / 2 });
        dispatchTouch('pointerup', { identifier: 9001, clientX: cssW / 2, clientY: cssH / 2 });
      }, 300);
    });
  }

  function trackCommerce(state) {
    if (!state || !state.phase) return;
    moneyConfig();
    if (state.phase === lastPhase) return;
    var previous = lastPhase;
    lastPhase = state.phase;
    reviveVisible = false;
    if (state.phase === 'playing' && previous !== 'playing') report('round_start', {});
    if ((state.phase === 'won' || state.phase === 'lost') && previous === 'playing') {
      report('round_end', { score: Math.round(state.score || 0), result: state.phase === 'won' ? 'win' : 'lose' });
      if (money && money.interstitial && ads.interstitial) setTimeout(showInterstitial, 700);
      if (money && money.rewarded && ads.rewarded && state.phase === 'lost') reviveVisible = true;
    }
  }

  /** The revive button is drawn even for games with a canvas HUD (2D templates). */
  function drawReviveButton(ctx, W, H) {
    if (!reviveVisible || !ads.rewarded) { reviveRect = null; return; }
    var label = '看广告复活';
    ctx.font = font(15);
    var width = Math.round(ctx.measureText(label).width + 34);
    var height = 40;
    var left = Math.round((W - width) / 2);
    var reviveTop = Math.round(H * 0.40) + 92;
    ctx.fillStyle = 'rgba(255,196,99,0.95)';
    ctx.fillRect(left, reviveTop, width, height);
    ctx.fillStyle = '#2b1a0a';
    ctx.textAlign = 'center';
    ctx.fillText(label, W / 2, reviveTop + height / 2);
    reviveRect = { left: left, top: reviveTop, width: width, height: height };
  }

  function drawHud(state) {
    if (!state) state = readState();
    if (!state) return;
    var ctx = mainContext();
    if (!ctx) return;
    var W = cssW;
    var H = cssH;
    if (!uiNodes) {
      // A 2D game draws its own HUD; only the commerce button belongs here.
      ctx.save();
      try {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.textBaseline = 'middle';
        drawReviveButton(ctx, W, H);
      } finally {
        ctx.restore();
      }
      return;
    }
    var top = Math.max(10, safeTop + 10);
    var scale = dpr;
    ctx.save();
    try {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.textBaseline = 'middle';
      if (state.phase === 'error') {
        ctx.fillStyle = 'rgba(10,14,32,0.78)';
        ctx.fillRect(0, 0, W, H);
        centerText(ctx, '这台设备暂时跑不了 3D', W / 2, H * 0.40, 22, '#ffe9a8');
        centerText(ctx, '需要支持 WebGL2 的微信版本', W / 2, H * 0.40 + 32, 14, '#ffffff');
        centerText(ctx, '请更新微信，或换一台较新的手机', W / 2, H * 0.40 + 56, 14, '#ffffff');
        return;
      }
      if (state.phase === 'title') {
        var title = (G.GAME && G.GAME.title) || '';
        if (title) centerText(ctx, title, W / 2, H * 0.40, Math.round(H * 0.042), '#ffffff');
        pill(ctx, '点击开始 / Tap to start', W / 2, Math.round(H * 0.44), 'center', 15, '#ffe9a8');
        return;
      }
      if (typeof state.hearts === 'number' && state.hearts >= 0) {
        pill(ctx, repeat('♥', Math.max(0, Math.round(state.hearts))), 12, top, 'left', 15, '#ff8a9a');
      }
      if (typeof state.score === 'number') {
        pill(ctx, '✦ ' + Math.round(state.score), 12 + 86, top, 'left', 15, '#ffe9a8');
      }
      if (typeof state.time === 'number' && state.phase === 'playing') {
        pill(ctx, Math.ceil(state.time) + 's', W - 12, top, 'right', 15, '#ffffff');
      }
      if (state.phase === 'won' || state.phase === 'lost') {
        ctx.fillStyle = 'rgba(10,14,32,0.55)';
        ctx.fillRect(0, H * 0.34, W, H * 0.26);
        centerText(ctx, state.phase === 'won' ? '通关！' : '游戏结束', W / 2, H * 0.40, 24, '#ffe9a8');
        centerText(ctx, '得分 ' + Math.round(state.score || 0), W / 2, H * 0.40 + 34, 16, '#ffffff');
        pill(ctx, '点击重新开始', W / 2, Math.round(H * 0.40) + 54, 'center', 14, '#ffffff');
      }
      drawReviveButton(ctx, W, H);
    } finally {
      ctx.restore();
    }
  }

  function afterFrame() {
    frames += 1;
    var frameAt = clockNow();
    if (firstFrameAt === null) firstFrameAt = frameAt;
    frameTimes.push(frameAt);
    if (frameTimes.length > 30) frameTimes.shift();
    if (webglCanvas) blit();
    var state = readState();
    trackCommerce(state);
    drawHud(state);
  }

  /* ---- In-app purchases ----------------------------------------------------
   * The plugin never signs a payment and never collects money. A configured
   * payUrl is asked for the signed parameters and wx.requestVirtualPayment does
   * the rest; without a payUrl the flow runs in dry-run mode so the client side
   * can be tested. Enabling IAP without a licence number is refused upstream in
   * commerceCheck(), because virtual payment requires one. */
  function currentIap() {
    var cfg = moneyConfig();
    return cfg && cfg.iap && cfg.iap.enabled ? cfg.iap : null;
  }

  function buy(sku) {
    var cfg = currentIap();
    if (!cfg) return Promise.reject(new Error('iap_not_enabled'));
    report('iap_order', { sku: String(sku || '') });
    if (cfg.dryRun || !cfg.payUrl) {
      report('iap_dry_run', { sku: String(sku || '') });
      return Promise.resolve({ dryRun: true, sku: sku });
    }
    return new Promise(function (resolve, reject) {
      if (!wx.request || !wx.requestVirtualPayment) {
        reject(new Error('wx.requestVirtualPayment is unavailable on this base library'));
        return;
      }
      wx.request({
        url: cfg.payUrl,
        method: 'POST',
        data: { sku: sku, appid: (G.GAME && G.GAME.appid) || '' },
        success: function (res) {
          var body = res && res.data;
          if (!body || !body.signData) {
            report('iap_failed', { sku: sku });
            reject(new Error('pay server returned no signData'));
            return;
          }
          try {
            wx.requestVirtualPayment({
              signData: body.signData,
              paySig: body.paySig,
              signature: body.signature,
              mode: 'game',
              success: function (result) { report('iap_paid', { sku: sku }); resolve(result); },
              fail: function (error) { report('iap_failed', { sku: sku }); reject(error); },
            });
          } catch (error) { reject(error); }
        },
        fail: function (error) { report('iap_failed', { sku: sku }); reject(error); },
      });
    });
  }

  G.__commerce = {
    ads: ads,
    revive: revive,
    report: report,
    iap: { buy: buy, config: currentIap },
    state: function () {
      return {
        enabled: Boolean(money && money.enabled),
        shown: ads.shown,
        rewardedShown: ads.rewardedShown,
        lastError: ads.lastError,
        reviveVisible: reviveVisible,
      };
    },
  };

  // Every frame the game asks for ends with a blit and a HUD paint.
  G.requestAnimationFrame = function (callback) {
    return nativeRaf(function (timestamp) {
      try {
        callback(timestamp);
      } finally {
        afterFrame();
      }
    });
  };
  G.cancelAnimationFrame = function (id) { nativeCaf(id); };
  G.__wechatRuntime = {
    width: cssW, height: cssH, dpr: dpr, safeTop: safeTop,
    quality: { tier: quality, benchmarkLevel: benchmarkLevel, dprCap: dprCap },
    metrics: function () {
      var elapsed = clockNow() - startedAt;
      return {
        bootMs: firstFrameAt === null ? null : Math.round(firstFrameAt - startedAt),
        frames: frames,
        fps: frameTimes.length >= 2
          ? Math.round((frameTimes.length - 1) * 1000 / Math.max(1, frameTimes[frameTimes.length - 1] - frameTimes[0]))
          : 0,
        ageMs: Math.round(clockNow() - startedAt),
        tier: quality,
      };
    },
    canvas: gameCanvas, screen: mainCanvas,
    get ctx() { return mainContext(); },
    get webgl() { return webglCanvas; },
  };

  // A 3D game that found no WebGL2 never starts its loop, so paint the error
  // card on a timer as well.
  setTimeout(drawHud, 900);
  setTimeout(drawHud, 2500);

  // The original game references these as free globals; window === GameGlobal.
  G.window = G;
  G.self = G;
  G.top = G;
  G.parent = G;
  G.document = doc;
  G.Image = ImageCtor;
  G.localStorage = storage;
  G.innerWidth = cssW;
  G.innerHeight = cssH;
  G.devicePixelRatio = dpr;
  G.performance = { now: function () { return Date.now(); } };
  G.navigator = { userAgent: 'wechat-minigame', platform: 'wechat' };
  G.location = { href: '', search: '', hash: '' };
  G.screen = { width: cssW, height: cssH };
  G.addEventListener = function (type, fn) { on(windowEvents, type, fn); };
  G.removeEventListener = function (type, fn) { off(windowEvents, type, fn); };
  G.dispatchEvent = function (event) { if (event && event.type) emit(windowEvents, event.type, event); };
  G.scrollTo = function () {};
  G.focus = function () {};
  G.blur = function () {};
  G.alert = function () {};

  function pointerEvent(touch, type) {
    return {
      type: type,
      pointerId: touch.identifier,
      pointerType: 'touch',
      clientX: touch.clientX,
      clientY: touch.clientY,
      pageX: touch.clientX,
      pageY: touch.clientY,
      x: touch.clientX,
      y: touch.clientY,
      target: gameCanvas,
      currentTarget: gameCanvas,
      preventDefault: function () {},
      stopPropagation: function () {},
      stopImmediatePropagation: function () {}
    };
  }
  function dispatchTouch(type, touch) {
    // The revive button is drawn by the adapter, so it is hit-tested here before
    // the game sees the tap (otherwise the tap would just restart the round).
    if (type === 'pointerdown' && reviveVisible && reviveRect
      && touch.clientX >= reviveRect.left && touch.clientX <= reviveRect.left + reviveRect.width
      && touch.clientY >= reviveRect.top && touch.clientY <= reviveRect.top + reviveRect.height) {
      revive();
      return;
    }
    var pointer = pointerEvent(touch, type);
    emit(canvasEvents, type, pointer);
    var touchType = type === 'pointerdown' ? 'touchstart'
      : type === 'pointermove' ? 'touchmove'
        : type === 'pointerup' ? 'touchend' : 'touchcancel';
    var touchEvent = {
      type: touchType, touches: [pointer], targetTouches: [pointer], changedTouches: [pointer],
      preventDefault: function () {}, stopPropagation: function () {}
    };
    emit(canvasEvents, touchType, touchEvent);
  }

  wx.onTouchStart(function (event) {
    var list = event.changedTouches || [];
    for (var i = 0; i < list.length; i++) dispatchTouch('pointerdown', list[i]);
  });
  wx.onTouchMove(function (event) {
    var list = event.changedTouches || [];
    for (var i = 0; i < list.length; i++) dispatchTouch('pointermove', list[i]);
  });
  wx.onTouchEnd(function (event) {
    var list = event.changedTouches || [];
    for (var i = 0; i < list.length; i++) dispatchTouch('pointerup', list[i]);
  });
  if (wx.onTouchCancel) {
    wx.onTouchCancel(function (event) {
      var list = event.changedTouches || [];
      for (var i = 0; i < list.length; i++) dispatchTouch('pointercancel', list[i]);
    });
  }

  function resize() {
    var next = wx.getSystemInfoSync();
    cssW = Math.max(1, next.windowWidth || cssW);
    cssH = Math.max(1, next.windowHeight || cssH);
    dpr = Math.min(dprCap, next.pixelRatio || dpr);
    safeTop = next.safeArea && typeof next.safeArea.top === 'number' ? next.safeArea.top : safeTop;
    G.innerWidth = cssW;
    G.innerHeight = cssH;
    G.devicePixelRatio = dpr;
    mainCanvas.clientWidth = cssW;
    mainCanvas.clientHeight = cssH;
    emit(windowEvents, 'resize', { type: 'resize' });
  }
  if (wx.onWindowResize) wx.onWindowResize(resize);

  function hide() {
    doc.hidden = true;
    doc.visibilityState = 'hidden';
    emit(documentEvents, 'visibilitychange', { type: 'visibilitychange' });
    emit(windowEvents, 'blur', { type: 'blur' });
  }
  function show() {
    doc.hidden = false;
    doc.visibilityState = 'visible';
    emit(documentEvents, 'visibilitychange', { type: 'visibilitychange' });
    emit(windowEvents, 'focus', { type: 'focus' });
  }
  if (wx.onHide) wx.onHide(hide);
  if (wx.onShow) wx.onShow(show);
  var logLoaded = false;
  var logManager = null;
  function realtimeLog() {
    if (!logLoaded) {
      logLoaded = true;
      try { logManager = wx.getRealtimeLogManager ? wx.getRealtimeLogManager() : null; } catch (error) { logManager = null; }
    }
    return logManager;
  }
  function reportRuntimeError(source, error) {
    var message = String((error && (error.message || error.errMsg)) || error || source).slice(0, 500);
    try {
      var log = realtimeLog();
      if (log && typeof log.error === 'function') log.error('[dsh-game-studio]', source + ': ' + message);
    } catch (ignored) { /* logging is optional */ }
  }

  if (wx.onUnhandledRejection) {
    wx.onUnhandledRejection(function (event) {
      reportRuntimeError('unhandledRejection', (event && (event.reason || event)) || 'unhandled rejection');
    });
  }
  if (wx.onError) {
    wx.onError(function (error) {
      reportRuntimeError('wx.onError', error);
      emit(windowEvents, 'error', { type: 'error', message: error && error.message ? error.message : String(error) });
    });
  }
})();



