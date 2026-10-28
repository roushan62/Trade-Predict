/**
 * AI Chart Predictor — options page logic.
 *
 * The page reads and writes the settings document directly (it is an extension
 * page, so it may touch chrome.storage). "Test connection" is routed through the
 * background worker because that is where provider adapters live and where the
 * request must originate.
 */
(function () {
  'use strict';

  const ACP = self.ACP;
  if (!ACP) {
    console.error('[ACP] options page loaded without its dependencies');
    return;
  }

  const byId = function (id) {
    return document.getElementById(id);
  };

  const el = {
    provider: byId('provider'),
    model: byId('model'),
    modelList: byId('model-list'),
    resetModel: byId('reset-model'),
    baseUrlField: byId('base-url-field'),
    baseUrl: byId('base-url'),
    apiKey: byId('api-key'),
    toggleKey: byId('toggle-key'),
    docsLink: byId('docs-link'),
    keyState: byId('key-state'),
    providerNote: byId('provider-note'),
    vision: byId('vision'),
    testImage: byId('test-image'),
    test: byId('test'),
    save: byId('save'),
    status: byId('status'),
    timeframe: byId('timeframe'),
    candleCount: byId('candle-count'),
    liveInterval: byId('live-interval'),
    liveEnabled: byId('live-enabled'),
    version: byId('version'),
    footerVersion: byId('footer-version')
  };

  /** providerId -> key currently typed in the field */
  const keyDrafts = {};
  /** providerId -> model currently typed in the field */
  const modelDrafts = {};

  let settings = null;
  let savedKeys = {};
  let currentProvider = null;
  let testImageDataUrl = '';
  let statusTimer = 0;

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  function setStatus(message, tone) {
    window.clearTimeout(statusTimer);
    if (!message) {
      el.status.hidden = true;
      el.status.textContent = '';
      return;
    }
    el.status.hidden = false;
    el.status.textContent = message;
    if (tone) el.status.dataset.tone = tone;
    else delete el.status.dataset.tone;
  }

  function sendMessage(message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'Messaging failed.'));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function makeError(payload) {
    if (payload && payload.message) return new Error(payload.message);
    return new Error('The extension background worker did not answer.');
  }

  function fillSelect(select, items, selected) {
    select.textContent = '';
    items.forEach(function (item) {
      const option = document.createElement('option');
      option.value = String(item.value);
      option.textContent = item.label;
      select.appendChild(option);
    });
    if (selected != null) select.value = String(selected);
  }

  function currentProviderObject() {
    return ACP.providers.get(currentProvider);
  }

  function currentModelValue() {
    return el.model.value.trim() || ACP.providers.defaultModel(currentProvider);
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function fillStatics() {
    fillSelect(
      el.timeframe,
      ACP.TIMEFRAMES.map(function (tf) {
        return { value: tf, label: tf };
      }),
      '15m'
    );
    fillSelect(
      el.candleCount,
      ACP.CANDLE_COUNTS.map(function (count) {
        return { value: count, label: count === 1 ? '1 candle' : count + ' candles' };
      }),
      3
    );
    fillSelect(
      el.liveInterval,
      ACP.LIVE_INTERVALS.map(function (item) {
        return { value: item.value, label: item.label };
      }),
      30
    );

    fillSelect(
      el.provider,
      ACP.providers.list().map(function (provider) {
        return { value: provider.id, label: provider.label };
      }),
      ACP.DEFAULT_SETTINGS.providerId
    );
  }

  function fillModelList(providerId) {
    const models = ACP.providers.modelsFor(providerId);
    el.modelList.textContent = '';
    models.forEach(function (model) {
      const option = document.createElement('option');
      option.value = model.id;
      option.label = model.vision ? model.label : model.label + ' · no image support';
      el.modelList.appendChild(option);
    });
  }

  function updateKeyState() {
    const hasKey = !!String(el.apiKey.value || '').trim();
    el.keyState.dataset.state = hasKey ? 'ok' : 'warn';
    el.keyState.textContent = hasKey ? 'key saved locally' : 'no key saved';
  }

  function updateVision() {
    const provider = currentProviderObject();
    const model = currentModelValue();
    const info = ACP.providers.visionInfo(currentProvider, model);

    if (!provider) {
      el.vision.hidden = true;
      return;
    }
    if (info.status === 'supported') {
      el.vision.hidden = false;
      el.vision.dataset.tone = 'ok';
      el.vision.textContent = '✓ ' + info.message;
    } else if (info.status === 'unsupported') {
      el.vision.hidden = false;
      el.vision.dataset.tone = 'error';
      el.vision.textContent = '⚠ ' + info.message;
    } else {
      el.vision.hidden = false;
      el.vision.dataset.tone = 'warn';
      el.vision.textContent = 'ⓘ ' + info.message;
    }
  }

  function updateProviderNote() {
    const provider = currentProviderObject();
    const note = provider && provider.note ? provider.note : '';
    el.providerNote.hidden = !note;
    el.providerNote.textContent = note;
  }

  /** Refresh the provider-dependent controls. */
  function syncProviderUi() {
    const provider = currentProviderObject();
    if (!provider) return;

    fillModelList(currentProvider);

    const draft = modelDrafts[currentProvider];
    const savedModel =
      settings && settings.providerId === currentProvider && settings.model ? settings.model : '';
    el.model.value = draft != null ? draft : savedModel || ACP.providers.defaultModel(currentProvider);

    el.baseUrlField.hidden = currentProvider !== 'custom';
    if (currentProvider === 'custom') {
      el.baseUrl.value = (settings && settings.baseUrl) || '';
    }

    if (provider.docsUrl) {
      el.docsLink.href = provider.docsUrl;
      el.docsLink.hidden = false;
    } else {
      el.docsLink.hidden = true;
      el.docsLink.removeAttribute('href');
    }

    const draftKey = keyDrafts[currentProvider];
    el.apiKey.value = draftKey != null ? draftKey : savedKeys[currentProvider] || '';
    el.apiKey.type = 'password';
    el.toggleKey.textContent = 'Show';
    el.toggleKey.setAttribute('aria-pressed', 'false');

    updateProviderNote();
    updateVision();
    updateKeyState();
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  function bindEvents() {
    el.provider.addEventListener('change', function () {
      if (currentProvider) {
        keyDrafts[currentProvider] = el.apiKey.value.trim();
        modelDrafts[currentProvider] = el.model.value.trim();
      }
      currentProvider = el.provider.value;
      syncProviderUi();
    });

    el.model.addEventListener('input', updateVision);
    el.model.addEventListener('change', updateVision);

    el.resetModel.addEventListener('click', function () {
      el.model.value = ACP.providers.defaultModel(currentProvider);
      delete modelDrafts[currentProvider];
      updateVision();
    });

    el.toggleKey.addEventListener('click', function () {
      const showing = el.apiKey.type === 'text';
      el.apiKey.type = showing ? 'password' : 'text';
      el.toggleKey.textContent = showing ? 'Show' : 'Hide';
      el.toggleKey.setAttribute('aria-pressed', showing ? 'false' : 'true');
    });

    el.apiKey.addEventListener('input', updateKeyState);
    el.apiKey.addEventListener('change', function () {
      keyDrafts[currentProvider] = el.apiKey.value.trim();
      updateKeyState();
    });

    el.testImage.addEventListener('change', function () {
      const file = el.testImage.files && el.testImage.files[0];
      testImageDataUrl = '';
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) {
        setStatus('That image is larger than 8 MB. Pick a smaller screenshot.', 'error');
        el.testImage.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = function () {
        testImageDataUrl = typeof reader.result === 'string' ? reader.result : '';
        setStatus('Test image loaded (' + Math.round(file.size / 1024) + ' KB). Press "Test connection".', 'ok');
      };
      reader.onerror = function () {
        setStatus('Could not read that image file.', 'error');
      };
      reader.readAsDataURL(file);
    });

    el.test.addEventListener('click', testConnection);
    el.save.addEventListener('click', save);
  }

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  async function testConnection() {
    const provider = currentProviderObject();
    if (!provider) return;

    const model = currentModelValue();
    const typedKey = el.apiKey.value.trim();
    const apiKey = typedKey || savedKeys[currentProvider] || '';

    if (provider.requiresKey !== false && !apiKey) {
      setStatus('Enter your ' + provider.label + ' API key first (or save one), then test again.', 'error');
      el.apiKey.focus();
      return;
    }
    if (currentProvider === 'custom' && !el.baseUrl.value.trim()) {
      setStatus('Enter the base URL of your OpenAI-compatible endpoint first.', 'error');
      el.baseUrl.focus();
      return;
    }

    const vision = ACP.providers.visionInfo(currentProvider, model);
    if (vision.status === 'unsupported') {
      // Fail fast: a text-only model cannot read the test image either.
      setStatus('✗ ' + vision.message, 'error');
      return;
    }

    el.test.disabled = true;
    setStatus('Testing ' + provider.label + ' · ' + model + ' …', 'loading');

    try {
      const response = await sendMessage({
        type: ACP.MSG.TEST_CONNECTION,
        payload: {
          providerId: currentProvider,
          model: model,
          baseUrl: el.baseUrl.value.trim(),
          apiKey: typedKey,
          dataUrl: testImageDataUrl || undefined
        }
      });

      if (!response) throw makeError(null);
      if (!response.ok) throw makeError(response.error);

      const lines = ['✓ ' + (response.message || 'Connection OK.')];
      if (response.usedImage) lines.push('The model accepted your screenshot, so image input works.');
      else lines.push('Tip: pick a screenshot above and test again to prove this model reads images.');
      if (vision.status === 'unknown') lines.push('Image support is unconfirmed for this model name.');
      if (response.sample) lines.push('Reply: ' + response.sample);
      setStatus(lines.join('\n'), 'ok');
    } catch (error) {
      setStatus('✗ ' + (error.message || 'Connection failed.'), 'error');
    } finally {
      el.test.disabled = false;
    }
  }

  async function save() {
    if (!settings) settings = await ACP.settings.read();

    const provider = currentProviderObject();
    const model = el.model.value.trim() || ACP.providers.defaultModel(currentProvider);
    const baseUrl = el.baseUrl.value.trim();

    if (!model) {
      setStatus('Choose or type a model name.', 'error');
      el.model.focus();
      return;
    }
    if (currentProvider === 'custom' && !baseUrl) {
      setStatus('The Custom provider needs a base URL, for example https://api.openai.com/v1.', 'error');
      el.baseUrl.focus();
      return;
    }
    const clearingKey = provider && provider.requiresKey !== false && !el.apiKey.value.trim();

    const next = ACP.settings.normalize(settings);
    next.providerId = currentProvider;
    next.model = model;
    next.baseUrl = baseUrl;
    next.timeframe = el.timeframe.value;
    next.candleCount = Number(el.candleCount.value);
    next.liveIntervalSec = Number(el.liveInterval.value);
    next.liveEnabled = el.liveEnabled.checked;
    next.apiKeys = Object.assign({}, settings.apiKeys);

    Object.keys(keyDrafts).forEach(function (providerId) {
      if (providerId === currentProvider) return;
      const value = keyDrafts[providerId];
      if (!value) delete next.apiKeys[providerId];
      else next.apiKeys[providerId] = value;
    });

    const visibleKey = el.apiKey.value.trim();
    if (visibleKey) next.apiKeys[currentProvider] = visibleKey;
    else delete next.apiKeys[currentProvider];

    el.save.disabled = true;
    try {
      settings = await ACP.settings.write(next);
      savedKeys = Object.assign({}, settings.apiKeys);
      Object.keys(keyDrafts).forEach(function (providerId) {
        delete keyDrafts[providerId];
      });
      updateKeyState();

      if (clearingKey) {
        setStatus(
          'Saved, but no API key is stored for ' + provider.label + '. Add one to run an analysis.',
          'error'
        );
      } else {
        setStatus('Saved. Open a chart tab and press Alt+Shift+A (or click the extension icon).', 'ok');
      }
    } catch (error) {
      setStatus('Could not save the settings: ' + (error.message || error), 'error');
    } finally {
      el.save.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  let initialised = false;

  async function init() {
    // DOMContentLoaded can only fire once per document, but keeping init
    // idempotent makes the page resilient to re-dispatch (and to tests).
    if (initialised) return;
    initialised = true;

    try {
      let version = ACP.VERSION;
      try {
        version = chrome.runtime.getManifest().version || ACP.VERSION;
      } catch (error) {
        // The extension was reloaded while this tab stayed open.
      }
      el.version.textContent = 'v' + version;
      el.footerVersion.textContent = 'v' + version;

      fillStatics();

      settings = await ACP.settings.read();
      savedKeys = Object.assign({}, settings.apiKeys);
      currentProvider = ACP.providers.get(settings.providerId)
        ? settings.providerId
        : ACP.DEFAULT_SETTINGS.providerId;

      el.provider.value = currentProvider;
      el.timeframe.value = settings.timeframe;
      el.candleCount.value = String(settings.candleCount);
      el.liveInterval.value = String(settings.liveIntervalSec);
      el.liveEnabled.checked = settings.liveEnabled === true;

      syncProviderUi();
      bindEvents();
    } catch (error) {
      setStatus('The settings page could not start: ' + (error && error.message ? error.message : error), 'error');
    } finally {
      document.body.dataset.acpReady = 'true';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
