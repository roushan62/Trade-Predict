/**
 * AI Chart Predictor — settings store.
 *
 * All settings (including API keys) live in chrome.storage.local under a single
 * key. The content script only ever receives a redacted copy (`getPublic`), so
 * a key can never leak into a page even if the page could read the shadow DOM
 * via an XSS in the extension (it cannot, but defence in depth is cheap).
 */
(function (global) {
  'use strict';

  const ACP = (global.ACP = global.ACP || {});
  const KEY = ACP.STORAGE_KEY;
  const BLOCKED_KEYS = { __proto__: true, constructor: true, prototype: true };

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function clone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return {};
    }
  }

  /** Recursive merge; arrays and primitives from `patch` win outright. */
  function deepMerge(base, patch) {
    if (!isPlainObject(base)) base = {};
    if (!isPlainObject(patch)) return base;
    Object.keys(patch).forEach(function (key) {
      if (BLOCKED_KEYS[key]) return;
      const value = patch[key];
      if (isPlainObject(value)) {
        base[key] = deepMerge(isPlainObject(base[key]) ? base[key] : {}, value);
      } else if (value !== undefined) {
        base[key] = value;
      }
    });
    return base;
  }

  function normalizeInterval(value, fallback) {
    const numeric = Number(value);
    const match = ACP.LIVE_INTERVALS.filter(function (item) {
      return item.value === numeric;
    })[0];
    return match ? match.value : fallback;
  }

  function normalize(raw) {
    const defaults = clone(ACP.DEFAULT_SETTINGS);
    const merged = deepMerge(defaults, isPlainObject(raw) ? clone(raw) : {});

    if (!ACP.TIMEFRAMES.includes(merged.timeframe)) merged.timeframe = ACP.DEFAULT_SETTINGS.timeframe;

    const candleCount = Number(merged.candleCount);
    merged.candleCount = ACP.CANDLE_COUNTS.includes(candleCount)
      ? candleCount
      : ACP.DEFAULT_SETTINGS.candleCount;

    merged.liveIntervalSec = normalizeInterval(merged.liveIntervalSec, ACP.DEFAULT_SETTINGS.liveIntervalSec);
    merged.liveEnabled = merged.liveEnabled === true;
    merged.providerId = typeof merged.providerId === 'string' && merged.providerId.trim()
      ? merged.providerId.trim()
      : ACP.DEFAULT_SETTINGS.providerId;
    // A stored provider that no longer exists (downgrade, typo in storage) would
    // leave the panel select empty, so fall back to the default provider.
    if (ACP.providers && !ACP.providers.get(merged.providerId)) {
      merged.providerId = ACP.DEFAULT_SETTINGS.providerId;
      // The saved model belonged to the provider that no longer exists.
      merged.model = '';
    }
    merged.model = typeof merged.model === 'string' ? merged.model.trim() : '';
    merged.baseUrl = typeof merged.baseUrl === 'string' ? merged.baseUrl.trim() : '';

    if (!isPlainObject(merged.apiKeys)) merged.apiKeys = {};
    Object.keys(merged.apiKeys).forEach(function (id) {
      const key = merged.apiKeys[id];
      if (typeof key !== 'string') {
        delete merged.apiKeys[id];
        return;
      }
      merged.apiKeys[id] = key.trim();
      if (!merged.apiKeys[id]) delete merged.apiKeys[id];
    });

    const panel = isPlainObject(merged.panel) ? merged.panel : {};
    merged.panel = {
      left: Number.isFinite(Number(panel.left)) && panel.left !== null ? Number(panel.left) : null,
      top: Number.isFinite(Number(panel.top)) && panel.top !== null ? Number(panel.top) : null,
      collapsed: panel.collapsed === true
    };

    return merged;
  }

  function readRaw() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(KEY, function (result) {
          if (chrome.runtime && chrome.runtime.lastError) {
            // Never throw on storage failures; fall back to defaults.
            resolve({});
            return;
          }
          resolve(result && isPlainObject(result[KEY]) ? result[KEY] : {});
        });
      } catch (error) {
        resolve({});
      }
    });
  }

  /** Full settings document (contains API keys — background + options page only). */
  function read() {
    return readRaw().then(normalize);
  }

  function write(settings) {
    const clean = normalize(settings);
    return new Promise(function (resolve, reject) {
      try {
        const payload = {};
        payload[KEY] = clean;
        chrome.storage.local.set(payload, function () {
          if (chrome.runtime && chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'Could not save settings.'));
            return;
          }
          resolve(clean);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /** Shallow-merge a partial settings patch and persist it. */
  function patch(partial) {
    return read().then(function (current) {
      return write(deepMerge(current, partial || {}));
    });
  }

  function setApiKey(providerId, apiKey) {
    return read().then(function (current) {
      const keys = current.apiKeys || {};
      const value = typeof apiKey === 'string' ? apiKey.trim() : '';
      if (value) keys[providerId] = value;
      else delete keys[providerId];
      current.apiKeys = keys;
      return write(current);
    });
  }

  /** Strip secrets before a settings document leaves the background worker. */
  function redact(settings) {
    const copy = clone(settings);
    const keys = isPlainObject(copy.apiKeys) ? copy.apiKeys : {};
    copy.apiKeys = {};
    copy.apiKeyStatus = {};
    Object.keys(keys).forEach(function (id) {
      const key = keys[id];
      if (typeof key === 'string' && key) {
        copy.apiKeyStatus[id] = { hasKey: true, hint: '••••' + key.slice(-4) };
      }
    });
    return copy;
  }

  function getPublic() {
    return read().then(redact);
  }

  ACP.settings = {
    normalize: normalize,
    read: read,
    write: write,
    patch: patch,
    setApiKey: setApiKey,
    redact: redact,
    getPublic: getPublic,
    deepMerge: deepMerge
  };
})(typeof self !== 'undefined' ? self : this);
