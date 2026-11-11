/* dsh-game-studio — WeChat mini-game runtime adapter (classic script).
 *
 * The exporter inlines this file before the original 2D game.js, then sets
 * window.GAME. It gives the browser-style game a minimal window/document/
 * canvas/Image/localStorage/pointer environment on top of wx.*.
 *
 * Scope: 2D games following the dsh-game-studio contract (collector template
 * and custom canvas games). Three.js/WebGL games are not supported yet.
 */
(function () {
  'use strict';
  if (typeof wx === 'undefined') return;

  var G = typeof GameGlobal !== 'undefined' ? GameGlobal : this;
  var sys = wx.getSystemInfoSync();
  var cssW = Math.max(1, sys.windowWidth || 375);
  var cssH = Math.max(1, sys.windowHeight || 667);
  var dpr = Math.min(2, sys.pixelRatio || 1);
  var mainCanvas = wx.createCanvas();
  var canvasEvents = {};
  var windowEvents = {};
  var documentEvents = {};

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
  var mainCtx = mainCanvas.getContext('2d');

  function newCanvas() {
    // First wx.createCanvas() call is the on-screen canvas; later calls are offscreen.
    var canvas = wx.createCanvas();
    decorateCanvas(canvas, false);
    return canvas;
  }

  var body = { style: {}, clientWidth: cssW, clientHeight: cssH, appendChild: function () {} };
  var documentElement = { style: {}, clientWidth: cssW, clientHeight: cssH, appendChild: function () {} };

  var doc = {
    hidden: false,
    visibilityState: 'visible',
    body: body,
    documentElement: documentElement,
    getElementById: function (id) { return id === 'game' ? mainCanvas : null; },
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

  var raf = G.requestAnimationFrame || function (callback) {
    return setTimeout(function () { callback(Date.now()); }, 16);
  };
  var caf = G.cancelAnimationFrame || function (id) { clearTimeout(id); };

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
  G.requestAnimationFrame = raf;
  G.cancelAnimationFrame = caf;
  G.addEventListener = function (type, fn) { on(windowEvents, type, fn); };
  G.removeEventListener = function (type, fn) { off(windowEvents, type, fn); };
  G.dispatchEvent = function (event) { if (event && event.type) emit(windowEvents, event.type, event); };
  G.scrollTo = function () {};
  G.focus = function () {};
  G.blur = function () {};
  G.alert = function () {};
  G.__wechatRuntime = { width: cssW, height: cssH, dpr: dpr, canvas: mainCanvas, ctx: mainCtx };

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
      target: mainCanvas,
      currentTarget: mainCanvas,
      preventDefault: function () {},
      stopPropagation: function () {},
      stopImmediatePropagation: function () {}
    };
  }
  function dispatchTouch(type, touch) {
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
    dpr = Math.min(2, next.pixelRatio || dpr);
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
  if (wx.onError) {
    wx.onError(function (error) {
      emit(windowEvents, 'error', { type: 'error', message: error && error.message ? error.message : String(error) });
    });
  }
})();
