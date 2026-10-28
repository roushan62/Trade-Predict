'use strict';

/**
 * AI Chart Predictor — headless unit / integration tests.
 *
 *   node test/run-tests.js
 *
 * No dependencies: the extension sources are loaded into a Node `vm` context
 * together with the chrome.* mock from test/mock-chrome.js, then exercised
 * through the real message router in background.js.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const { createChromeMock, ROOT } = require('./mock-chrome');

/* ------------------------------------------------------------------ *
 * Tiny test runner
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const SENDER = {
  id: 'acp-test-extension',
  url: 'https://www.tradingview.com/chart/',
  tab: { id: 7, windowId: 3, url: 'https://www.tradingview.com/chart/' }
};

const EXTENSION_SENDER = {
  id: 'acp-test-extension',
  url: 'chrome-extension://acp-test-extension/options.html'
};

const VALID_ANALYSIS = {
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
  trade: { direction: 'long', entry: 104, stop_loss: 100, target1: 110, target2: 115 },
  price_scale: { point_a: { price: 110, y: 0.3 }, point_b: { price: 100, y: 0.7 } },
  last_candle: { x: 0.85, y: 0.5, width: 0.015 },
  predicted_candles: [
    { open: 104, high: 106, low: 103, close: 105 },
    { open: 105, high: 107, low: 104, close: 106 },
    { open: 106, high: 108, low: 105, close: 107 }
  ]
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function chatResponse(content) {
  return {
    status: 200,
    body: JSON.stringify({
      id: 'chatcmpl-test',
      choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: 'stop' }]
    })
  };
}

function geminiResponse(text) {
  return {
    status: 200,
    body: JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: text }] }, finishReason: 'STOP' }]
    })
  };
}

function anthropicResponse(text) {
  return {
    status: 200,
    body: JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: text }],
      stop_reason: 'end_turn'
    })
  };
}

const silentConsole = {
  log: function () {},
  warn: function () {},
  error: function () {},
  info: function () {},
  debug: function () {}
};

/** Load background.js (and, through importScripts, every dependency) in a vm. */
function loadBackground(mock) {
  const sandbox = {
    console: silentConsole,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    URL: URL,
    AbortController: AbortController,
    fetch: mock.fetch,
    chrome: mock.chrome,
    Math: Math,
    Date: Date,
    JSON: JSON
  };

  const context = vm.createContext(sandbox);
  vm.runInContext('globalThis.self = globalThis;', context);

  sandbox.importScripts = function () {
    const files = Array.prototype.slice.call(arguments);
    files.forEach(function (file) {
      const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
      vm.runInContext(code, context, { filename: file });
    });
  };

  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  vm.runInContext(background, context, { filename: 'background.js' });
  return context;
}

function makeBackend(options) {
  const opts = options || {};
  const storage = {};
  if (opts.settings) storage.acpSettingsV1 = opts.settings;
  const mock = createChromeMock({
    storage: storage,
    activeTabId: opts.activeTabId,
    captureImpl: opts.captureImpl,
    fetchHandler: opts.fetchHandler
  });
  const context = loadBackground(mock);
  return {
    mock: mock,
    context: context,
    ACP: context.ACP,
    settings: context.ACP.settings,
    providers: context.ACP.providers,
    schema: context.ACP.schema,
    coords: context.ACP.coords,
    prompt: context.ACP.prompt,
    dispatch: mock.dispatchMessage,
    analyze: function (payload, sender) {
      return mock.dispatchMessage(
        {
          type: 'ACP_ANALYZE',
          payload: Object.assign({ requestId: 'req_' + Math.random().toString(36).slice(2, 8) }, payload || {})
        },
        sender || SENDER
      );
    }
  };
}

/* ------------------------------------------------------------------ *
 * 1. Manifest
 * ------------------------------------------------------------------ */

async function testManifest() {
  group('manifest.json');

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  await test('is Manifest V3 with a service worker', function () {
    assert.strictEqual(manifest.manifest_version, 3);
    assert.ok(manifest.background && manifest.background.service_worker, 'service_worker missing');
    assert.strictEqual(manifest.background.type, undefined, 'background.type should be omitted');
  });

  await test('declares the required permissions', function () {
    ['activeTab', 'tabs', 'storage', 'scripting'].forEach(function (permission) {
      assert.ok(manifest.permissions.includes(permission), 'missing permission ' + permission);
    });
    assert.ok(
      manifest.host_permissions.includes('<all_urls>'),
      'host_permissions must allow any provider + any chart page'
    );
  });

  await test('registers the command Alt+Shift+A', function () {
    assert.ok(manifest.commands['toggle-panel'], 'toggle-panel command missing');
    assert.strictEqual(manifest.commands['toggle-panel'].suggested_key.default, 'Alt+Shift+A');
  });

  await test('every referenced file exists', function () {
    const files = [];
    Object.keys(manifest.icons).forEach(function (size) {
      files.push(manifest.icons[size]);
    });
    files.push(manifest.background.service_worker);
    files.push(manifest.options_ui.page);
    (manifest.content_scripts || []).forEach(function (entry) {
      (entry.js || []).forEach(function (file) {
        files.push(file);
      });
      (entry.css || []).forEach(function (file) {
        files.push(file);
      });
    });
    (manifest.web_accessible_resources || []).forEach(function (entry) {
      (entry.resources || []).forEach(function (resource) {
        if (resource.indexOf('*') >= 0) return;
        files.push(resource);
      });
    });

    files.forEach(function (file) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), 'missing file: ' + file);
    });
  });

  await test('content_scripts match ACP.CONTENT_SCRIPTS', function () {
    const mock = createChromeMock({});
    const context = loadBackground(mock);
    const declared = manifest.content_scripts[0].js;
    // JSON comparison: the vm context has its own Array prototype.
    assert.strictEqual(JSON.stringify(declared), JSON.stringify(Array.from(context.ACP.CONTENT_SCRIPTS)));
  });

  await test('manifest fields satisfy the Chrome Web Store constraints', function () {
    assert.ok(/^\d+(\.\d+){0,3}$/.test(manifest.version), 'version must be 1-4 dot-separated integers');
    assert.ok(manifest.name.length <= 75, 'name is limited to 75 characters');
    assert.ok(manifest.description.length <= 132, 'description is limited to 132 characters');
    assert.ok(manifest.minimum_chrome_version, 'minimum_chrome_version must be set');
    assert.strictEqual(manifest.options_ui.open_in_tab, true);

    const knownPermissions = new Set([
      'activeTab', 'tabs', 'storage', 'scripting', 'alarms', 'notifications', 'contextMenus',
      'downloads', 'identity', 'idle', 'unlimitedStorage', 'webNavigation', 'cookies'
    ]);
    manifest.permissions.forEach(function (permission) {
      assert.ok(knownPermissions.has(permission), 'unexpected permission: ' + permission);
    });

    const validPattern = /^(\*|https?|file|ftp):\/\/.*\/$|^<all_urls>$/;
    assert.ok(manifest.host_permissions.every(function (pattern) { return validPattern.test(pattern); }));

    const validKey = /^(Ctrl|Alt|Command|MacCtrl)?(\+Shift)?(\+[A-Z0-9])$|^(Ctrl|Alt|Command|MacCtrl)\+[A-Z0-9]$/;
    const key = manifest.commands['toggle-panel'].suggested_key.default;
    assert.ok(validKey.test(key) || /^[A-Z]$/.test(key), 'invalid shortcut: ' + key);
  });

  await test('icons are valid PNG files', function () {
    Object.keys(manifest.icons).forEach(function (size) {
      const file = path.join(ROOT, manifest.icons[size]);
      const buffer = fs.readFileSync(file);
      assert.strictEqual(buffer.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'bad PNG signature: ' + file);
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      assert.strictEqual(width, Number(size));
      assert.strictEqual(height, Number(size));
    });
  });

  await test('all JavaScript files parse (node --check)', function () {
    const files = execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT }).toString().trim().split('\n').filter(Boolean);
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '*.js'], { cwd: ROOT })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    const all = files.concat(untracked).filter(function (file) {
      return file.indexOf('node_modules/') !== 0;
    });
    assert.ok(all.length >= 15, 'expected to find the extension sources, got ' + all.length);
    all.forEach(function (file) {
      execFileSync('node', ['--check', path.join(ROOT, file)]);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 2. JSON validator / schema
 * ------------------------------------------------------------------ */

async function testSchema() {
  group('utils/schema.js (JSON validator)');

  const ctx = makeBackend({});
  const schema = ctx.schema;

  await test('accepts a clean JSON object', function () {
    const result = schema.parseAnalysis(JSON.stringify(VALID_ANALYSIS), { timeframe: '15m', candleCount: 3 });
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.strictEqual(result.analysis.trend, 'bullish');
    assert.strictEqual(result.analysis.confidence, 72);
    assert.strictEqual(result.analysis.predicted_candles.length, 3);
    assert.strictEqual(result.analysis.trade.risk_reward, '1 : 1.50');
    assert.strictEqual(result.analysis.support_resistance[0].type, 'support');
  });

  await test('extracts JSON from markdown fences and prose', function () {
    const wrapped = 'Sure! Here is the analysis:\n```json\n' + JSON.stringify(VALID_ANALYSIS) + '\n```\nGood luck.';
    const result = schema.parseAnalysis(wrapped, { timeframe: '15m', candleCount: 3 });
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.strictEqual(result.analysis.trend, 'bullish');
  });

  await test('repairs trailing commas', function () {
    const broken = JSON.stringify(VALID_ANALYSIS).replace(/}$/, ',}');
    const result = schema.parseAnalysis(broken, { timeframe: '15m', candleCount: 3 });
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.ok(result.warnings.join(' ').indexOf('repairs') >= 0);
  });

  await test('rejects a reply without JSON', function () {
    const result = schema.parseAnalysis('The market looks bullish to me.', { candleCount: 1 });
    assert.strictEqual(result.ok, false);
    assert.ok(/not valid JSON/i.test(result.errors[0]), result.errors.join(' '));
  });

  await test('rejects a wrong trend value', function () {
    const bad = clone(VALID_ANALYSIS);
    bad.trend = 'sideways-ish';
    const result = schema.parseAnalysis(JSON.stringify(bad), { candleCount: 3 });
    assert.strictEqual(result.ok, false);
    assert.ok(/trend/i.test(result.errors[0]));
  });

  await test('rejects missing predicted candles', function () {
    const bad = clone(VALID_ANALYSIS);
    delete bad.predicted_candles;
    const result = schema.parseAnalysis(JSON.stringify(bad), { candleCount: 3 });
    assert.strictEqual(result.ok, false);
    assert.ok(/predicted_candles/i.test(result.errors[0]));
  });

  await test('pads fewer candles than requested', function () {
    const short = clone(VALID_ANALYSIS);
    short.predicted_candles = short.predicted_candles.slice(0, 1);
    const result = schema.parseAnalysis(JSON.stringify(short), { candleCount: 3 });
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.strictEqual(result.analysis.predicted_candles.length, 3);
    assert.ok(result.warnings.join(' ').indexOf('Asked for 3') >= 0);
  });

  await test('truncates extra candles', function () {
    const many = clone(VALID_ANALYSIS);
    while (many.predicted_candles.length < 8) many.predicted_candles.push({ open: 1, high: 2, low: 0.5, close: 1.5 });
    const result = schema.parseAnalysis(JSON.stringify(many), { candleCount: 2 });
    assert.ok(result.ok);
    assert.strictEqual(result.analysis.predicted_candles.length, 2);
  });

  await test('parses numeric strings and percentages', function () {
    const messy = clone(VALID_ANALYSIS);
    messy.confidence = '0.81';
    messy.trade = { direction: 'long', entry: '104.50', stop_loss: '100', target1: '110', target2: '115' };
    messy.support_resistance = [
      { type: 'support', price: '100', y: 70 },
      { type: 'resistance', price: '110', y: 30 }
    ];
    messy.price_scale = { point_a: { price: '110', y: 30 }, point_b: { price: '100', y: 70 } };
    messy.last_candle = { x: 85, y: 50, width: 1.5 };
    messy.zones = [{ type: 'demand', x1: 10, y1: 65, x2: 90, y2: 75 }];

    const result = schema.parseAnalysis(JSON.stringify(messy), { candleCount: 3 });
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.strictEqual(result.analysis.confidence, 81);
    assert.strictEqual(result.analysis.trade.entry, 104.5);
    assert.ok(Math.abs(result.analysis.support_resistance[0].y - 0.7) < 1e-9);
    assert.ok(Math.abs(result.analysis.last_candle.x - 0.85) < 1e-9);
    assert.ok(Math.abs(result.analysis.zones[0].x1 - 0.1) < 1e-9);
    assert.ok(Math.abs(result.analysis.price_scale.point_a.y - 0.3) < 1e-9);
  });

  await test('repairs inverted candles instead of rejecting them', function () {
    const odd = clone(VALID_ANALYSIS);
    odd.predicted_candles = [{ open: 105, high: 104, low: 107, close: 106 }];
    const result = schema.parseAnalysis(JSON.stringify(odd), { candleCount: 1 });
    assert.ok(result.ok, JSON.stringify(result.errors));
    const candle = result.analysis.predicted_candles[0];
    assert.ok(candle.high >= Math.max(candle.open, candle.close));
    assert.ok(candle.low <= Math.min(candle.open, candle.close));
  });

  await test('unwraps {analysis:{...}} envelopes and array roots', function () {
    const wrapped = schema.parseAnalysis(JSON.stringify({ analysis: VALID_ANALYSIS }), { candleCount: 3 });
    assert.ok(wrapped.ok, JSON.stringify(wrapped.errors));
    const arrayRoot = schema.parseAnalysis(JSON.stringify([VALID_ANALYSIS]), { candleCount: 3 });
    assert.ok(arrayRoot.ok, JSON.stringify(arrayRoot.errors));
  });

  await test('defaults confidence when missing and normalises labels', function () {
    const noConfidence = clone(VALID_ANALYSIS);
    delete noConfidence.confidence;
    const result = schema.parseAnalysis(JSON.stringify(noConfidence), { candleCount: 3 });
    assert.ok(result.ok);
    assert.strictEqual(result.analysis.confidence, 50);
    assert.ok(result.warnings.join(' ').toLowerCase().indexOf('confidence') >= 0);
  });

  await test('extractJson handles empty input and nested braces in strings', function () {
    assert.strictEqual(schema.extractJson('').ok, false);
    const tricky = '{"a":"}{ not json","b":{"c":1}}';
    const extracted = schema.extractJson('prefix ' + tricky + ' suffix');
    assert.ok(extracted.ok);
    assert.deepStrictEqual(extracted.value, { a: '}{ not json', b: { c: 1 } });
  });
}

/* ------------------------------------------------------------------ *
 * 3. Coordinate mapper
 * ------------------------------------------------------------------ */

async function testCoords() {
  group('utils/coords.js (coordinate mapper)');

  const ctx = makeBackend({});
  const coords = ctx.coords;

  await test('asNumber understands prices, percentages and junk', function () {
    assert.strictEqual(coords.asNumber('64,250.50'), 64250.5);
    assert.strictEqual(coords.asNumber('$1,234.5'), 1234.5);
    assert.strictEqual(coords.asNumber('75%'), 75);
    assert.strictEqual(coords.asNumber(12), 12);
    assert.strictEqual(coords.asNumber('abc'), null);
    assert.strictEqual(coords.asNumber(null), null);
    assert.strictEqual(coords.asNumber(''), null);
  });

  await test('buildPriceScale maps prices to pixels and back', function () {
    const scale = coords.buildPriceScale({
      point_a: { price: 110, y: 0.3 },
      point_b: { price: 100, y: 0.7 }
    });
    assert.ok(scale);
    assert.ok(Math.abs(scale.yFor(110) - 0.3) < 1e-9);
    assert.ok(Math.abs(scale.yFor(100) - 0.7) < 1e-9);
    assert.ok(Math.abs(scale.yFor(105) - 0.5) < 1e-9);
    assert.ok(Math.abs(scale.priceFor(0.5) - 105) < 1e-6);
    assert.ok(scale.slope < 0, 'prices rise upwards, so the slope must be negative');
  });

  await test('buildPriceScale rejects degenerate input', function () {
    assert.strictEqual(coords.buildPriceScale(null), null);
    assert.strictEqual(coords.buildPriceScale({ point_a: { price: 10, y: 0.5 }, point_b: { price: 10, y: 0.6 } }), null);
    assert.strictEqual(coords.buildPriceScale({ point_a: { price: 10, y: 0.5 } }), null);
  });

  await test('scaleFromLevels picks the widest pair', function () {
    const scale = coords.scaleFromLevels([
      { price: 101, y: 0.48 },
      { price: 100, y: 0.5 },
      { price: 110, y: 0.2 }
    ]);
    assert.ok(scale);
    assert.ok(Math.abs(scale.yFor(110) - 0.2) < 1e-9);
    assert.ok(Math.abs(scale.yFor(100) - 0.5) < 1e-9);
  });

  await test('autoFitScale stretches candles around the anchor', function () {
    const candles = [
      { open: 100, high: 104, low: 98, close: 103 },
      { open: 103, high: 108, low: 102, close: 107 }
    ];
    const scale = coords.autoFitScale(candles, 0.5, 0.1);
    assert.ok(scale);
    const topY = scale.yFor(108);
    const bottomY = scale.yFor(98);
    assert.ok(topY < 0.5 && bottomY > 0.5, 'high must map above the anchor, low below');
    assert.ok(bottomY - topY < 0.25);
  });

  await test('normToPx / pxToNorm round-trip with clamping', function () {
    assert.strictEqual(coords.normToPx(0.5, 800), 400);
    assert.strictEqual(coords.normToPx(2, 800), 800);
    assert.strictEqual(coords.pxToNorm(400, 800), 0.5);
    assert.strictEqual(coords.pxToNorm(-10, 800), 0);
    assert.strictEqual(coords.pxToNorm(10, 0), 0);
  });
}

/* ------------------------------------------------------------------ *
 * 4. Settings store
 * ------------------------------------------------------------------ */

async function testSettings() {
  group('utils/settings.js');

  const ctx = makeBackend({});
  const settings = ctx.settings;

  await test('normalize fills defaults and rejects invalid values', function () {
    const config = settings.normalize({
      timeframe: '7h',
      candleCount: 99,
      liveIntervalSec: 7,
      providerId: '',
      apiKeys: { openai: '  sk-123  ', gemini: '   ', bad: 42 }
    });
    assert.strictEqual(config.timeframe, '15m');
    assert.strictEqual(config.candleCount, 3);
    assert.strictEqual(config.liveIntervalSec, 30);
    assert.strictEqual(config.providerId, 'openrouter');
    assert.deepStrictEqual(config.apiKeys, { openai: 'sk-123' });
  });

  await test('write + read round-trip', async function () {
    const written = await settings.write({ providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'sk-test' } });
    assert.strictEqual(written.providerId, 'openai');
    const readBack = await settings.read();
    assert.strictEqual(readBack.model, 'gpt-4o');
    assert.strictEqual(readBack.apiKeys.openai, 'sk-test');
  });

  await test('patch merges without dropping other keys', async function () {
    await settings.write({ providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'sk-a', gemini: 'g-b' } });
    await settings.patch({ timeframe: '1h' });
    const current = await settings.read();
    assert.strictEqual(current.timeframe, '1h');
    assert.strictEqual(current.apiKeys.openai, 'sk-a');
    assert.strictEqual(current.apiKeys.gemini, 'g-b');
  });

  await test('redact never exposes API keys', async function () {
    await settings.write({ apiKeys: { openai: 'sk-secret-value' } });
    const publicSettings = await settings.getPublic();
    assert.ok(!JSON.stringify(publicSettings).includes('sk-secret-value'));
    assert.strictEqual(publicSettings.apiKeyStatus.openai.hasKey, true);
    assert.ok(publicSettings.apiKeyStatus.openai.hint.endsWith('alue'));
  });

  await test('setApiKey adds and removes keys', async function () {
    await settings.setApiKey('groq', 'gsk-1');
    assert.strictEqual((await settings.read()).apiKeys.groq, 'gsk-1');
    await settings.setApiKey('groq', '');
    assert.strictEqual((await settings.read()).apiKeys.groq, undefined);
  });

  await test('an unknown stored provider falls back to the default', function () {
    const config = settings.normalize({ providerId: 'provider-that-was-removed', model: 'x' });
    assert.strictEqual(config.providerId, 'openrouter');
  });

  await test('deepMerge ignores prototype pollution keys', function () {
    const merged = settings.deepMerge({ a: 1 }, JSON.parse('{"__proto__":{"polluted":true},"b":2}'));
    assert.strictEqual(merged.b, 2);
    assert.strictEqual({}.polluted, undefined);
  });
}

/* ------------------------------------------------------------------ *
 * 5. Provider adapters
 * ------------------------------------------------------------------ */

async function testProviders() {
  group('providers/*');

  const ctx = makeBackend({});
  const providers = ctx.providers;

  const DATA_URL = 'data:image/jpeg;base64,QUJD';
  const PROMPT = 'analyse this';

  const ids = ['openrouter', 'openai', 'gemini', 'anthropic', 'deepseek', 'mistral', 'groq', 'xai', 'custom'];

  await test('all nine providers are registered', function () {
    const registered = providers.list().map(function (provider) {
      return provider.id;
    });
    ids.forEach(function (id) {
      assert.ok(registered.includes(id), 'missing provider ' + id);
    });
  });

  await test('every provider exposes the adapter interface', function () {
    providers.list().forEach(function (provider) {
      assert.strictEqual(typeof provider.buildRequest, 'function', provider.id + '.buildRequest');
      assert.strictEqual(typeof provider.parseResponse, 'function', provider.id + '.parseResponse');
      assert.ok(Array.isArray(provider.models), provider.id + '.models');
      assert.ok(provider.id === 'custom' || provider.defaultModel, provider.id + '.defaultModel');
    });
  });

  await test('OpenAI request is a chat completion with an image part', function () {
    const built = providers.get('openai').buildRequest({
      apiKey: 'sk-openai',
      model: 'gpt-4o',
      dataUrl: DATA_URL,
      prompt: PROMPT
    });
    assert.strictEqual(built.url, 'https://api.openai.com/v1/chat/completions');
    assert.strictEqual(built.init.headers.Authorization, 'Bearer sk-openai');
    const body = JSON.parse(built.init.body);
    assert.strictEqual(body.model, 'gpt-4o');
    assert.strictEqual(body.messages[0].role, 'system');
    const parts = body.messages[1].content;
    assert.strictEqual(parts[0].type, 'text');
    assert.strictEqual(parts[1].type, 'image_url');
    assert.strictEqual(parts[1].image_url.url, DATA_URL);
    assert.deepStrictEqual(body.response_format, { type: 'json_object' });
  });

  await test('OpenAI reasoning models get max_completion_tokens and no temperature', function () {
    const built = providers.get('openai').buildRequest({
      apiKey: 'sk-openai',
      model: 'o3',
      dataUrl: DATA_URL,
      prompt: PROMPT
    });
    const body = JSON.parse(built.init.body);
    assert.strictEqual(body.max_tokens, undefined);
    assert.ok(body.max_completion_tokens > 0);
    assert.strictEqual(body.temperature, undefined);
    assert.strictEqual(body.response_format, undefined);
  });

  await test('OpenRouter adds attribution headers and keeps the key private to itself', function () {
    const built = providers.get('openrouter').buildRequest({
      apiKey: 'sk-or',
      model: 'anthropic/claude-3.5-sonnet',
      dataUrl: DATA_URL,
      prompt: PROMPT
    });
    assert.strictEqual(built.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(built.init.headers.Authorization, 'Bearer sk-or');
    assert.strictEqual(built.init.headers['X-Title'], 'AI Chart Predictor');
    const body = JSON.parse(built.init.body);
    assert.strictEqual(body.model, 'anthropic/claude-3.5-sonnet');
    assert.strictEqual(body.response_format, undefined);
  });

  await test('Gemini uses generateContent with inline_data and an x-goog-api-key header', function () {
    const built = providers.get('gemini').buildRequest({
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
      dataUrl: 'data:image/png;base64,QUJD',
      prompt: PROMPT
    });
    assert.ok(
      built.url.indexOf('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent') === 0,
      built.url
    );
    assert.ok(!built.url.includes('gemini-key'), 'the key must never be in the URL');
    assert.strictEqual(built.init.headers['x-goog-api-key'], 'gemini-key');
    const body = JSON.parse(built.init.body);
    assert.strictEqual(body.contents[0].parts[0].inline_data.mime_type, 'image/png');
    assert.strictEqual(body.contents[0].parts[0].inline_data.data, 'QUJD');
    assert.strictEqual(body.contents[0].parts[1].text, PROMPT);
    assert.strictEqual(body.generationConfig.responseMimeType, 'application/json');
    assert.ok(body.systemInstruction.parts[0].text.length > 20);
  });

  await test('Anthropic uses the messages API with a base64 image block', function () {
    const built = providers.get('anthropic').buildRequest({
      apiKey: 'sk-ant',
      model: 'claude-3-5-sonnet-latest',
      dataUrl: 'data:image/jpeg;base64,QUJD',
      prompt: PROMPT
    });
    assert.strictEqual(built.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(built.init.headers['x-api-key'], 'sk-ant');
    assert.strictEqual(built.init.headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(built.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    const body = JSON.parse(built.init.body);
    assert.strictEqual(body.model, 'claude-3-5-sonnet-latest');
    assert.strictEqual(body.messages[0].content[0].type, 'image');
    assert.strictEqual(body.messages[0].content[0].source.media_type, 'image/jpeg');
    assert.strictEqual(body.messages[0].content[0].source.data, 'QUJD');
    assert.strictEqual(body.messages[0].content[1].type, 'text');
    assert.ok(typeof body.system === 'string' && body.system.length > 20);
  });

  await test('Anthropic coerces unsupported mime types to jpeg', function () {
    const built = providers.get('anthropic').buildRequest({
      apiKey: 'k',
      model: 'claude-3-5-sonnet-latest',
      dataUrl: 'data:image/bmp;base64,QUJD',
      prompt: PROMPT
    });
    const body = JSON.parse(built.init.body);
    assert.strictEqual(body.messages[0].content[0].source.media_type, 'image/jpeg');
  });

  await test('custom provider normalises the base URL and allows an empty key', function () {
    const built = providers.get('custom').buildRequest({
      apiKey: '',
      model: 'llava',
      baseUrl: 'http://localhost:11434/v1/',
      dataUrl: DATA_URL,
      prompt: PROMPT
    });
    assert.strictEqual(built.url, 'http://localhost:11434/v1/chat/completions');
    assert.strictEqual(built.init.headers.Authorization, undefined);
  });

  await test('custom provider repairs a pasted /chat/completions URL', function () {
    const built = providers.get('custom').buildRequest({
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://api.example.com/v1/chat/completions',
      dataUrl: DATA_URL,
      prompt: PROMPT
    });
    assert.strictEqual(built.url, 'https://api.example.com/v1/chat/completions');
  });

  await test('parseResponse reads every response shape', function () {
    assert.strictEqual(
      providers.get('openai').parseResponse({ choices: [{ message: { content: '{"a":1}' } }] }),
      '{"a":1}'
    );
    assert.strictEqual(
      providers.get('openai').parseResponse({ choices: [{ message: { content: [{ type: 'text', text: 'hi' }] } }] }),
      'hi'
    );
    assert.strictEqual(
      providers.get('gemini').parseResponse({ candidates: [{ content: { parts: [{ text: 'g' }] } }] }),
      'g'
    );
    assert.strictEqual(
      providers.get('anthropic').parseResponse({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
      'a\nb'
    );
    assert.strictEqual(providers.get('openai').parseResponse({}), '');
    assert.strictEqual(providers.get('gemini').parseResponse({}), '');
  });

  await test('visionInfo flags text-only models and accepts vision models', function () {
    assert.strictEqual(providers.visionInfo('deepseek', 'deepseek-chat').status, 'unsupported');
    assert.strictEqual(providers.visionInfo('openai', 'gpt-3.5-turbo').status, 'unsupported');
    assert.strictEqual(providers.visionInfo('openai', 'gpt-4o').status, 'supported');
    assert.strictEqual(providers.visionInfo('gemini', 'gemini-1.5-flash').status, 'supported');
    assert.strictEqual(providers.visionInfo('anthropic', 'claude-3-5-sonnet-latest').status, 'supported');
    assert.strictEqual(providers.visionInfo('groq', 'llama-3.3-70b-versatile').status, 'unsupported');
    assert.strictEqual(providers.visionInfo('groq', 'meta-llama/llama-4-scout-17b-16e-instruct').status, 'supported');
    assert.strictEqual(providers.visionInfo('openrouter', 'some-company/vision-pro-2').status, 'supported');
    assert.strictEqual(providers.visionInfo('openrouter', 'some-company/mystery-model').status, 'unknown');
    assert.strictEqual(providers.visionInfo('nope', 'x').status, 'unknown');
  });

  await test('dataUrlToParts splits mime type and payload', function () {
    const parts = providers.dataUrlToParts(DATA_URL);
    assert.strictEqual(parts.mimeType, 'image/jpeg');
    assert.strictEqual(parts.base64, 'QUJD');
    assert.strictEqual(providers.dataUrlToParts('nope'), null);
  });

  await test('normalizeBaseUrl trims and prefixes schemes', function () {
    assert.strictEqual(providers.normalizeBaseUrl('api.example.com/v1/'), 'https://api.example.com/v1');
    assert.strictEqual(providers.normalizeBaseUrl('https://x.dev/v1/messages'), 'https://x.dev/v1');
    assert.strictEqual(providers.normalizeBaseUrl('  '), '');
  });
}

/* ------------------------------------------------------------------ *
 * 6. Prompt
 * ------------------------------------------------------------------ */

async function testPrompt() {
  group('utils/prompt.js');

  const ctx = makeBackend({});
  const prompt = ctx.prompt;

  await test('prompt carries timeframe, candle count and an example schema', function () {
    const text = prompt.build({ timeframe: '4h', candleCount: 2 });
    assert.ok(text.includes('Selected timeframe: 4h'));
    assert.ok(text.includes('Predict exactly 2 future candles'));
    assert.ok(text.includes('"predicted_candles"'));
    const parsed = JSON.parse(text.slice(text.indexOf('{', text.indexOf('this shape')), text.lastIndexOf('}') + 1));
    assert.strictEqual(parsed.timeframe, '4h');
    assert.strictEqual(parsed.predicted_candles.length, 2);
    assert.ok(prompt.system.includes('COORDINATE SYSTEM'));
  });

  await test('repair prompt includes the previous errors', function () {
    const text = prompt.buildRepair(
      { timeframe: '1h', candleCount: 1 },
      ['"trend" must be one of "bullish", "bearish" or "sideways".'],
      '{"trend":"moon"}'
    );
    assert.ok(text.includes('YOUR PREVIOUS ANSWER WAS REJECTED'));
    assert.ok(text.includes('"trend" must be one of'));
    assert.ok(text.includes('{"trend":"moon"}'));
    assert.ok(text.includes('Selected timeframe: 1h'));
  });

  await test('candle count is clamped to 1..5', function () {
    assert.ok(prompt.build({ timeframe: '1m', candleCount: 99 }).includes('Predict exactly 5 future candles'));
    assert.ok(prompt.build({ timeframe: '1m', candleCount: 0 }).includes('Predict exactly 1 future candle'));
  });
}

/* ------------------------------------------------------------------ *
 * 7. background.js — message router + analysis pipeline
 * ------------------------------------------------------------------ */

async function testBackground() {
  group('background.js (capture → provider → validate)');

  await test('PING answers with the version', async function () {
    const backend = makeBackend({});
    const response = await backend.dispatch({ type: 'ACP_PING' }, SENDER);
    assert.ok(response && response.ok);
    assert.strictEqual(response.version, backend.ACP.VERSION);
  });

  await test('refuses to analyse without an API key (no capture, no fetch)', async function () {
    const backend = makeBackend({});
    const response = await backend.analyze({});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'NO_API_KEY');
    assert.strictEqual(backend.mock.state.captureCalls.length, 0);
    assert.strictEqual(backend.mock.state.fetchCalls.length, 0);
  });

  await test('happy path: capture → OpenRouter → strict JSON → analysis', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openrouter', model: 'openai/gpt-4o', apiKeys: { openrouter: 'sk-or-test' } },
      fetchHandler: function () {
        return chatResponse(JSON.stringify(VALID_ANALYSIS));
      }
    });

    const response = await backend.analyze({ timeframe: '15m', candleCount: 3, imageWidth: 1512, imageHeight: 850 });
    assert.strictEqual(response.ok, true, JSON.stringify(response.error));
    assert.strictEqual(response.analysis.trend, 'bullish');
    assert.strictEqual(response.analysis.predicted_candles.length, 3);
    assert.strictEqual(response.meta.providerId, 'openrouter');
    assert.strictEqual(response.meta.attempt, 1);
    assert.strictEqual(response.meta.timeframe, '15m');
    assert.ok(response.meta.latencyMs >= 0);

    assert.strictEqual(backend.mock.state.captureCalls.length, 1);
    assert.strictEqual(backend.mock.state.captureCalls[0].options.format, 'jpeg');
    assert.strictEqual(backend.mock.state.captureCalls[0].windowId, 3);

    const call = backend.mock.state.fetchCalls[0];
    assert.strictEqual(call.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(call.init.headers.Authorization, 'Bearer sk-or-test');
    const body = JSON.parse(call.init.body);
    assert.strictEqual(body.model, 'openai/gpt-4o');
    assert.ok(call.init.body.includes('1512 x 850'), 'screenshot size should be passed to the model');
    assert.ok(call.init.body.includes('Selected timeframe: 15m'));
  });

  await test('invalid JSON triggers exactly one repair retry, then fails cleanly', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'sk-test' } },
      fetchHandler: function () {
        return chatResponse('I cannot answer in JSON, sorry.');
      }
    });

    const response = await backend.analyze({ candleCount: 1 });
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'BAD_JSON');
    assert.strictEqual(backend.mock.state.fetchCalls.length, 2, 'one initial call + one retry');
    const secondBody = JSON.parse(backend.mock.state.fetchCalls[1].init.body);
    assert.ok(JSON.stringify(secondBody).includes('YOUR PREVIOUS ANSWER WAS REJECTED'));
    assert.strictEqual(backend.mock.state.captureCalls.length, 1, 'the screenshot must be reused, not recaptured');
  });

  await test('retry recovers when the second answer is valid', async function () {
    let calls = 0;
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'sk-test' } },
      fetchHandler: function () {
        calls += 1;
        return calls === 1 ? chatResponse('nope') : chatResponse(JSON.stringify(VALID_ANALYSIS));
      }
    });

    const response = await backend.analyze({ candleCount: 3 });
    assert.strictEqual(response.ok, true, JSON.stringify(response.error));
    assert.strictEqual(response.meta.attempt, 2);
    assert.ok(response.warnings.length >= 0);
  });

  await test('401 maps to an AUTH error without retrying', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'bad' } },
      fetchHandler: function () {
        return { status: 401, body: JSON.stringify({ error: { message: 'Incorrect API key provided' } }) };
      }
    });

    const response = await backend.analyze({});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'AUTH');
    assert.ok(/API key was rejected/i.test(response.error.message));
    assert.ok(response.error.message.includes('Incorrect API key provided'));
    assert.strictEqual(backend.mock.state.fetchCalls.length, 1);
  });

  await test('429 is retried once and surfaces RATE_LIMIT if it persists', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'k' } },
      fetchHandler: function () {
        return { status: 429, body: JSON.stringify({ error: { message: 'Rate limit reached' } }) };
      }
    });

    const startedAt = Date.now();
    const response = await backend.analyze({});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'RATE_LIMIT');
    assert.strictEqual(backend.mock.state.fetchCalls.length, 2, 'transient errors get one retry');
    assert.ok(Date.now() - startedAt >= 1400, 'retry should back off');
  });

  await test('5xx is retried once, then reported as SERVER', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'k' } },
      fetchHandler: function () {
        return { status: 503, body: '<html>Service Unavailable</html>' };
      }
    });

    const response = await backend.analyze({});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'SERVER');
    assert.strictEqual(backend.mock.state.fetchCalls.length, 2);
  });

  await test('a non-JSON 200 response maps to EMPTY_RESPONSE', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'k' } },
      fetchHandler: function () {
        return { status: 200, body: '<html>login required</html>' };
      }
    });
    const response = await backend.analyze({});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'EMPTY_RESPONSE');
  });

  await test('provider errors never echo a credential-shaped token', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'sk-supersecretkey123' } },
      fetchHandler: function () {
        return {
          status: 401,
          body: JSON.stringify({ error: { message: 'Incorrect API key provided: sk-supersecretkey123' } })
        };
      }
    });

    const response = await backend.analyze({});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'AUTH');
    assert.ok(!response.error.message.includes('sk-supersecretkey123'), response.error.message);
    assert.ok(response.error.message.includes('[redacted]'), response.error.message);
  });

  await test('network failure maps to NETWORK', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'k' } },
      fetchHandler: function () {
        throw new TypeError('Failed to fetch');
      }
    });

    const response = await backend.analyze({});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'NETWORK');
  });

  await test('restricted page capture error maps to RESTRICTED_PAGE', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'k' } },
      captureImpl: function () {
        throw new Error('The activeTab permission is not granted / cannot access a chrome:// URL');
      }
    });

    const response = await backend.analyze({});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'RESTRICTED_PAGE');
    assert.strictEqual(backend.mock.state.fetchCalls.length, 0);
  });

  await test('switching tabs during analysis is refused (TAB_NOT_ACTIVE)', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'k' } },
      activeTabId: 99
    });
    const response = await backend.analyze({});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'TAB_NOT_ACTIVE');
    assert.strictEqual(backend.mock.state.captureCalls.length, 0);
  });

  await test('text-only models are blocked before any capture', async function () {
    const backend = makeBackend({
      settings: { providerId: 'deepseek', model: 'deepseek-chat', apiKeys: { deepseek: 'k' } }
    });
    const response = await backend.analyze({});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'MODEL_NO_VISION');
    assert.strictEqual(backend.mock.state.captureCalls.length, 0);
  });

  await test('custom provider without a base URL is rejected', async function () {
    const backend = makeBackend({ settings: { providerId: 'custom', model: 'llava' } });
    const response = await backend.analyze({});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'MISSING_BASE_URL');
  });

  await test('Gemini end-to-end uses generateContent and parses candidates', async function () {
    const backend = makeBackend({
      settings: { providerId: 'gemini', model: 'gemini-2.0-flash', apiKeys: { gemini: 'g-key' } },
      fetchHandler: function () {
        return geminiResponse(JSON.stringify(VALID_ANALYSIS));
      }
    });

    const response = await backend.analyze({ candleCount: 2 });
    assert.strictEqual(response.ok, true, JSON.stringify(response.error));
    assert.strictEqual(response.analysis.predicted_candles.length, 2);
    const call = backend.mock.state.fetchCalls[0];
    assert.ok(call.url.includes(':generateContent'));
    assert.strictEqual(call.init.headers['x-goog-api-key'], 'g-key');
  });

  await test('Anthropic end-to-end parses text blocks', async function () {
    const backend = makeBackend({
      settings: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest', apiKeys: { anthropic: 'a-key' } },
      fetchHandler: function () {
        return anthropicResponse(JSON.stringify(VALID_ANALYSIS));
      }
    });

    const response = await backend.analyze({});
    assert.strictEqual(response.ok, true, JSON.stringify(response.error));
    const call = backend.mock.state.fetchCalls[0];
    assert.strictEqual(call.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(call.init.headers['x-api-key'], 'a-key');
  });

  await test('a markdown-fenced answer from a chatty model is still accepted', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'k' } },
      fetchHandler: function () {
        return chatResponse('```json\n' + JSON.stringify(VALID_ANALYSIS) + '\n```');
      }
    });
    const response = await backend.analyze({});
    assert.strictEqual(response.ok, true, JSON.stringify(response.error));
  });

  await test('CANCEL aborts an in-flight analysis', async function () {
    let sawAbort = false;
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'k' } },
      fetchHandler: function (url, init) {
        return new Promise(function (resolve, reject) {
          init.signal.addEventListener('abort', function () {
            sawAbort = true;
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }
    });

    const pending = backend.analyze({ requestId: 'cancel-me' });
    await new Promise(function (resolve) {
      setTimeout(resolve, 60);
    });
    const cancelResponse = await backend.dispatch({ type: 'ACP_CANCEL', requestId: 'cancel-me' }, SENDER);
    assert.strictEqual(cancelResponse.ok, true);
    assert.strictEqual(cancelResponse.cancelled, true);

    const response = await pending;
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'CANCELLED');
    assert.strictEqual(sawAbort, true);
  });

  await test('TEST_CONNECTION uses a 1x1 probe image', async function () {
    let capturedBody = null;
    const backend = makeBackend({
      fetchHandler: function (url, init) {
        capturedBody = JSON.parse(init.body);
        return chatResponse('{"ok": true}');
      }
    });

    const response = await backend.dispatch(
      {
        type: 'ACP_TEST_CONNECTION',
        payload: { providerId: 'openai', model: 'gpt-4o', apiKey: 'sk-typed' }
      },
      EXTENSION_SENDER
    );

    assert.strictEqual(response.ok, true, JSON.stringify(response.error));
    assert.ok(response.message.includes('OpenAI'));
    assert.strictEqual(capturedBody.model, 'gpt-4o');
    const imageUrl = capturedBody.messages[1].content[1].image_url.url;
    assert.ok(imageUrl.startsWith('data:image/png;base64,'));
    assert.ok(imageUrl.length < 200, 'probe image should be tiny');
  });

  await test('TEST_CONNECTION reports a bad key', async function () {
    const backend = makeBackend({
      fetchHandler: function () {
        return { status: 401, body: JSON.stringify({ error: { message: 'invalid x-api-key' } }) };
      }
    });
    const response = await backend.dispatch(
      { type: 'ACP_TEST_CONNECTION', payload: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest', apiKey: 'nope' } },
      EXTENSION_SENDER
    );
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'AUTH');
  });

  await test('GET_SETTINGS returns a redacted public document', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'sk-super-secret' } }
    });
    const response = await backend.dispatch({ type: 'ACP_GET_SETTINGS' }, SENDER);
    assert.strictEqual(response.ok, true);
    assert.strictEqual(response.settings.providerId, 'openai');
    assert.ok(!JSON.stringify(response).includes('sk-super-secret'));
    assert.strictEqual(response.settings.apiKeyStatus.openai.hasKey, true);
    assert.strictEqual(response.settings.apiKeys.openai, undefined);
  });

  await test('SAVE_SETTINGS is allowed for extension pages', async function () {
    const backend = makeBackend({});

    const saved = await backend.dispatch(
      { type: 'ACP_SAVE_SETTINGS', settings: { timeframe: '4h', candleCount: 2, providerId: 'gemini', model: 'gemini-2.0-flash' } },
      EXTENSION_SENDER
    );
    assert.strictEqual(saved.ok, true, JSON.stringify(saved.error));
    assert.strictEqual(saved.settings.timeframe, '4h');

    const stored = backend.mock.readSettings();
    assert.strictEqual(stored.timeframe, '4h');
    assert.strictEqual(stored.candleCount, 2);
  });

  await test('the floating panel (content script) may save preferences', async function () {
    const backend = makeBackend({ settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'keep' } } });

    // Content-script senders carry sender.tab and the *page* URL.
    const response = await backend.dispatch(
      { type: 'ACP_SAVE_SETTINGS', settings: { timeframe: '30m', candleCount: 4, panel: { left: 120, top: 80 } } },
      SENDER
    );
    assert.strictEqual(response.ok, true, JSON.stringify(response.error));
    const stored = backend.mock.readSettings();
    assert.strictEqual(stored.timeframe, '30m');
    assert.strictEqual(stored.candleCount, 4);
    assert.strictEqual(stored.panel.left, 120);
    assert.strictEqual(stored.apiKeys.openai, 'keep');
  });

  await test('a sender that is neither an extension page nor a tab is rejected', async function () {
    const backend = makeBackend({});
    const response = await backend.dispatch(
      { type: 'ACP_SAVE_SETTINGS', settings: { timeframe: '1h' } },
      { id: 'acp-test-extension', url: 'https://evil.example/' }
    );
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'FORBIDDEN');
  });

  await test('SAVE_SETTINGS cannot be used to inject API keys', async function () {
    const backend = makeBackend({ settings: { apiKeys: { openai: 'keep-me' } } });
    await backend.dispatch(
      { type: 'ACP_SAVE_SETTINGS', settings: { apiKeys: { evil: 'x' }, timeframe: '1D' } },
      EXTENSION_SENDER
    );
    const stored = backend.mock.readSettings();
    assert.strictEqual(stored.apiKeys.openai, 'keep-me');
    assert.strictEqual(stored.apiKeys.evil, undefined);
  });

  await test('messages from a foreign extension id are ignored', async function () {
    const backend = makeBackend({});
    const response = await backend.dispatch({ type: 'ACP_PING' }, { id: 'other-extension' });
    assert.strictEqual(response, undefined);
  });

  await test('payload provider/model override the saved defaults', async function () {
    let body = null;
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'k-openai', gemini: 'k-gemini' } },
      fetchHandler: function (url, init) {
        body = JSON.parse(init.body);
        return geminiResponse(JSON.stringify(VALID_ANALYSIS));
      }
    });

    const response = await backend.analyze({ providerId: 'gemini', model: 'gemini-2.5-pro' });
    assert.strictEqual(response.ok, true, JSON.stringify(response.error));
    assert.strictEqual(response.meta.providerId, 'gemini');
    assert.strictEqual(response.meta.model, 'gemini-2.5-pro');
    assert.ok(body);
  });

  await test('toggling on a restricted page shows a badge and injects nothing', async function () {
    const backend = makeBackend({});
    backend.mock.chrome.tabs.query = function () {
      return Promise.resolve([{ id: 7, windowId: 3, url: 'chrome://extensions/' }]);
    };

    const response = await backend.dispatch({ type: 'ACP_TOGGLE_PANEL' }, EXTENSION_SENDER);
    assert.strictEqual(response.ok, true);
    assert.ok(backend.mock.state.badgeCalls.length >= 1, 'a badge explains the failure');
    assert.strictEqual(backend.mock.state.executedScripts.length, 0, 'no injection on chrome://');
  });

  await test('toggling on a normal page injects the overlay when it is not there yet', async function () {
    const backend = makeBackend({});
    // Simulate a tab that was open before the extension was installed/reloaded.
    backend.mock.chrome.tabs.sendMessage = function () {
      return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    };

    const response = await backend.dispatch({ type: 'ACP_TOGGLE_PANEL' }, EXTENSION_SENDER);
    assert.strictEqual(response.ok, true);
    assert.strictEqual(backend.mock.state.executedScripts.length, 1, 'the content script is injected');
    assert.deepStrictEqual(
      Array.from(backend.mock.state.executedScripts[0].files),
      Array.from(backend.ACP.CONTENT_SCRIPTS),
      'the whole content-script bundle is injected in order'
    );
    assert.strictEqual(
      backend.mock.state.injectedCss.length,
      0,
      'overlay.css is loaded inside the shadow root, so the host page is never restyled'
    );
  });

  await test('an empty payload model falls back to the provider default', async function () {
    let body = null;
    const backend = makeBackend({
      settings: { providerId: 'openai', model: '', apiKeys: { openai: 'k' } },
      fetchHandler: function (url, init) {
        body = JSON.parse(init.body);
        return chatResponse(JSON.stringify(VALID_ANALYSIS));
      }
    });
    const response = await backend.analyze({});
    assert.strictEqual(response.ok, true, JSON.stringify(response.error));
    assert.strictEqual(body.model, 'gpt-4o');
  });

  await test('empty model response maps to EMPTY_RESPONSE', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'k' } },
      fetchHandler: function () {
        return chatResponse('');
      }
    });
    const response = await backend.analyze({});
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'EMPTY_RESPONSE');
  });

  await test('payload image size is forwarded, screenshot is only captured once per request', async function () {
    const backend = makeBackend({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'k' } },
      fetchHandler: function () {
        return chatResponse(JSON.stringify(VALID_ANALYSIS));
      }
    });
    await backend.analyze({ imageWidth: 800, imageHeight: 600 });
    assert.strictEqual(backend.mock.state.captureCalls.length, 1);
    assert.ok(backend.mock.state.fetchCalls[0].init.body.includes('800 x 600'));
  });
}

/* ------------------------------------------------------------------ *
 * 8. Static cross-checks (HTML ids, message names, imports)
 * ------------------------------------------------------------------ */

async function testStaticWiring() {
  group('static wiring checks');

  const read = function (file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
  };

  await test('options.js only references ids that exist in options.html', function () {
    const html = read('options.html');
    const js = read('options.js');
    const htmlIds = new Set((html.match(/id="([^"]+)"/g) || []).map(function (match) {
      return match.slice(4, -1);
    }));
    const used = new Set((js.match(/byId\('([^']+)'\)/g) || []).map(function (match) {
      return match.slice(6, -2);
    }));
    assert.ok(used.size > 10, 'expected several ids, found ' + used.size);
    used.forEach(function (id) {
      assert.ok(htmlIds.has(id), 'options.js references missing id: ' + id);
    });
  });

  await test('options.html loads every script it needs, in order', function () {
    const html = read('options.html');
    const scripts = (html.match(/<script src="([^"]+)"><\/script>/g) || []).map(function (match) {
      return match.slice(13, -11);
    });
    const expected = ['utils/constants.js', 'utils/coords.js', 'utils/settings.js', 'providers/index.js'];
    expected.forEach(function (file, index) {
      assert.strictEqual(scripts[index], file, 'script #' + index + ' should be ' + file);
    });
    assert.strictEqual(scripts[scripts.length - 1], 'options.js');
    scripts.forEach(function (file) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), 'missing script: ' + file);
    });
    ['openai', 'openrouter', 'gemini', 'anthropic', 'deepseek', 'mistral', 'groq', 'xai', 'custom'].forEach(function (id) {
      assert.ok(scripts.includes('providers/' + id + '.js'), 'options.html is missing providers/' + id + '.js');
    });
  });

  await test('panel.js only queries ids present in its template', function () {
    const js = read('panel.js');
    const templateIds = new Set();
    const templateMatch = js.match(/const TEMPLATE = \[([\s\S]*?)\]\.join\('\\n'\);/);
    assert.ok(templateMatch, 'TEMPLATE block not found in panel.js');
    (templateMatch[1].match(/id="([^"]+)"/g) || []).forEach(function (match) {
      templateIds.add(match.slice(4, -1));
    });
    const queried = new Set((js.match(/shell\.querySelector\('#([^']+)'\)/g) || []).map(function (match) {
      return match.slice(22, -2);
    }));
    assert.ok(queried.size > 15, 'expected many queried ids, found ' + queried.size);
    queried.forEach(function (id) {
      assert.ok(templateIds.has(id), 'panel.js queries missing id: ' + id);
    });
  });

  await test('content.js only uses message types that exist in ACP.MSG', function () {
    const constants = read('utils/constants.js');
    const defined = new Set((constants.match(/([A-Z_]+): 'ACP_[A-Z_]+'/g) || []).map(function (match) {
      return match.split(':')[0];
    }));
    const used = new Set((read('content.js').match(/MSG\.([A-Z_]+)/g) || []).map(function (match) {
      return match.slice(4);
    }));
    used.forEach(function (name) {
      assert.ok(defined.has(name), 'content.js uses undefined message type MSG.' + name);
    });
    assert.ok(used.has('ANALYZE') && used.has('CANCEL') && used.has('GET_SETTINGS') && used.has('SAVE_SETTINGS'));
  });

  await test('background.js handles every message type the panel sends', function () {
    const background = read('background.js');
    const content = read('content.js');
    const constants = read('utils/constants.js');
    const defined = new Set((constants.match(/([A-Z_]+): 'ACP_[A-Z_]+'/g) || []).map(function (match) {
      return match.split(':')[0];
    }));
    const sent = new Set(
      (content.match(/type: MSG\.([A-Z_]+)/g) || []).map(function (match) {
        return match.slice(10);
      })
    );
    sent.forEach(function (name) {
      assert.ok(defined.has(name), 'unknown message ' + name);
      const handled = background.includes('case MSG.' + name + ':') || background.includes('case MSG.' + name);
      if (name !== 'CAPTURED') {
        assert.ok(handled, 'background.js does not handle MSG.' + name);
      }
    });
  });

  await test('overlay.css cannot restyle the host page', function () {
    const css = read('overlay.css');
    // A bare `*` selector or a bare `[hidden]` rule would apply to the page if
    // the sheet is ever injected into the document instead of the shadow root.
    assert.ok(!/(^|\})\s*\*\s*,/.test(css), 'unscoped universal selector found');
    assert.ok(!/(^|\})\s*\[hidden\]\s*\{/.test(css), 'unscoped [hidden] rule found');
    assert.ok(css.includes(':host'), 'sheet should be shadow-DOM aware');
  });

  await test('overlay.css contains every class the panel/content render', function () {
    const css = read('overlay.css');
    const needed = [
      'acp-panel',
      'acp-panel__header',
      'acp-panel__body',
      'acp-canvas',
      'acp-ghost-handle',
      'acp-disclaimer',
      'acp-status',
      'acp-result',
      'acp-badge',
      'acp-grid',
      'acp-chip',
      'acp-switch',
      'acp-vision'
    ];
    needed.forEach(function (name) {
      assert.ok(css.includes('.' + name), 'overlay.css is missing .' + name);
    });
  });

  await test('the disclaimer text is present in the panel and the options page', function () {
    const disclaimer = 'AI prediction is not financial advice. Trading involves risk.';
    assert.ok(read('panel.js').includes(disclaimer));
    assert.ok(read('options.html').includes(disclaimer));
    assert.ok(read('README.md').includes(disclaimer));
  });

  await test('no API key can reach page context (content script never reads storage directly)', function () {
    const content = read('content.js');
    assert.ok(!content.includes('chrome.storage.local.get'), 'content.js must use the redacted settings message');
    assert.ok(!content.includes('apiKeys'), 'content.js must never touch apiKeys');
  });

  await test('no TODO / FIXME / stub markers are left in the shipped code', function () {
    const files = ['background.js', 'content.js', 'panel.js', 'options.js', 'options.html', 'options.css', 'overlay.css', 'manifest.json']
      .concat(fs.readdirSync(path.join(ROOT, 'utils')).map(function (file) { return 'utils/' + file; }))
      .concat(fs.readdirSync(path.join(ROOT, 'providers')).map(function (file) { return 'providers/' + file; }));
    files.forEach(function (file) {
      const text = read(file);
      assert.ok(!/\bTODO\b/.test(text), 'TODO found in ' + file);
      assert.ok(!/\bFIXME\b/.test(text), 'FIXME found in ' + file);
      assert.ok(!/not implemented/i.test(text), 'unimplemented stub in ' + file);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const startedAt = Date.now();
  console.log('\u001b[1mAI Chart Predictor — unit + integration tests\u001b[0m');

  await testManifest();
  await testSchema();
  await testCoords();
  await testSettings();
  await testProviders();
  await testPrompt();
  await testBackground();
  await testStaticWiring();

  console.log('\n' + '-'.repeat(58));
  if (failed === 0) {
    console.log('\u001b[32m%d passed\u001b[0m in %d ms', passed, Date.now() - startedAt);
  } else {
    console.log('\u001b[31m%d failed\u001b[0m, \u001b[32m%d passed\u001b[0m', failed, passed);
    failures.forEach(function (failure) {
      console.log('\n  ' + failure.group + ' › ' + failure.name);
      console.log('  ' + String((failure.error && failure.error.stack) || failure.error).split('\n').slice(0, 6).join('\n  '));
    });
    process.exitCode = 1;
  }
}

main().catch(function (error) {
  console.error('Test runner crashed:', error);
  process.exitCode = 1;
});
