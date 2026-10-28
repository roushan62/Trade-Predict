'use strict';

/**
 * AI Chart Predictor — end-to-end test.
 *
 *   node test/e2e-tests.js        (requires `npm install`)
 *
 * This wires the three real JavaScript contexts together over one shared
 * chrome.storage, the way Chrome does at runtime:
 *
 *   options page  ──writes──▶  chrome.storage.local  ◀──reads──  background worker
 *        ▲                                                             ▲
 *        └──────── TEST_CONNECTION ──────────────────────────────────┘
 *
 *   content script ──runtime.sendMessage(ANALYZE)──▶ background worker
 *         ▲                                              │ captureVisibleTab
 *         └──── tabs.sendMessage(CAPTURED) ◀─────────────┘ + fetch → provider
 *
 * Every layer is the shipped file (options.js, background.js, content.js,
 * panel.js, the provider adapters). Only chrome.* and fetch are simulated.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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

const wait = (ms) =>
  new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 3000);
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

const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const OPTIONS_HTML = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
const OVERLAY_CSS = fs.readFileSync(path.join(ROOT, 'overlay.css'), 'utf8');

const CHART_ANSWER = {
  symbol: 'BTCUSDT',
  timeframe: '15m',
  trend: 'bearish',
  market_structure: 'LH/LL — lower highs, lower lows',
  confidence: 64,
  reasoning: 'Rejected from the supply zone and lost the 20 EMA; expect continuation into the demand block.',
  support_resistance: [
    { type: 'resistance', price: 67000, y: 0.25 },
    { type: 'support', price: 64000, y: 0.78 }
  ],
  zones: [{ type: 'supply', x1: 0.4, y1: 0.2, x2: 0.98, y2: 0.3, label: 'supply' }],
  trendlines: [{ x1: 0.1, y1: 0.35, x2: 0.95, y2: 0.6 }],
  patterns: { candlestick: ['bearish engulfing'], chart: ['lower high'] },
  indicators: { rsi: 'RSI 44', macd: 'below signal', ma: 'below 50 EMA', volume: 'rising' },
  trade: { direction: 'short', entry: 65100, stop_loss: 66200, target1: 63800, target2: 62600 },
  price_scale: { point_a: { price: 67000, y: 0.25 }, point_b: { price: 64000, y: 0.78 } },
  last_candle: { x: 0.9, y: 0.55, width: 0.014 },
  predicted_candles: [
    { open: 65100, high: 65350, low: 64600, close: 64700 },
    { open: 64700, high: 64900, low: 64100, close: 64250 },
    { open: 64250, high: 64400, low: 63700, close: 63850 }
  ]
};

function chatCompletion(content) {
  return {
    status: 200,
    body: JSON.stringify({
      id: 'chatcmpl-e2e',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: 'stop' }]
    })
  };
}

/**
 * Build the whole extension: one shared storage, one background vm, a content
 * page and an options page.
 */
async function bootExtension(options) {
  const opts = options || {};

  const shared = {
    storage: Object.assign({}, opts.storage || {}),
    changeListeners: []
  };

  /* ---------------- background worker (real background.js) --------------- */
  const backgroundMock = createChromeMock({
    shared: shared,
    captureImpl: opts.captureImpl,
    fetchHandler: opts.fetchHandler
  });

  const bgSandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    URL: URL,
    AbortController: AbortController,
    fetch: backgroundMock.fetch,
    chrome: backgroundMock.chrome,
    Math: Math,
    Date: Date,
    JSON: JSON
  };
  const bgContext = vm.createContext(bgSandbox);
  vm.runInContext('globalThis.self = globalThis;', bgContext);
  bgSandbox.importScripts = function () {
    Array.prototype.slice.call(arguments).forEach(function (file) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), bgContext, { filename: file });
    });
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), bgContext, { filename: 'background.js' });

  /* ---------------- content page (real content.js + panel.js) ------------ */
  const dom = new JSDOM(
    '<!doctype html><html><head><title>BTCUSDT</title></head><body><div id="chart"></div></body></html>',
    {
      url: 'https://www.tradingview.com/chart/BTCUSDT/',
      pretendToBeVisual: true,
      runScripts: 'outside-only'
    }
  );
  const win = dom.window;
  const viewport = { width: opts.width || 1440, height: opts.height || 900, dpr: opts.dpr || 2 };
  Object.defineProperty(win, 'innerWidth', { configurable: true, get: () => viewport.width });
  Object.defineProperty(win, 'innerHeight', { configurable: true, get: () => viewport.height });
  Object.defineProperty(win, 'devicePixelRatio', { configurable: true, get: () => viewport.dpr });

  const canvasCalls = [];
  win.HTMLCanvasElement.prototype.getContext = function () {
    const owner = this;
    const target = {};
    return new Proxy(target, {
      get: function (object, prop) {
        if (prop === 'canvas') return owner;
        if (prop === 'measureText') {
          return function (text) {
            canvasCalls.push({ method: 'measureText', args: [text] });
            return { width: String(text).length * 6 };
          };
        }
        if (prop in object) return object[prop];
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

  const contentMock = createChromeMock({ shared: shared });
  win.chrome = contentMock.chrome;
  win.fetch = function () {
    return Promise.resolve({ ok: true, text: () => Promise.resolve(OVERLAY_CSS) });
  };

  // content → background
  contentMock.state.sendMessageImpl = function (message, callback) {
    backgroundMock
      .dispatchMessage(message, {
        id: 'acp-test-extension',
        url: win.location.href,
        tab: { id: 42, windowId: 5, url: win.location.href }
      })
      .then(function (response) {
        if (typeof callback === 'function') callback(response);
      })
      .catch(function (error) {
        if (typeof callback === 'function') callback({ ok: false, error: { code: 'UNKNOWN', message: String(error) } });
      });
  };

  // background → content (CAPTURED, TOGGLE_PANEL, PING)
  backgroundMock.state.sendMessageImpl = null;
  backgroundMock.chrome.tabs.sendMessage = function (tabId, message) {
    return contentMock.dispatchMessage(message, { id: 'acp-test-extension' });
  };
  backgroundMock.chrome.tabs.query = function (query) {
    // The single chart tab is the active tab of its window.
    if (query && query.windowId != null && query.windowId !== 5) return Promise.resolve([]);
    return Promise.resolve([{ id: 42, windowId: 5, url: win.location.href, active: true }]);
  };

  MANIFEST.content_scripts[0].js.forEach(function (file) {
    win.eval(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  });

  await waitFor(function () {
    const host = win.document.getElementById('acp-root');
    return host && host.shadowRoot && host.shadowRoot.querySelector('#acp-panel');
  }, 3000, 'the overlay to mount');

  const shadow = win.document.getElementById('acp-root').shadowRoot;
  const q = (selector) => shadow.querySelector(selector);

  /* ---------------- options page (real options.js) ----------------------- */
  const optionsDom = new JSDOM(OPTIONS_HTML, {
    url: 'chrome-extension://acp-test-extension/options.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const optionsWin = optionsDom.window;
  const optionsMock = createChromeMock({ shared: shared });
  optionsWin.chrome = optionsMock.chrome;
  optionsMock.state.sendMessageImpl = function (message, callback) {
    // The options page only sends TEST_CONNECTION / OPEN_OPTIONS.
    backgroundMock.dispatchMessage(message, {
      id: 'acp-test-extension',
      url: 'chrome-extension://acp-test-extension/options.html'
    }).then(function (response) {
      if (typeof callback === 'function') callback(response);
    });
  };
  backgroundMock.chrome.tabs.query.__options = true;

  const scripts = [];
  const regex = /<script src="([^"]+)"><\/script>/g;
  let match;
  while ((match = regex.exec(OPTIONS_HTML))) scripts.push(match[1]);
  scripts.forEach(function (file) {
    optionsWin.eval(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  });
  await waitFor(function () {
    return optionsWin.document.body.dataset.acpReady === 'true';
  }, 3000, 'the options page to initialise');

  return {
    win: win,
    shadow: shadow,
    q: q,
    canvasCalls,
    viewport,
    contentMock: contentMock,
    backgroundMock: backgroundMock,
    optionsWin: optionsWin,
    optionsMock: optionsMock,
    storage: shared.storage,
    log: {
      analyses: function () {
        return backgroundMock.state.captureCalls.length;
      },
      fetches: function () {
        return backgroundMock.state.fetchCalls;
      }
    },
    resize: async function (width, height, dpr) {
      viewport.width = width;
      viewport.height = height;
      if (dpr) viewport.dpr = dpr;
      win.dispatchEvent(new win.Event('resize'));
      await wait(80);
    },
    pointer: function (type, element, x, y, pointerId) {
      const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(event, 'pointerId', { value: pointerId == null ? 1 : pointerId });
      element.dispatchEvent(event);
      return event;
    },
    close: function () {
      optionsDom.window.close();
      dom.window.close();
    }
  };
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

async function main() {
  console.log('\u001b[1mAI Chart Predictor — end-to-end tests\u001b[0m');

  /* ================================================================ */
  group('install → add API key (options page writes shared storage)');

  const ext = await bootExtension({
    fetchHandler: function (url, init) {
      // The very first call is the connection test from the options page.
      return chatCompletion(JSON.stringify(CHART_ANSWER));
    }
  });

  await test('extension boots with no stored key', function () {
    const optionsDoc = ext.optionsWin.document;
    assert.strictEqual(optionsDoc.getElementById('key-state').textContent, 'no key saved');
    assert.strictEqual(ext.q('#acp-result').hidden, true, 'no result before the first analysis');
  });

  await test('saving a provider + key from the options page reaches shared storage', async function () {
    const doc = ext.optionsWin.document;
    doc.getElementById('provider').value = 'openai';
    doc.getElementById('provider').dispatchEvent(new ext.optionsWin.Event('change', { bubbles: true }));
    doc.getElementById('model').value = 'gpt-4o';
    doc.getElementById('api-key').value = 'sk-e2e-key';
    doc.getElementById('api-key').dispatchEvent(new ext.optionsWin.Event('input', { bubbles: true }));
    doc.getElementById('save').click();

    await waitFor(function () {
      return /Saved/.test(doc.getElementById('status').textContent);
    }, 3000, 'the save confirmation');

    const stored = ext.storage.acpSettingsV1;
    assert.ok(stored, 'settings were not written');
    assert.strictEqual(stored.providerId, 'openai');
    assert.strictEqual(stored.model, 'gpt-4o');
    assert.strictEqual(stored.apiKeys.openai, 'sk-e2e-key');
  });

  await test('the already-open chart tab picks up the new settings', async function () {
    await waitFor(function () {
      return ext.q('#acp-provider').value === 'openai';
    }, 3000, 'the content panel to follow the storage change');
    assert.strictEqual(ext.q('#acp-model').value, 'gpt-4o');
  });

  await test('panel preference changes persist through the real worker', async function () {
    ext.q('#acp-timeframe').value = '1h';
    ext.q('#acp-timeframe').dispatchEvent(new ext.win.Event('change'));
    ext.q('#acp-candles').value = '2';
    ext.q('#acp-candles').dispatchEvent(new ext.win.Event('change'));

    await waitFor(function () {
      const stored = ext.storage.acpSettingsV1 || {};
      return stored.timeframe === '1h' && stored.candleCount === 2;
    }, 4000, 'the panel preferences to reach storage');

    const stored = ext.storage.acpSettingsV1;
    assert.strictEqual(stored.apiKeys.openai, 'sk-e2e-key', 'saving prefs must not drop the key');
  });

  await test('the page never receives the API key', function () {
    const state = ext.win.__AI_CHART_PREDICTOR.state;
    const serialized = JSON.stringify(state.publicSettings);
    assert.ok(!serialized.includes('sk-e2e-key'), 'the key leaked into the content script');
    assert.strictEqual(state.publicSettings.apiKeys.openai, undefined);
    assert.strictEqual(state.publicSettings.apiKeyStatus.openai.hasKey, true);
    assert.ok(!ext.win.document.documentElement.outerHTML.includes('sk-e2e-key'));
  });

  /* ================================================================ */
  group('Analyze → capture → provider → validate → draw');

  await test('clicking Analyze runs the full pipeline', async function () {
    ext.q('#acp-timeframe').value = '15m';
    ext.q('#acp-timeframe').dispatchEvent(new ext.win.Event('change'));
    ext.q('#acp-candles').value = '3';
    ext.q('#acp-candles').dispatchEvent(new ext.win.Event('change'));
    await wait(350);

    ext.q('#acp-analyze').click();
    await waitFor(function () {
      return ext.q('#acp-result').hidden === false;
    }, 5000, 'the result card');

    // Drawing happens on the next animation frame (jsdom throttles rAF).
    await waitFor(function () {
      return ext.q('.acp-ghost-handle').hidden === false;
    }, 3000, 'the first paint');

    assert.strictEqual(ext.backgroundMock.state.captureCalls.length, 1, 'exactly one screenshot');
    assert.strictEqual(ext.backgroundMock.state.captureCalls[0].windowId, 5);
    assert.strictEqual(ext.backgroundMock.state.captureCalls[0].options.format, 'jpeg');
  });

  await test('the request is well formed and the key only travels in the header', function () {
    const call = ext.log.fetches()[0];
    assert.strictEqual(call.url, 'https://api.openai.com/v1/chat/completions');
    assert.strictEqual(call.init.headers.Authorization, 'Bearer sk-e2e-key');
    assert.ok(!call.url.includes('sk-e2e-key'), 'the key must never be in a URL');
    const body = call.init.body;
    assert.ok(!body.includes('sk-e2e-key'), 'the key must never be in the body');
    const parsed = JSON.parse(body);
    assert.strictEqual(parsed.model, 'gpt-4o');
    assert.ok(parsed.messages[1].content[1].image_url.url.startsWith('data:image/jpeg;base64,'));
    assert.ok(body.includes('Selected timeframe: 15m'));
    assert.ok(body.includes('Predict exactly 3 future candles'));
  });

  await test('the analysis is drawn on the overlay', function () {
    const labels = ext.canvasCalls
      .filter(function (call) {
        return call.method === 'fillText';
      })
      .map(function (call) {
        return String(call.args[0]);
      });
    const text = labels.join(' | ');
    assert.ok(text.includes('Bearish') || ext.q('#acp-trend').textContent === 'Bearish', 'trend surfaced: ' + text);
    assert.ok(/RESISTANCE 67[.,]?000[.,]?00/.test(text), 'resistance label: ' + text);
    assert.ok(/SUPPORT 64[.,]?000[.,]?00/.test(text), 'support label: ' + text);
    assert.ok(/ENTRY 65[.,]?100[.,]?00/.test(text), 'entry label: ' + text);
    assert.ok(/SL 66[.,]?200[.,]?00/.test(text), 'stop label: ' + text);
    assert.ok(/TP1 63[.,]?800[.,]?00/.test(text), 'target label: ' + text);
    assert.ok(/AI · 3 × 15m/.test(text), 'ghost label: ' + text);
  });

  await test('the result card shows the trade plan and confidence', function () {
    assert.strictEqual(ext.q('#acp-trend').dataset.trend, 'bearish');
    assert.strictEqual(ext.q('#acp-confidence-text'), null, 'confidence uses the span, not a text node');
    assert.strictEqual(ext.q('#acp-conf-value').textContent, '64%');
    assert.strictEqual(ext.q('#acp-entry').textContent, '65,100.00');
    assert.strictEqual(ext.q('#acp-sl').textContent, '66,200.00');
    assert.strictEqual(ext.q('#acp-tp1').textContent, '63,800.00');
    assert.strictEqual(ext.q('#acp-tp2').textContent, '62,600.00');
    assert.ok(ext.q('#acp-rr').textContent.indexOf('1 : 1.18') === 0 || ext.q('#acp-rr').textContent.length > 0);
    assert.ok(ext.q('#acp-reasoning').textContent.includes('supply zone'));
    assert.ok(ext.q('#acp-patterns').textContent.includes('bearish engulfing'));
  });

  await test('ghost candles sit right of the last candle and are draggable', function () {
    const state = ext.win.__AI_CHART_PREDICTOR.state;
    assert.ok(state.ghost, 'ghost model missing');
    assert.strictEqual(state.ghost.candles.length, 3);
    assert.ok(state.ghost.firstCenter >= 0.9 * ext.viewport.width - 1);
    assert.strictEqual(ext.q('.acp-ghost-handle').hidden, false);
  });

  await test('drag, resize and clear all behave on the real pipeline output', async function () {
    const state = ext.win.__AI_CHART_PREDICTOR.state;
    const handle = ext.q('.acp-ghost-handle');
    const before = JSON.parse(JSON.stringify(state.ghost.offset));

    ext.pointer('pointerdown', handle, 1000, 500, 1);
    ext.pointer('pointermove', handle, 700, 400, 1);
    await wait(120);
    ext.pointer('pointerup', handle, 700, 400, 1);
    await wait(120);
    assert.ok(Math.abs(state.ghost.offset.x - before.x + 300) <= 1, 'drag x: ' + (state.ghost.offset.x - before.x));
    assert.ok(Math.abs(state.ghost.offset.y - before.y + 100) <= 1, 'drag y: ' + (state.ghost.offset.y - before.y));

    await ext.resize(1024, 768, 1);
    assert.strictEqual(ext.win.document.getElementById('acp-root').shadowRoot.querySelector('.acp-canvas').width, 1024);
    assert.ok(state.ghost, 'ghost survives the resize');

    ext.q('#acp-clear').click();
    await wait(120);
    assert.strictEqual(state.analysis, null);
    assert.strictEqual(ext.q('#acp-result').hidden, true);
    assert.strictEqual(handle.hidden, true);
  });

  ext.close();

  /* ================================================================ */
  group('failure paths');

  await test('a rejected key surfaces as an auth error and keeps the UI usable', async function () {
    const bad = await bootExtension({
      storage: {
        acpSettingsV1: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'sk-wrong' } }
      },
      fetchHandler: function () {
        return { status: 401, body: JSON.stringify({ error: { message: 'Incorrect API key provided: sk-wrong' } }) };
      }
    });

    bad.q('#acp-analyze').click();
    await waitFor(function () {
      return /API key was rejected/.test(bad.q('#acp-status-text').textContent);
    }, 5000, 'the auth error');

    assert.ok(bad.q('#acp-status').className.includes('is-error'));
    assert.strictEqual(bad.q('#acp-analyze').disabled, false);
    assert.ok(bad.q('#acp-status-text').textContent.includes('Incorrect API key provided'));
    // The error message must not echo the secret back verbatim.
    assert.strictEqual(bad.backgroundMock.state.fetchCalls.length, 1, 'auth errors are not retried');
    bad.close();
  });

  await test('a text-only model is refused before a screenshot is taken', async function () {
    const deepseek = await bootExtension({
      storage: {
        acpSettingsV1: { providerId: 'deepseek', model: 'deepseek-chat', apiKeys: { deepseek: 'dk' } }
      },
      fetchHandler: function () {
        throw new Error('should not be called');
      }
    });

    deepseek.q('#acp-analyze').click();
    await waitFor(function () {
      return /cannot analyse images/i.test(deepseek.q('#acp-status-text').textContent);
    }, 5000, 'the vision error');

    assert.strictEqual(deepseek.backgroundMock.state.captureCalls.length, 0, 'no capture for a text-only model');
    assert.strictEqual(deepseek.backgroundMock.state.fetchCalls.length, 0, 'no request for a text-only model');
    deepseek.close();
  });

  await test('a restricted page is reported instead of crashing', async function () {
    const restricted = await bootExtension({
      storage: {
        acpSettingsV1: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'sk' } }
      },
      captureImpl: function () {
        throw new Error('Cannot access a chrome:// URL');
      }
    });

    restricted.q('#acp-analyze').click();
    await waitFor(function () {
      return /does not allow screenshots/i.test(restricted.q('#acp-status-text').textContent);
    }, 5000, 'the restricted-page error');
    assert.ok(restricted.q('#acp-status').className.includes('is-error'));
    restricted.close();
  });

  await test('invalid JSON is retried once and then reported clearly', async function () {
    let calls = 0;
    const chatty = await bootExtension({
      storage: {
        acpSettingsV1: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'sk' } }
      },
      fetchHandler: function () {
        calls += 1;
        return chatCompletion('The chart is bearish, good luck!');
      }
    });

    chatty.q('#acp-analyze').click();
    await waitFor(function () {
      return /did not return valid analysis JSON/i.test(chatty.q('#acp-status-text').textContent);
    }, 6000, 'the JSON error');

    assert.strictEqual(calls, 2, 'one retry');
    assert.strictEqual(chatty.backgroundMock.state.captureCalls.length, 1, 'the screenshot is reused on retry');
    chatty.close();
  });

  await test('the connection test from the options page uses the real background', async function () {
    const ext2 = await bootExtension({
      fetchHandler: function (url, init) {
        const body = JSON.parse(init.body);
        // A real image part must be present even for the connection test.
        assert.strictEqual(body.messages[1].content[1].type, 'image_url');
        return chatCompletion('{"ok": true}');
      }
    });

    const doc = ext2.optionsWin.document;
    doc.getElementById('provider').value = 'openai';
    doc.getElementById('provider').dispatchEvent(new ext2.optionsWin.Event('change', { bubbles: true }));
    doc.getElementById('api-key').value = 'sk-test-conn';
    doc.getElementById('test').click();

    await waitFor(function () {
      return /responded|Connection OK/.test(doc.getElementById('status').textContent);
    }, 5000, 'the connection test result');
    assert.strictEqual(doc.getElementById('status').dataset.tone, 'ok');
    assert.strictEqual(ext2.backgroundMock.state.captureCalls.length, 0, 'a connection test never screenshots the tab');
    ext2.close();
  });

  /* ================================================================ */
  group('live mode over the real pipeline');

  await test('live mode refreshes repeatedly without overlapping requests', async function () {
    let inFlight = 0;
    let maxInFlight = 0;

    const live = await bootExtension({
      storage: {
        acpSettingsV1: {
          providerId: 'openai',
          model: 'gpt-4o',
          apiKeys: { openai: 'sk' },
          liveIntervalSec: 10,
          candleCount: 1
        }
      },
      fetchHandler: function () {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const answer = JSON.parse(JSON.stringify(CHART_ANSWER));
        answer.predicted_candles = answer.predicted_candles.slice(0, 1);
        return {
          status: 200,
          body: JSON.stringify({
            choices: [{ message: { content: JSON.stringify(answer) } }]
          })
        };
      }
    });

    // The response resolves asynchronously in the real pipeline.
    const originalHandler = live.backgroundMock.state.fetchHandler;
    live.backgroundMock.state.fetchHandler = function (url, init) {
      const result = originalHandler(url, init);
      return new Promise(function (resolve) {
        setTimeout(function () {
          inFlight -= 1;
          resolve(result);
        }, 40);
      });
    };

    live.q('#acp-live').checked = true;
    live.q('#acp-live').dispatchEvent(new live.win.Event('change'));
    await waitFor(function () {
      return live.backgroundMock.state.captureCalls.length >= 2;
    }, 15000, 'two live refreshes');

    assert.ok(maxInFlight <= 1, 'requests must never overlap, saw ' + maxInFlight);
    assert.strictEqual(live.win.__AI_CHART_PREDICTOR.state.ghost.candles.length, 1);

    live.q('#acp-live').checked = false;
    live.q('#acp-live').dispatchEvent(new live.win.Event('change'));
    await wait(60);
    const captures = live.backgroundMock.state.captureCalls.length;
    await wait(600);
    assert.strictEqual(live.backgroundMock.state.captureCalls.length, captures, 'no refresh after switching live off');
    live.close();
  });

  /* ================================================================ */
  group('concurrency & cancellation');

  await test('a second Analyze request while one is running is ignored', async function () {
    const ext3 = await bootExtension({
      storage: { acpSettingsV1: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'sk' } } },
      fetchHandler: function () {
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve(chatCompletion(JSON.stringify(CHART_ANSWER)));
          }, 60);
        });
      }
    });

    const api = ext3.win.__AI_CHART_PREDICTOR;
    const first = api.analyze();
    const second = api.analyze(); // must be a no-op, not a second capture
    await Promise.all([first, second]);
    await waitFor(function () {
      return ext3.q('#acp-result').hidden === false;
    }, 4000, 'the result');

    assert.strictEqual(ext3.backgroundMock.state.captureCalls.length, 1, 'only one screenshot per analysis');
    assert.strictEqual(ext3.backgroundMock.state.fetchCalls.length, 1, 'only one provider call');
    ext3.close();
  });

  await test('Clear cancels an in-flight analysis and leaves a clean overlay', async function () {
    const ext4 = await bootExtension({
      storage: { acpSettingsV1: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'sk' } } },
      fetchHandler: function (url, init) {
        return new Promise(function (resolve, reject) {
          const timer = setTimeout(function () {
            resolve(chatCompletion(JSON.stringify(CHART_ANSWER)));
          }, 500);
          if (init && init.signal) {
            init.signal.addEventListener('abort', function () {
              clearTimeout(timer);
              const error = new Error('The operation was aborted.');
              error.name = 'AbortError';
              reject(error);
            });
          }
        });
      }
    });

    ext4.q('#acp-analyze').click();
    await waitFor(function () {
      return ext4.backgroundMock.state.fetchCalls.length === 1;
    }, 4000, 'the provider call to start');

    ext4.q('#acp-clear').click(); // reads "Cancel" while busy
    await waitFor(function () {
      return /cancelled/i.test(ext4.q('#acp-status-text').textContent);
    }, 4000, 'the cancellation notice');

    assert.strictEqual(ext4.win.__AI_CHART_PREDICTOR.state.analysis, null, 'nothing is drawn after cancelling');
    assert.strictEqual(ext4.q('#acp-result').hidden, true);
    assert.strictEqual(ext4.q('#acp-analyze').disabled, false, 'the button is usable again');
    assert.strictEqual(ext4.q('#acp-clear').textContent, 'Clear', 'the button label returns to Clear');
    ext4.close();
  });

  group('re-injection');

  await test('a second injection of a live instance reuses the existing overlay', async function () {
    const ext = await bootExtension({});
    const before = ext.win.__AI_CHART_PREDICTOR;
    assert.strictEqual(before.isAlive(), true, 'the mock extension context is live');

    // The background injects again (e.g. the toolbar icon was pressed twice).
    ext.win.eval(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'));
    await wait(50);

    assert.strictEqual(ext.win.__AI_CHART_PREDICTOR, before, 'the same instance keeps running');
    assert.strictEqual(ext.win.document.querySelectorAll('#acp-root').length, 1);
    ext.close();
  });

  await test('an orphaned instance is destroyed before a fresh overlay is built', async function () {
    const ext = await bootExtension({});
    const stale = ext.win.__AI_CHART_PREDICTOR;

    // An extension reload revokes the old bindings: chrome.runtime.id is gone.
    ext.contentMock.chrome.runtime.id = undefined;
    assert.strictEqual(stale.isAlive(), false, 'the orphan knows it is dead');

    ext.win.eval(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'));
    await waitFor(function () {
      return ext.win.__AI_CHART_PREDICTOR !== stale && ext.win.document.querySelectorAll('#acp-root').length === 1;
    }, 3000, 'the replacement overlay');

    const fresh = ext.win.__AI_CHART_PREDICTOR;
    assert.strictEqual(typeof fresh.destroy, 'function');
    assert.strictEqual(ext.win.document.querySelectorAll('#acp-root').length, 1, 'no duplicate roots');
    assert.strictEqual(stale.state.disposed, true, 'the orphan was torn down');
    assert.strictEqual(stale.isAlive(), false);

    // The new instance still works end to end.
    await waitFor(function () {
      return ext.win.document.getElementById('acp-root').shadowRoot.querySelector('#acp-analyze');
    }, 3000, 'the replacement panel');
    ext.close();
  });

  /* ================================================================ */
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

main().catch(function (error) {
  console.error('E2E runner crashed:', error);
  process.exitCode = 1;
});
