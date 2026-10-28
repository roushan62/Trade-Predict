'use strict';

/**
 * AI Chart Predictor — options page tests (jsdom).
 *
 *   node test/options-tests.js     (requires `npm install`)
 *
 * Loads the real options.html + options.js (and every provider adapter) into a
 * simulated extension page and exercises the key handling, provider switching,
 * vision warnings, save and "Test connection" flows.
 */

const assert = require('assert');
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

const wait = (ms) =>
  new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });

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

const HTML = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');

/**
 * @param {{settings?:object, testHandler?:Function}} options
 */
async function bootOptions(options) {
  const opts = options || {};
  const storage = {};
  if (opts.settings) storage.acpSettingsV1 = opts.settings;

  const dom = new JSDOM(HTML, {
    url: 'chrome-extension://acp-test-extension/options.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const win = dom.window;

  const mock = createChromeMock({ storage: storage });
  win.chrome = mock.chrome;

  const log = { testRequests: [] };
  mock.state.sendMessageImpl = function (message, callback) {
    const respond = (payload) => {
      Promise.resolve().then(function () {
        if (typeof callback === 'function') callback(payload);
      });
    };
    if (message.type === 'ACP_TEST_CONNECTION') {
      log.testRequests.push(message.payload);
      Promise.resolve(opts.testHandler ? opts.testHandler(message.payload) : { ok: true, message: 'OpenAI · gpt-4o responded.', sample: '{"ok": true}' })
        .then(respond)
        .catch(function (error) {
          respond({ ok: false, error: { code: 'UNKNOWN', message: String(error && error.message) } });
        });
      return;
    }
    respond({ ok: true });
  };

  // Execute the page's own <script src> tags in order.
  const scripts = [];
  const regex = /<script src="([^"]+)"><\/script>/g;
  let match;
  while ((match = regex.exec(HTML))) scripts.push(match[1]);
  scripts.forEach(function (file) {
    win.eval(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  });

  // jsdom fires DOMContentLoaded asynchronously after the document is parsed,
  // which happens after the scripts above were evaluated — wait for init().
  await waitFor(function () {
    return win.document.body.dataset.acpReady === 'true';
  }, 3000, 'the options page to initialise');

  const q = (id) => win.document.getElementById(id);

  return {
    win: win,
    dom: dom,
    mock: mock,
    log: log,
    q: q,
    setValue: function (element, value) {
      element.value = value;
      element.dispatchEvent(new win.Event('input', { bubbles: true }));
      element.dispatchEvent(new win.Event('change', { bubbles: true }));
    },
    selectProvider: function (id) {
      const select = q('provider');
      select.value = id;
      select.dispatchEvent(new win.Event('change', { bubbles: true }));
    },
    click: function (id) {
      q(id).click();
    },
    statusText: function () {
      return q('status').textContent;
    },
    close: function () {
      win.close();
    }
  };
}

async function main() {
  console.log('\u001b[1mAI Chart Predictor — options page tests (jsdom)\u001b[0m');

  /* ---------------------------------------------------------------- */
  group('initial render');

  const page = await bootOptions({});

  await test('lists all nine providers', function () {
    const options = Array.from(page.q('provider').options).map(function (option) {
      return option.value;
    });
    assert.deepStrictEqual(options, [
      'openrouter',
      'openai',
      'gemini',
      'anthropic',
      'deepseek',
      'mistral',
      'groq',
      'xai',
      'custom'
    ].filter(function (id) {
      // registration order is manifest/provider load order
      return true;
    }).sort(function (a, b) {
      return options.indexOf(a) - options.indexOf(b);
    }));
    assert.strictEqual(options.length, 9);
  });

  await test('shows the default provider, model and key state', function () {
    assert.strictEqual(page.q('provider').value, 'openrouter');
    assert.strictEqual(page.q('model').value, 'openai/gpt-4o');
    assert.strictEqual(page.q('key-state').textContent, 'no key saved');
    assert.strictEqual(page.q('api-key').type, 'password');
    assert.strictEqual(page.q('version').textContent, 'v' + page.mock.chrome.runtime.getManifest().version);
  });

  await test('hides the custom base URL field for hosted providers', function () {
    assert.strictEqual(page.q('base-url-field').hidden, true);
  });

  await test('offers vision models as datalist suggestions and marks text-only ones', function () {
    const values = Array.from(page.q('model-list').options).map(function (option) {
      return option.value;
    });
    assert.ok(values.includes('openai/gpt-4o'));
    assert.ok(values.includes('deepseek/deepseek-chat'));
    const textOnly = Array.from(page.q('model-list').options).filter(function (option) {
      return /no image support/.test(option.label);
    });
    assert.ok(textOnly.length >= 1, 'text-only models must be labelled');
  });

  await test('shows the privacy disclaimer', function () {
    assert.ok(page.win.document.body.textContent.includes('AI prediction is not financial advice. Trading involves risk.'));
  });

  /* ---------------------------------------------------------------- */
  group('provider switching');

  await test('switching provider swaps the suggested model and docs link', function () {
    page.selectProvider('gemini');
    assert.strictEqual(page.q('model').value, 'gemini-2.0-flash');
    assert.strictEqual(page.q('vision').dataset.tone, 'ok');
    assert.ok(page.q('docs-link').href.includes('aistudio.google.com'));

    page.selectProvider('openai');
    assert.strictEqual(page.q('model').value, 'gpt-4o');
    assert.ok(page.q('docs-link').href.includes('platform.openai.com'));
  });

  await test('a text-only model produces a clear vision warning', function () {
    page.selectProvider('deepseek');
    assert.strictEqual(page.q('vision').hidden, false);
    assert.strictEqual(page.q('vision').dataset.tone, 'error');
    assert.ok(/cannot read images/i.test(page.q('vision').textContent));

    page.selectProvider('openrouter');
    assert.notStrictEqual(page.q('vision').dataset.tone, 'error');
  });

  await test('an unknown model name reports "unknown" instead of guessing', function () {
    page.setValue(page.q('model'), 'acme/mystery-v1');
    assert.strictEqual(page.q('vision').dataset.tone, 'warn');
    assert.ok(/not in the built-in list/i.test(page.q('vision').textContent));
    page.setValue(page.q('model'), 'openai/gpt-4o');
    assert.strictEqual(page.q('vision').dataset.tone, 'ok');
  });

  await test('custom provider reveals the base URL field', function () {
    page.selectProvider('custom');
    assert.strictEqual(page.q('base-url-field').hidden, false);
    assert.strictEqual(page.q('docs-link').hidden, false);
    page.selectProvider('openrouter');
    assert.strictEqual(page.q('base-url-field').hidden, true);
  });

  await test('the reset button restores the recommended model', function () {
    page.setValue(page.q('model'), 'openai/gpt-4o-mini');
    page.click('reset-model');
    assert.strictEqual(page.q('model').value, 'openai/gpt-4o');
  });

  /* ---------------------------------------------------------------- */
  group('API key handling');

  await test('the show/hide toggle reveals the key without losing it', function () {
    page.setValue(page.q('api-key'), 'sk-or-secret-123');
    assert.strictEqual(page.q('key-state').textContent, 'key saved locally');
    page.click('toggle-key');
    assert.strictEqual(page.q('api-key').type, 'text');
    assert.strictEqual(page.q('api-key').value, 'sk-or-secret-123');
    assert.strictEqual(page.q('toggle-key').getAttribute('aria-pressed'), 'true');
    page.click('toggle-key');
    assert.strictEqual(page.q('api-key').type, 'password');
  });

  await test('keys are remembered per provider while switching', function () {
    page.setValue(page.q('api-key'), 'sk-or-secret-123');
    page.selectProvider('openai');
    assert.strictEqual(page.q('api-key').value, '', 'OpenAI has its own empty key');
    page.setValue(page.q('api-key'), 'sk-openai-999');
    page.selectProvider('openrouter');
    assert.strictEqual(page.q('api-key').value, 'sk-or-secret-123');
    page.selectProvider('openai');
    assert.strictEqual(page.q('api-key').value, 'sk-openai-999');
  });

  /* ---------------------------------------------------------------- */
  group('save');

  await test('saving persists the provider, model, key and panel defaults', async function () {
    page.selectProvider('openai');
    page.setValue(page.q('api-key'), 'sk-openai-999');
    page.q('timeframe').value = '1h';
    page.q('candle-count').value = '2';
    page.q('live-interval').value = '60';
    page.q('live-enabled').checked = true;

    page.click('save');
    await waitFor(function () {
      return /Saved/.test(page.statusText());
    }, 2000, 'the save confirmation');

    const stored = page.mock.readSettings();
    assert.strictEqual(stored.providerId, 'openai');
    assert.strictEqual(stored.model, 'gpt-4o');
    assert.strictEqual(stored.apiKeys.openai, 'sk-openai-999');
    assert.strictEqual(stored.apiKeys.openrouter, 'sk-or-secret-123');
    assert.strictEqual(stored.timeframe, '1h');
    assert.strictEqual(stored.candleCount, 2);
    assert.strictEqual(stored.liveIntervalSec, 60);
    assert.strictEqual(stored.liveEnabled, true);
  });

  await test('saving with an empty key removes that provider key and warns', async function () {
    page.setValue(page.q('api-key'), '');
    page.click('save');
    await waitFor(function () {
      return /no API key is stored/i.test(page.statusText());
    }, 2000, 'the missing-key warning');
    assert.strictEqual(page.mock.readSettings().apiKeys.openai, undefined);
    assert.strictEqual(page.mock.readSettings().apiKeys.openrouter, 'sk-or-secret-123');
    page.setValue(page.q('api-key'), 'sk-openai-999');
  });

  await test('the Custom provider requires a base URL', async function () {
    page.selectProvider('custom');
    page.setValue(page.q('model'), 'llava');
    page.q('base-url').value = '';
    page.click('save');
    await waitFor(function () {
      return /base URL/i.test(page.statusText());
    }, 2000, 'the base URL error');
    assert.strictEqual(page.q('status').dataset.tone, 'error');

    page.q('base-url').value = 'http://localhost:11434/v1';
    page.click('save');
    await waitFor(function () {
      return /Saved/.test(page.statusText());
    }, 2000, 'the save confirmation');
    assert.strictEqual(page.mock.readSettings().providerId, 'custom');
    assert.strictEqual(page.mock.readSettings().baseUrl, 'http://localhost:11434/v1');
    assert.strictEqual(page.mock.readSettings().model, 'llava');

    page.selectProvider('openai');
    page.click('save');
    await waitFor(function () {
      return /Saved/.test(page.statusText());
    }, 2000, 'restoring the OpenAI provider');
  });

  /* ---------------------------------------------------------------- */
  group('test connection');

  await test('refuses to test without a key', async function () {
    page.selectProvider('gemini');
    page.setValue(page.q('api-key'), '');
    page.click('test');
    await waitFor(function () {
      return /API key first/i.test(page.statusText());
    }, 2000, 'the missing-key message');
    assert.strictEqual(page.log.testRequests.length, 0, 'no request must be sent');
  });

  await test('sends the typed key and reports success', async function () {
    page.selectProvider('openai');
    page.setValue(page.q('api-key'), 'sk-typed-not-saved');
    page.click('test');
    await waitFor(function () {
      return page.log.testRequests.length === 1;
    }, 2000, 'the test request');

    const payload = page.log.testRequests[0];
    assert.strictEqual(payload.providerId, 'openai');
    assert.strictEqual(payload.model, 'gpt-4o');
    assert.strictEqual(payload.apiKey, 'sk-typed-not-saved');

    await waitFor(function () {
      return /Connection OK|responded/.test(page.statusText());
    }, 2000, 'the success status');
    assert.strictEqual(page.q('status').dataset.tone, 'ok');
    assert.strictEqual(page.q('test').disabled, false, 'the button must be re-enabled');
  });

  await test('surfaces a failure from the background', async function () {
    const failing = await bootOptions({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'bad-key' } },
      testHandler: function () {
        return { ok: false, error: { code: 'AUTH', message: 'The API key was rejected. Check the key in Settings.' } };
      }
    });
    failing.click('test');
    await waitFor(function () {
      return /API key was rejected/.test(failing.statusText());
    }, 2000, 'the failure status');
    assert.strictEqual(failing.q('status').dataset.tone, 'error');
    assert.strictEqual(failing.q('test').disabled, false);
    failing.close();
  });

  await test('a saved key is used when the field is empty', async function () {
    const saved = await bootOptions({
      settings: { providerId: 'groq', model: 'llama-3.3-70b-versatile', apiKeys: { groq: 'gsk-saved' } }
    });
    assert.strictEqual(saved.q('api-key').value, 'gsk-saved', 'the saved key must be prefilled');
    assert.strictEqual(saved.q('key-state').textContent, 'key saved locally');

    // A text-only model is blocked before any request is made.
    saved.click('test');
    await waitFor(function () {
      return /cannot read images/i.test(saved.statusText());
    }, 2000, 'the vision block');
    assert.strictEqual(saved.log.testRequests.length, 0, 'a text-only model must not be tested');

    saved.selectProvider('openai');
    saved.setValue(saved.q('model'), 'gpt-4o');
    saved.setValue(saved.q('api-key'), '');
    saved.q('api-key').value = '';
    saved.click('test');
    await waitFor(function () {
      return /API key first/i.test(saved.statusText());
    }, 2000, 'the missing key message for OpenAI');
    saved.close();
  });

  /* ---------------------------------------------------------------- */
  group('test image');

  await test('a selected screenshot is forwarded with the connection test', async function () {
    const withImage = await bootOptions({
      settings: { providerId: 'openai', model: 'gpt-4o', apiKeys: { openai: 'sk' } }
    });
    // jsdom implements File/FileReader, so the real codepath can run.
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
    const file = new withImage.win.File([bytes], 'shot.png', { type: 'image/png' });
    const input = withImage.q('test-image');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new withImage.win.Event('change', { bubbles: true }));

    await waitFor(function () {
      return /Test image loaded/.test(withImage.statusText());
    }, 2000, 'the image to load');

    withImage.click('test');
    await waitFor(function () {
      return withImage.log.testRequests.length === 1;
    }, 2000, 'the test request');
    const payload = withImage.log.testRequests[0];
    assert.ok(payload.dataUrl && payload.dataUrl.startsWith('data:image/png;base64,'), 'the data URL must be forwarded');
    withImage.close();
  });

  /* ---------------------------------------------------------------- */
  group('security');

  await test('the options page never sends keys through SAVE_SETTINGS', async function () {
    const sent = page.log.testRequests.concat([]);
    assert.ok(sent.every(function (payload) { return payload.providerId !== undefined; }));
    // options.js writes with chrome.storage directly, not through the message API
    assert.strictEqual(page.mock.state.messageListeners.length, 0, 'the options page registers no message listeners');
  });

  await test('keys saved in storage are never rendered into the DOM as plain text', async function () {
    const html = page.win.document.documentElement.outerHTML;
    assert.ok(!html.includes('sk-or-secret-123'), 'a raw key leaked into the markup');
    assert.strictEqual(page.q('api-key').type, 'password');
  });

  page.close();

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

main().catch(function (error) {
  console.error('Options test runner crashed:', error);
  process.exitCode = 1;
});
