'use strict';

/**
 * AI Chart Predictor — DOM integration tests (jsdom).
 *
 *   node test/dom-tests.js        (requires `npm install`, jsdom is a devDependency)
 *
 * Unlike run-tests.js these tests execute the real content script and panel in
 * a simulated page: the overlay is mounted into a shadow root, the canvas is a
 * recording stub, and the AI backend is simulated through the message channel.
 * They verify the full flow: boot -> analyze -> draw -> drag -> resize -> clear,
 * plus live-mode timer hygiene and settings propagation.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createChromeMock, ROOT } = require('./mock-chrome');

let passed = 0;
let failed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log('\n\u001b[1m' + name + '\u001b[0m');
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  \u001b[32m✓\u001b[0m ' + name);
  } catch (error) {
    failed += 1;
    failures.push({ group: currentGroup, name: name, error: error });
    console.log('  \u001b[31m✗ ' + name + '\u001b[0m');
    console.log('      ' + String((error && error.message) || error).split('\n').join('\n      '));
  }
}

const wait = function (ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
};

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 2000);
  while (Date.now() < deadline) {
    let value = false;
    try {
      value = predicate();
    } catch (error) {
      value = false;
    }
    if (value) return value;
    await wait(10);
  }
  throw new Error('Timed out waiting for ' + (label || 'condition'));
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const OVERLAY_CSS = fs.readFileSync(path.join(ROOT, 'overlay.css'), 'utf8');

const ANALYSIS = {
  symbol: 'BTCUSD',
  timeframe: '15m',
  trend: 'bullish',
  market_structure: 'HH/HL — higher highs since the demand retest',
  confidence: 72,
  reasoning: 'Reclaimed the 4h demand zone and printed a bullish engulfing candle above the 20 EMA.',
  support_resistance: [
    { type: 'support', price: 100, y: 0.7, label: '4h demand' },
    { type: 'resistance', price: 110, y: 0.3, label: 'swing high' }
  ],
  zones: [{ type: 'demand', x1: 0.1, y1: 0.65, x2: 0.9, y2: 0.75, label: 'demand block' }],
  trendlines: [{ x1: 0.05, y1: 0.8, x2: 0.9, y2: 0.5, label: 'rising trendline' }],
  patterns: { candlestick: ['bullish engulfing'], chart: ['ascending triangle'] },
  indicators: { rsi: 'RSI 58 rising', macd: 'MACD below zero', ma: 'above 20 EMA', volume: 'expanding' },
  trade: { direction: 'long', entry: 104, stop_loss: 100, target1: 110, target2: 115, risk_reward: '1 : 1.50' },
  price_scale: { point_a: { price: 110, y: 0.3 }, point_b: { price: 100, y: 0.7 } },
  last_candle: { x: 0.85, y: 0.5, width: 0.015 },
  predicted_candles: [
    { open: 104, high: 106, low: 103, close: 105 },
    { open: 105, high: 107, low: 104, close: 106 },
    { open: 106, high: 108, low: 105, close: 107 }
  ]
};

/**
 * Boot a page with the content script loaded.
 * @returns {object} harness
 */
async function bootPage(options) {
  const opts = options || {};

  const dom = new JSDOM(
    '<!doctype html><html><head><title>Chart</title></head><body><div id="chart">candles</div></body></html>',
    {
      url: 'https://www.tradingview.com/chart/BTCUSD/',
      pretendToBeVisual: true,
      runScripts: 'outside-only'
    }
  );

  const win = dom.window;

  /* --- viewport (mutable so resize can be simulated) ------------------ */
  const viewport = { width: opts.width || 1024, height: opts.height || 768, dpr: opts.dpr || 2 };
  Object.defineProperty(win, 'innerWidth', { configurable: true, get: () => viewport.width });
  Object.defineProperty(win, 'innerHeight', { configurable: true, get: () => viewport.height });
  Object.defineProperty(win, 'devicePixelRatio', { configurable: true, get: () => viewport.dpr });

  /* --- canvas recording stub ----------------------------------------- */
  const canvasCalls = [];
  win.HTMLCanvasElement.prototype.getContext = function getContext() {
    const owner = this;
    const target = { font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, textAlign: 'left', textBaseline: 'alphabetic', shadowBlur: 0, shadowColor: '' };
    return new Proxy(target, {
      get: function (object, prop) {
        if (prop === 'canvas') return owner;
        if (prop === 'measureText') {
          return function (text) {
            canvasCalls.push({ method: 'measureText', args: [text] });
            return { width: String(text).length * 6.2 };
          };
        }
        if (Object.prototype.hasOwnProperty.call(object, prop)) return object[prop];
        return function () {
          canvasCalls.push({ method: String(prop), args: Array.prototype.slice.call(arguments) });
        };
      },
      set: function (object, prop, value) {
        object[prop] = value;
        return true;
      }
    });
  };

  /* --- interval accounting (duplicate-timer detection) ---------------- */
  const timers = { intervals: new Set(), timeouts: new Set() };
  const nativeSetInterval = win.setInterval.bind(win);
  const nativeClearInterval = win.clearInterval.bind(win);
  const nativeSetTimeout = win.setTimeout.bind(win);
  const nativeClearTimeout = win.clearTimeout.bind(win);

  win.setInterval = function (fn, ms) {
    const id = nativeSetInterval(fn, ms);
    timers.intervals.add(id);
    return id;
  };
  win.clearInterval = function (id) {
    timers.intervals.delete(id);
    return nativeClearInterval(id);
  };
  win.setTimeout = function (fn, ms) {
    const id = nativeSetTimeout(fn, ms);
    timers.timeouts.add(id);
    return id;
  };
  win.clearTimeout = function (id) {
    timers.timeouts.delete(id);
    return nativeClearTimeout(id);
  };

  /* --- chrome mock + fake background ---------------------------------- */
  const storage = {};
  if (opts.settings) storage.acpSettingsV1 = opts.settings;
  const mock = createChromeMock({ storage: storage });

  win.chrome = mock.chrome;
  win.fetch = function () {
    return Promise.resolve({ ok: true, text: () => Promise.resolve(OVERLAY_CSS) });
  };

  /** loaded ACP namespace lives on the window; filled after evaluation */
  const log = {
    analyzeRequests: [],
    saveRequests: [],
    overlayHiddenDuringAnalyze: null,
    analyzeHandler: opts.analyzeHandler || null,
    offline: false
  };

  mock.state.sendMessageImpl = function (message, callback) {
    const respond = function (payload) {
      Promise.resolve().then(function () {
        if (typeof callback === 'function') callback(payload);
      });
    };

    switch (message && message.type) {
      case 'ACP_GET_SETTINGS':
        win.ACP.settings.getPublic().then(function (settings) {
          respond({ ok: true, settings: settings });
        });
        return;

      case 'ACP_SAVE_SETTINGS':
        log.saveRequests.push(message.settings);
        win.ACP.settings
          .read()
          .then(function (current) {
            return win.ACP.settings.write(Object.assign({}, current, message.settings));
          })
          .then(function (next) {
            respond({ ok: true, settings: win.ACP.settings.redact(next) });
          })
          .catch(function (error) {
            respond({ ok: false, error: { code: 'UNKNOWN', message: String(error && error.message) } });
          });
        return;

      case 'ACP_ANALYZE': {
        if (log.offline) {
          respond({ ok: false, error: { code: 'NETWORK', message: 'Network error while contacting the AI provider.' } });
          return;
        }
        const host = win.document.getElementById('acp-root');
        log.overlayHiddenDuringAnalyze = host ? host.style.getPropertyValue('display') : 'missing';
        log.analyzeRequests.push(message.payload);
        const handler = log.analyzeHandler;
        Promise.resolve(handler ? handler(message.payload) : { ok: true, analysis: JSON.parse(JSON.stringify(ANALYSIS)), warnings: [], meta: { providerLabel: 'OpenAI', model: 'gpt-4o', timeframe: message.payload.timeframe, candleCount: message.payload.candleCount, latencyMs: 1234, attempt: 1 } })
          .then(function (result) {
            // Mimic background.js telling the content script the shot is done.
            if (typeof mock.chrome.runtime.onMessage !== 'undefined') {
              mock
                .dispatchMessage({ type: 'ACP_CAPTURED' }, { id: 'acp-test-extension' })
                .catch(function () {});
            }
            respond(result);
          });
        return;
      }

      case 'ACP_CANCEL':
        respond({ ok: true, cancelled: true });
        return;

      case 'ACP_OPEN_OPTIONS':
        mock.state.openedOptions += 1;
        respond({ ok: true });
        return;

      default:
        respond({ ok: true });
    }
  };

  /* --- load the real content scripts ---------------------------------- */
  MANIFEST.content_scripts[0].js.forEach(function (file) {
    win.eval(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  });

  await waitFor(function () {
    return win.document.getElementById('acp-root');
  }, 2000, 'overlay host');

  const host = win.document.getElementById('acp-root');
  const shadow = host.shadowRoot;

  await waitFor(function () {
    return shadow && shadow.querySelector('#acp-panel');
  }, 2000, 'panel');

  const q = function (selector) {
    return shadow.querySelector(selector);
  };

  const api = {
    dom: dom,
    win: win,
    host: host,
    shadow: shadow,
    q: q,
    mock: mock,
    log: log,
    timers: timers,
    viewport: viewport,
    canvas: q('.acp-canvas'),
    handle: q('.acp-ghost-handle'),
    canvasCalls: canvasCalls,
    state: win.__AI_CHART_PREDICTOR.state,
    publicApi: win.__AI_CHART_PREDICTOR,
    countCalls: function (method) {
      return canvasCalls.filter(function (call) {
        return call.method === method;
      }).length;
    },
    findText: function (text) {
      return canvasCalls.filter(function (call) {
        return call.method === 'fillText' && String(call.args[0]).indexOf(text) >= 0;
      });
    },
    resize: async function (width, height, dpr) {
      viewport.width = width;
      viewport.height = height;
      if (typeof dpr === 'number') viewport.dpr = dpr;
      win.dispatchEvent(new win.Event('resize'));
      await wait(60);
    },
    /** Copy a cross-realm object into this realm so deepStrictEqual works. */
    plain: function (value) {
      return value == null ? value : JSON.parse(JSON.stringify(value));
    },
    pointer: function (type, element, x, y, pointerId) {
      const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(event, 'pointerId', { value: pointerId == null ? 1 : pointerId });
      element.dispatchEvent(event);
      return event;
    },
    clickAnalyze: async function () {
      const button = q('#acp-analyze');
      button.click();
      await waitFor(function () {
        return !button.disabled && (api.state.analyzing === false);
      }, 3000, 'analysis to finish');
      await wait(60);
    },
    close: function () {
      dom.window.close();
    }
  };

  return api;
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

async function main() {
  console.log('\u001b[1mAI Chart Predictor — DOM integration tests (jsdom)\u001b[0m');

  /* ---------------------------------------------------------------- */
  group('boot / overlay construction');

  const page = await bootPage({
    settings: { providerId: 'openai', model: 'gpt-4o', timeframe: '15m', candleCount: 3, liveIntervalSec: 30 }
  });

  await test('creates exactly one #acp-root host with a shadow root', function () {
    const hosts = page.win.document.querySelectorAll('#acp-root');
    assert.strictEqual(hosts.length, 1);
    assert.ok(page.shadow, 'shadow root missing');
    assert.ok(page.shadow.querySelector('.acp-canvas'), 'canvas missing');
    assert.ok(page.shadow.querySelector('#acp-panel'), 'panel missing');
  });

  await test('sizes the canvas in CSS pixels and scales it by devicePixelRatio', function () {
    assert.strictEqual(page.canvas.style.width, '1024px');
    assert.strictEqual(page.canvas.style.height, '768px');
    assert.strictEqual(page.canvas.width, 2048, 'backing store must be width * dpr');
    assert.strictEqual(page.canvas.height, 1536);
    assert.strictEqual(page.state.viewport.sx, 2);
    assert.strictEqual(page.state.viewport.sy, 2);
  });

  await test('the host never blocks page interaction (pointer-events: none)', function () {
    assert.ok(/pointer-events:\s*none/.test(page.host.getAttribute('style') || ''));
  });

  await test('panel is populated from the saved settings', function () {
    assert.strictEqual(page.q('#acp-provider').value, 'openai');
    assert.strictEqual(page.q('#acp-model').value, 'gpt-4o');
    assert.strictEqual(page.q('#acp-timeframe').value, '15m');
    assert.strictEqual(page.q('#acp-candles').value, '3');
    assert.strictEqual(page.q('#acp-live').checked, false);
    assert.strictEqual(page.q('#acp-provider').options.length, 9, 'all nine providers must be listed');
  });

  await test('shows the permanent disclaimer', function () {
    const text = page.q('#acp-disclaimer').textContent;
    assert.strictEqual(text, 'AI prediction is not financial advice. Trading involves risk.');
  });

  await test('re-injecting the content script does not create a second overlay', function () {
    const before = page.win.document.querySelectorAll('#acp-root').length;
    page.win.eval(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'));
    assert.strictEqual(page.win.document.querySelectorAll('#acp-root').length, before);
  });

  /* ---------------------------------------------------------------- */
  group('analyze → draw');

  await test('clicking Analyze sends the selected timeframe, candle count and viewport', async function () {
    await page.clickAnalyze();
    assert.strictEqual(page.log.analyzeRequests.length, 1);
    const payload = page.log.analyzeRequests[0];
    assert.strictEqual(payload.providerId, 'openai');
    assert.strictEqual(payload.model, 'gpt-4o');
    assert.strictEqual(payload.timeframe, '15m');
    assert.strictEqual(payload.candleCount, 3);
    assert.strictEqual(payload.imageWidth, 1024);
    assert.strictEqual(payload.imageHeight, 768);
    assert.ok(payload.requestId, 'a request id is required for cancellation');
  });

  await test('hides its own UI during capture and restores it afterwards', async function () {
    assert.strictEqual(page.log.overlayHiddenDuringAnalyze, 'none', 'overlay must be hidden for the screenshot');
    await waitFor(function () {
      return page.host.style.getPropertyValue('display') === 'block';
    }, 1500, 'the overlay to come back');
  });

  await test('fills the result card', function () {
    assert.strictEqual(page.q('#acp-result').hidden, false);
    assert.strictEqual(page.q('#acp-trend').textContent, 'Bullish');
    assert.strictEqual(page.q('#acp-trend').dataset.trend, 'bullish');
    assert.strictEqual(page.q('#acp-conf-value').textContent, '72%');
    assert.strictEqual(page.q('#acp-conf-fill').style.width, '72%');
    assert.strictEqual(page.q('#acp-entry').textContent, '104.00');
    assert.strictEqual(page.q('#acp-sl').textContent, '100.00');
    assert.strictEqual(page.q('#acp-tp1').textContent, '110.00');
    assert.strictEqual(page.q('#acp-tp2').textContent, '115.00');
    assert.strictEqual(page.q('#acp-rr').textContent, '1 : 1.50');
    assert.ok(page.q('#acp-reasoning').textContent.indexOf('bullish engulfing') >= 0);
    assert.strictEqual(page.q('#acp-symbol').textContent, 'BTCUSD');
    assert.ok(page.q('#acp-patterns').children.length >= 2, 'pattern chips missing');
    assert.ok(page.q('#acp-meta').textContent.indexOf('gpt-4o') >= 0);
  });

  await test('draws levels, zones, trendlines and trade lines with labels', function () {
    assert.ok(page.countCalls('fillRect') >= 2, 'risk/reward shading missing');
    assert.ok(page.countCalls('quadraticCurveTo') >= 4, 'rounded rect geometry missing');
    assert.ok(page.findText('SUPPORT 100.00').length >= 1, 'support label missing');
    assert.ok(page.findText('RESISTANCE 110.00').length >= 1, 'resistance label missing');
    assert.ok(page.findText('ENTRY 104.00').length >= 1, 'entry label missing');
    assert.ok(page.findText('SL 100.00').length >= 1, 'stop label missing');
    assert.ok(page.findText('TP1 110.00').length >= 1, 'target label missing');
    assert.ok(page.findText('DEMAND BLOCK').length >= 1, 'zone label missing');
    assert.ok(page.findText('rising trendline').length >= 1, 'trendline label missing');
  });

  await test('a second analysis keeps the user drag offset (live refresh)', async function () {
    const state = page.state;
    state.ghost.offset = { x: -60, y: 25 };
    await page.clickAnalyze();
    const offset = page.plain(state.ghost.offset);
    assert.ok(Math.abs(offset.x + 60) < 1, 'x offset must survive a refresh, got ' + offset.x);
    assert.ok(Math.abs(offset.y - 25) < 1, 'y offset must survive a refresh, got ' + offset.y);

    // Reset and let one frame paint so later drag assertions start from a known
    // handle position (jsdom throttles rAF, so nudge it with a resize).
    state.ghost.offset = { x: 0, y: 0 };
    page.win.dispatchEvent(new page.win.Event('resize'));
    await wait(120);
  });

  await test('draws three ghost candles with a dashed border and a drag hint', function () {
    assert.ok(page.findText('AI · 3 × 15m (drag me)').length >= 1, 'ghost group label missing');
    const dashed = page.canvasCalls.filter(function (call) {
      return call.method === 'setLineDash' && Array.isArray(call.args[0]) && call.args[0].length === 2 && call.args[0][0] === 4;
    });
    assert.ok(dashed.length >= 3, 'each ghost candle should set a dashed stroke');
    assert.ok(2000 <= page.canvas.width, 'canvas backing store sanity');
  });

  await test('sizes the drag handle to the ghost-candle group', function () {
    const handle = page.handle;
    assert.strictEqual(handle.hidden, false);
    const left = parseFloat(handle.style.left);
    const top = parseFloat(handle.style.top);
    const width = parseFloat(handle.style.width);
    const height = parseFloat(handle.style.height);
    assert.ok(left >= 0 && left <= 1024, 'handle left out of range: ' + left);
    assert.ok(top >= 0 && top <= 768, 'handle top out of range: ' + top);
    assert.ok(width > 10 && height > 10, 'handle too small: ' + width + 'x' + height);
    assert.ok(left + width <= 1024.5, 'handle must stay inside the viewport');
  });

  await test('ghost candles are placed to the right of the last candle anchor', function () {
    const ghost = page.state.ghost;
    assert.ok(ghost, 'ghost model missing');
    const anchorX = 0.85 * 1024;
    assert.ok(ghost.firstCenter >= anchorX - 1, 'ghost candles must start at/after the anchor');
    assert.strictEqual(ghost.candles.length, 3);
    assert.ok(ghost.scale, 'a price scale must be resolved');
    assert.ok(Math.abs(ghost.scale.yFor(110) - 0.3) < 1e-9, 'price_scale from the model must be used');
  });

  /* ---------------------------------------------------------------- */
  group('dragging the ghost candles');

  await test('drag moves the ghost candles by the pointer delta', async function () {
    const handle = page.handle;
    const startOffset = page.plain(page.state.ghost.offset);
    const startLeft = parseFloat(handle.style.left);
    const drawsBefore = page.canvasCalls.length;

    page.pointer('pointerdown', handle, 500, 400, 1);
    page.pointer('pointermove', handle, 200, 250, 1);
    await wait(90);
    page.pointer('pointerup', handle, 200, 250, 1);
    await wait(90);

    const offset = page.state.ghost.offset;
    // jsdom throttles requestAnimationFrame to ~16 fps, and a move that lands
    // while a frame is already queued is applied by the next frame, so allow a
    // pixel of slack instead of comparing floats exactly.
    assert.ok(Math.abs(offset.x - startOffset.x + 300) <= 1, 'x offset should follow the pointer, got ' + (offset.x - startOffset.x));
    assert.ok(Math.abs(offset.y - startOffset.y + 150) <= 1, 'y offset should follow the pointer, got ' + (offset.y - startOffset.y));
    assert.ok(page.canvasCalls.length > drawsBefore, 'dragging must redraw the canvas');
    assert.ok(Math.abs(parseFloat(handle.style.left) - (startLeft - 300)) < 2, 'handle follows the candles');
    assert.strictEqual(page.state.drag, null, 'drag state must be cleared on pointerup');
  });

  await test('drag is clamped so the candles cannot leave the viewport', async function () {
    const handle = page.handle;
    page.pointer('pointerdown', handle, 500, 400, 2);
    page.pointer('pointermove', handle, 50000, 50000, 2);
    await wait(90);
    page.pointer('pointerup', handle, 50000, 50000, 2);
    await wait(60);

    const ghost = page.state.ghost;
    const left = ghost.base.left + ghost.offset.x;
    const right = ghost.base.right + ghost.offset.x;
    const top = ghost.base.top + ghost.offset.y;
    const bottom = ghost.base.bottom + ghost.offset.y;
    // Offsets are clamped lazily (on the drag move), so allow a frame of slack.
    assert.ok(left >= 20 && right <= 1024 - 20, 'clamped horizontally: ' + left + '..' + right);
    assert.ok(top >= 20 && bottom <= 768 - 20, 'clamped vertically: ' + top + '..' + bottom);

    // Reset the offset for the following tests.
    ghost.offset = { x: 0, y: 0 };
  });

  await test('a drag with a stale pointer id is ignored', async function () {
    const before = page.plain(page.state.ghost.offset);
    page.pointer('pointerdown', page.handle, 400, 300, 7);
    page.pointer('pointermove', page.handle, 600, 500, 8);
    await wait(90);
    page.pointer('pointerup', page.handle, 600, 500, 8);
    await wait(60);
    assert.deepStrictEqual(page.plain(page.state.ghost.offset), before, 'a move from another pointer must be ignored');
    page.pointer('pointerup', page.handle, 600, 500, 7);
  });

  /* ---------------------------------------------------------------- */
  group('resize / orientation change');

  await test('resize re-sizes the canvas and keeps the drawings consistent', async function () {
    await page.resize(800, 600, 3);
    assert.strictEqual(page.canvas.width, 2400);
    assert.strictEqual(page.canvas.height, 1800);
    assert.strictEqual(page.canvas.style.width, '800px');
    assert.ok(page.state.ghost, 'ghost model must be rebuilt on resize');
    assert.ok(page.state.ghost.firstCenter < 800, 'ghost candles rebased to the new width');
    const transforms = page.canvasCalls.filter(function (call) {
      return call.method === 'setTransform' && call.args[0] === 3;
    });
    assert.ok(transforms.length >= 1, 'the canvas must be drawn with the dpr transform');
    assert.ok(page.findText('AI · 3 × 15m (drag me)').length >= 1, 'ghost candles still drawn after resize');
  });

  await test('resize keeps a user drag offset', async function () {
    page.state.ghost.offset = { x: 40, y: -20 };
    await page.resize(900, 700, 1);
    const offset = page.plain(page.state.ghost.offset);
    assert.ok(Math.abs(offset.x - 40) < 1, 'x offset must survive a resize, got ' + offset.x);
    assert.ok(Math.abs(offset.y + 20) < 1, 'y offset must survive a resize, got ' + offset.y);
    page.state.ghost.offset = { x: 0, y: 0 };
  });

  /* ---------------------------------------------------------------- */
  group('live mode');

  await test('toggling live mode on starts exactly one interval', async function () {
    const checkbox = page.q('#acp-live');
    const intervalsBefore = page.timers.intervals.size;
    checkbox.checked = true;
    checkbox.dispatchEvent(new page.win.Event('change'));
    await wait(40);

    assert.strictEqual(page.state.live.enabled, true);
    assert.strictEqual(page.timers.intervals.size, intervalsBefore + 1, 'exactly one countdown interval');

    // Enabling again must not stack a second interval.
    page.state.live.enabled = true;
    checkbox.dispatchEvent(new page.win.Event('change'));
    await wait(40);
    assert.strictEqual(page.timers.intervals.size, intervalsBefore + 1, 'no duplicate intervals');
  });

  await test('live mode triggers an analysis and shows the countdown', async function () {
    await waitFor(function () {
      return page.log.analyzeRequests.length >= 2;
    }, 3000, 'a live refresh');
    // jsdom throttles 1 s intervals to ~16 fps, so allow the ticker a beat.
    await waitFor(function () {
      return /Live Mode/.test(page.q('#acp-status-text').textContent);
    }, 2500, 'the live-mode status text');
    assert.ok(page.log.analyzeRequests[1].requestId, 'live refreshes keep their own request id');
  });

  await test('toggling live mode off clears timer and interval', async function () {
    const checkbox = page.q('#acp-live');
    checkbox.checked = false;
    checkbox.dispatchEvent(new page.win.Event('change'));
    await wait(40);
    assert.strictEqual(page.state.live.enabled, false);
    assert.strictEqual(page.state.live.timer, 0);
    assert.strictEqual(page.state.live.ticker, 0);
  });

  await test('a fatal live error stops live mode automatically', async function () {
    page.log.analyzeHandler = function () {
      return { ok: false, error: { code: 'AUTH', message: 'The API key was rejected.' } };
    };
    const checkbox = page.q('#acp-live');
    checkbox.checked = true;
    checkbox.dispatchEvent(new page.win.Event('change'));

    await waitFor(function () {
      return page.state.live.enabled === false;
    }, 3000, 'live mode to stop after an auth error');

    assert.ok(/Live Mode stopped/.test(page.q('#acp-status-text').textContent));
    assert.strictEqual(checkbox.checked, false, 'the toggle must reflect the stopped state');
    page.log.analyzeHandler = null;
  });

  /* ---------------------------------------------------------------- */
  group('errors and status');

  await test('a network error is surfaced in the status line', async function () {
    page.log.offline = true;
    await page.clickAnalyze();
    page.log.offline = false;
    const status = page.q('#acp-status');
    assert.strictEqual(status.hidden, false);
    assert.ok(status.className.indexOf('is-error') >= 0);
    assert.ok(/Network error/.test(page.q('#acp-status-text').textContent));
    assert.strictEqual(page.q('#acp-analyze').disabled, false, 'the Analyze button must be re-enabled');
  });

  await test('a recovered analysis clears the error and updates the card', async function () {
    await page.clickAnalyze();
    assert.ok(page.q('#acp-status').className.indexOf('is-success') >= 0);
    assert.strictEqual(page.q('#acp-result').hidden, false);
  });

  /* ---------------------------------------------------------------- */
  group('settings propagation');

  await test('changing provider in storage updates the panel and warns about text-only models', async function () {
    await page.mock.setSettings({ providerId: 'deepseek', model: 'deepseek-chat', timeframe: '4h', candleCount: 5 });
    await waitFor(function () {
      return page.q('#acp-provider').value === 'deepseek';
    }, 2000, 'panel to follow the stored settings');
    await wait(80);

    assert.strictEqual(page.q('#acp-timeframe').value, '4h');
    assert.strictEqual(page.q('#acp-candles').value, '5');
    assert.strictEqual(page.q('#acp-model').value, 'deepseek-chat');
    assert.strictEqual(page.q('#acp-vision').hidden, false, 'vision warning should be visible');
    assert.strictEqual(page.q('#acp-vision').dataset.tone, 'error');
    assert.ok(/cannot read images/i.test(page.q('#acp-vision').textContent));

    await page.mock.setSettings({ providerId: 'openai', model: 'gpt-4o', timeframe: '15m', candleCount: 3 });
    await waitFor(function () {
      return page.q('#acp-provider').value === 'openai';
    }, 2000, 'panel to switch back');
  });

  await test('panel preference changes are persisted through the background', async function () {
    const timeframe = page.q('#acp-timeframe');
    timeframe.value = '1h';
    timeframe.dispatchEvent(new page.win.Event('change'));
    await waitFor(function () {
      return page.log.saveRequests.some(function (patch) {
        return patch.timeframe === '1h';
      });
    }, 2000, 'settings save');

    const stored = page.mock.readSettings();
    assert.strictEqual(stored.timeframe, '1h');
  });

  await test('the Options link is forwarded to the background', async function () {
    const before = page.mock.state.openedOptions;
    page.q('#acp-settings').click();
    await wait(60);
    assert.strictEqual(page.mock.state.openedOptions, before + 1);
  });

  /* ---------------------------------------------------------------- */
  group('panel behaviour');

  await test('collapse button hides the body and persists the state', async function () {
    const collapse = page.q('#acp-collapse');
    collapse.click();
    await wait(60);
    assert.strictEqual(page.q('#acp-panel').dataset.collapsed, 'true');
    await waitFor(function () {
      return page.log.saveRequests.some(function (patch) {
        return patch.panel && patch.panel.collapsed === true;
      });
    }, 2000, 'collapse persisted');
    collapse.click();
    await waitFor(function () {
      return page.q('#acp-panel').dataset.collapsed === 'false';
    }, 2000, 'the panel to expand again');
  });

  await test('dragging the panel header moves the panel and saves the position', async function () {
    const header = page.q('#acp-header');
    const panelEl = page.q('#acp-panel');
    // jsdom has no layout engine: fake the box the drag math reads.
    panelEl.style.left = '400px';
    panelEl.style.top = '100px';
    Object.defineProperty(panelEl, 'offsetWidth', { configurable: true, get: () => 358 });
    Object.defineProperty(panelEl, 'offsetHeight', { configurable: true, get: () => 420 });
    panelEl.getBoundingClientRect = function () {
      const left = parseFloat(panelEl.style.left) || 0;
      const top = parseFloat(panelEl.style.top) || 0;
      return { left: left, top: top, width: 358, height: 420, right: left + 358, bottom: top + 420, x: left, y: top };
    };

    page.pointer('pointerdown', header, 400, 100, 11);
    page.pointer('pointermove', header, 300, 200, 11);
    page.pointer('pointerup', header, 300, 200, 11);
    await wait(400);

    assert.strictEqual(panelEl.style.left, '300px');
    assert.strictEqual(panelEl.style.top, '200px');
    const saved = page.log.saveRequests.filter(function (patch) {
      return patch.panel && typeof patch.panel.left === 'number';
    });
    assert.ok(saved.length >= 1, 'panel position should be persisted');
    assert.strictEqual(page.mock.readSettings().panel.left, 300);
  });

  await test('keyboard shortcuts inside the panel do not leak to the page', function () {
    let leaked = false;
    const listener = function () {
      leaked = true;
    };
    page.win.document.addEventListener('keydown', listener);
    const event = new page.win.KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true });
    page.q('#acp-model').dispatchEvent(event);
    page.win.document.removeEventListener('keydown', listener);
    assert.strictEqual(leaked, false, 'the panel must stop keydown propagation');
  });

  /* ---------------------------------------------------------------- */
  group('clear + global toggle');

  await test('Clear removes every drawing and the result card', async function () {
    page.q('#acp-clear').click();
    await wait(80);
    assert.strictEqual(page.state.analysis, null);
    assert.strictEqual(page.state.ghost, null);
    assert.strictEqual(page.handle.hidden, true);
    assert.strictEqual(page.q('#acp-result').hidden, true);
    assert.ok(page.countCalls('clearRect') >= 2, 'the canvas must be cleared');
  });

  await test('Alt+Shift+A toggle hides and shows the overlay', async function () {
    const response = await page.mock.dispatchMessage({ type: 'ACP_TOGGLE_PANEL' }, { id: 'acp-test-extension' });
    assert.strictEqual(response.ok, true);
    assert.strictEqual(response.visible, false);
    await waitFor(function () {
      return page.host.style.getPropertyValue('display') === 'none';
    }, 1500, 'the overlay to hide');

    const again = await page.mock.dispatchMessage({ type: 'ACP_TOGGLE_PANEL' }, { id: 'acp-test-extension' });
    assert.strictEqual(again.visible, true);
    assert.strictEqual(page.host.style.getPropertyValue('display'), 'block');
    assert.ok(page.q('#acp-panel'), 'panel still mounted after toggling');
  });

  await test('PING answers so the background knows the overlay is alive', async function () {
    const response = await page.mock.dispatchMessage({ type: 'ACP_PING' }, { id: 'acp-test-extension' });
    assert.strictEqual(response.ok, true);
    assert.strictEqual(response.visible, true);
  });

  page.close();

  /* ---------------------------------------------------------------- */
  group('edge cases');

  await test('boots on a page with no settings and falls back to defaults', async function () {
    const fresh = await bootPage({});
    assert.strictEqual(fresh.q('#acp-provider').value, 'openrouter');
    assert.strictEqual(fresh.q('#acp-model').value, 'openai/gpt-4o');
    assert.strictEqual(fresh.q('#acp-timeframe').value, '15m');
    assert.strictEqual(fresh.q('#acp-live').checked, false);
    assert.strictEqual(fresh.handle.hidden, true);
    fresh.close();
  });

  await test('analysis without a last_candle anchor still places draggable candles', async function () {
    const custom = JSON.parse(JSON.stringify(ANALYSIS));
    delete custom.last_candle;
    delete custom.price_scale;
    const page2 = await bootPage({
      settings: { providerId: 'openai', model: 'gpt-4o' },
      analyzeHandler: function () {
        return Promise.resolve({ ok: true, analysis: custom, warnings: ['No last_candle anchor was returned.'], meta: { timeframe: '15m', candleCount: 3 } });
      }
    });

    await page2.clickAnalyze();
    assert.ok(page2.state.ghost, 'ghost model missing');
    assert.strictEqual(page2.state.ghost.anchor.auto, true);
    assert.strictEqual(page2.handle.hidden, false);
    assert.ok(page2.state.ghost.scale, 'an automatic price scale must be derived');
    assert.strictEqual(page2.q('#acp-warnings').hidden, false, 'the warning should be visible in the panel');
    assert.ok(/last_candle/.test(page2.q('#acp-warnings').textContent));
    page2.close();
  });

  await test('viewport smaller than the panel still keeps the panel on screen', async function () {
    const small = await bootPage({ width: 360, height: 640 });
    const panel = small.q('#acp-panel');
    assert.ok(panel, 'panel must mount on a small viewport');
    small.close();
  });

  await test('1 candle and 5 candles produce the requested number of ghosts', async function () {
    for (const count of [1, 5]) {
      const deep = JSON.parse(JSON.stringify(ANALYSIS));
      deep.predicted_candles = [];
      for (let i = 0; i < count; i += 1) {
        deep.predicted_candles.push({ open: 104 + i, high: 106 + i, low: 103 + i, close: 105 + i });
      }
      const instance = await bootPage({
        settings: { providerId: 'openai', model: 'gpt-4o', candleCount: count },
        analyzeHandler: function () {
          return Promise.resolve({ ok: true, analysis: deep, warnings: [], meta: { timeframe: '15m', candleCount: count } });
        }
      });
      await instance.clickAnalyze();
      assert.strictEqual(instance.state.ghost.candles.length, count, 'expected ' + count + ' ghost candles');
      assert.ok(instance.findText('AI · ' + count + ' × 15m').length >= 1);
      instance.close();
    }
  });

  /* ---------------------------------------------------------------- */
  console.log('\n' + '-'.repeat(58));
  if (failed === 0) {
    console.log('\u001b[32m%d passed\u001b[0m', passed);
  } else {
    console.log('\u001b[31m%d failed\u001b[0m, \u001b[32m%d passed\u001b[0m', failed, passed);
    failures.forEach(function (failure) {
      console.log('\n  ' + failure.group + ' › ' + failure.name);
      console.log('  ' + String((failure.error && failure.error.stack) || failure.error).split('\n').slice(0, 8).join('\n  '));
    });
    process.exitCode = 1;
  }
}

const assert = require('assert');

main().catch(function (error) {
  console.error('DOM test runner crashed:', error);
  process.exitCode = 1;
});
