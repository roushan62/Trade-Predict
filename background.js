/**
 * AI Chart Predictor — background service worker (Manifest V3).
 *
 * Responsibilities
 *  - capture the visible tab (chrome.tabs.captureVisibleTab)
 *  - talk to the selected AI provider (all network calls happen here, never in
 *    the page, so API keys never touch page context)
 *  - validate the model's JSON and retry once with a repair instruction
 *  - inject the overlay content script into tabs that were already open
 *  - route messages between the panel, the options page and itself
 */
'use strict';

/* eslint-disable no-undef */

importScripts(
  'utils/constants.js',
  'utils/coords.js',
  'utils/schema.js',
  'utils/settings.js',
  'utils/prompt.js',
  'providers/index.js',
  'providers/openai.js',
  'providers/openrouter.js',
  'providers/gemini.js',
  'providers/anthropic.js',
  'providers/deepseek.js',
  'providers/mistral.js',
  'providers/groq.js',
  'providers/xai.js',
  'providers/custom.js'
);

const ACP = self.ACP;
const MSG = ACP.MSG;
const ERR = ACP.ERROR_CODES;

/** 1x1 transparent PNG used when no test screenshot was supplied. */
const TEST_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Only inline base64 images are accepted as a connection-test payload. */
const INLINE_IMAGE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;
const MAX_TEST_IMAGE_CHARS = 12 * 1024 * 1024;

/** requestId -> { controller, timedOut } for in-flight analyses. */
const inFlight = new Map();

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

function ExtensionError(code, message, details) {
  const error = new Error(message);
  error.name = 'ExtensionError';
  error.code = code || ERR.UNKNOWN;
  error.details = details || null;
  return error;
}

function normalizeError(error) {
  if (error && error.name === 'ExtensionError') {
    return { code: error.code, message: error.message, details: error.details };
  }
  const message = redactSecrets(error && error.message ? error.message : String(error || 'Unknown error'));
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return {
      code: ERR.NETWORK,
      message: 'Network error while contacting the AI provider. Check your connection, VPN or ad-blocker.',
      details: null
    };
  }
  if (/Extension context invalidated/i.test(message)) {
    return {
      code: ERR.UNKNOWN,
      message: 'The extension was reloaded. Refresh this tab and try again.',
      details: null
    };
  }
  return { code: ERR.UNKNOWN, message: message, details: null };
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

const SECRET_PATTERN =
  /\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|org-[A-Za-z0-9]{8,})/g;

/** Replace credential-looking tokens so an error toast can never leak a key. */
function redactSecrets(text) {
  return String(text || '').replace(SECRET_PATTERN, '[redacted]');
}

function extractProviderMessage(data, rawText) {
  const candidates = [];
  if (data && typeof data === 'object') {
    if (data.error) {
      candidates.push(data.error.message, data.error.type, data.error.code);
      if (typeof data.error === 'string') candidates.push(data.error);
    }
    candidates.push(data.message, data.detail);
    if (Array.isArray(data.errors) && data.errors.length) {
      const first = data.errors[0];
      candidates.push(first && (first.message || first.detail || first));
    }
  }
  candidates.push(rawText);
  for (let i = 0; i < candidates.length; i += 1) {
    const value = candidates[i];
    if (typeof value === 'string' && value.trim()) {
      return redactSecrets(value.trim().replace(/\s+/g, ' ')).slice(0, 400);
    }
  }
  return '';
}

function httpError(status, providerLabel, data, rawText) {
  const detail = extractProviderMessage(data, rawText);
  let code = ERR.BAD_REQUEST;
  let hint = 'The provider rejected the request.';

  if (status === 400) {
    code = ERR.BAD_REQUEST;
    hint = 'The provider rejected the request format.';
  } else if (status === 401) {
    code = ERR.AUTH;
    hint = 'The API key was rejected. Check the key in Settings.';
  } else if (status === 402) {
    code = ERR.QUOTA;
    hint = 'The account has no remaining credit.';
  } else if (status === 403) {
    code = ERR.FORBIDDEN;
    hint = 'Access denied for this key, model or region.';
  } else if (status === 404) {
    code = ERR.NOT_FOUND;
    hint = 'The model or endpoint was not found. Check the model name and base URL.';
  } else if (status === 413) {
    code = ERR.PAYLOAD_TOO_LARGE;
    hint = 'The screenshot is too large for this model.';
  } else if (status === 429) {
    code = ERR.RATE_LIMIT;
    hint = 'Rate limit or quota exceeded. Wait a little or slow down Live Mode.';
  } else if (status >= 500) {
    code = ERR.SERVER;
    hint = providerLabel + ' is having server trouble. Try again shortly.';
  }

  if (/image|vision|multimodal|image_url|does not support/i.test(detail)) {
    hint += ' This model may not accept images.';
  }

  return ExtensionError(code, hint + (detail ? ' (' + status + ': ' + detail + ')' : ' (' + status + ')'), {
    status: status
  });
}

/**
 * fetch + JSON parse with structured errors.
 * `record.timedOut` distinguishes a timeout from a user cancellation.
 */
async function fetchJson(url, init, signal, record) {
  let host = '';
  try {
    host = new URL(url).host;
  } catch (error) {
    host = 'the provider';
  }

  let response;
  let text = '';
  try {
    response = await fetch(url, Object.assign({}, init, { signal: signal }));
    text = await response.text();
  } catch (error) {
    if (error && error.name === 'AbortError') {
      if (record && record.timedOut) {
        throw ExtensionError(
          ERR.TIMEOUT,
          'The AI provider did not answer within ' + Math.round(ACP.ANALYSIS_TIMEOUT_MS / 1000) + ' seconds.'
        );
      }
      throw ExtensionError(ERR.CANCELLED, 'The request was cancelled.');
    }
    throw ExtensionError(
      ERR.NETWORK,
      'Could not reach ' + host + '. Check your internet connection, VPN, firewall or ad-blocker.'
    );
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = null;
    }
  }
  return { response: response, text: text, data: data };
}

/* ------------------------------------------------------------------ *
 * Provider calls
 * ------------------------------------------------------------------ */

async function requestProvider(context) {
  const provider = context.provider;
  const built = provider.buildRequest({
    apiKey: context.apiKey,
    model: context.model,
    baseUrl: context.baseUrl,
    dataUrl: context.dataUrl,
    prompt: context.prompt,
    systemPrompt: context.systemPrompt,
    maxTokens: context.maxTokens,
    temperature: context.temperature
  });

  const result = await fetchJson(built.url, built.init, context.signal, context.record);

  if (!result.response.ok) {
    throw httpError(result.response.status, provider.label, result.data, result.text);
  }

  let output = '';
  try {
    output = provider.parseResponse(result.data) || '';
  } catch (parseError) {
    throw ExtensionError(ERR.EMPTY_RESPONSE, parseError.message || provider.label + ' returned an unusable response.', {
      raw: result.text.slice(0, 400)
    });
  }

  // A few gateways answer with plain text instead of a JSON envelope. Only use
  // that fallback when the body is not an HTML page.
  if (!String(output).trim() && result.text && !result.data && !/^\s*</.test(result.text)) {
    output = result.text;
  }

  if (!String(output).trim()) {
    if (!result.data && /^\s*</.test(result.text || '')) {
      // The classic custom-base-URL mistake: /v1 missing, or the site root.
      throw ExtensionError(
        ERR.EMPTY_RESPONSE,
        provider.label +
          ' answered with a web page instead of an API response. Check the base URL (it usually ends with /v1) and the model name.'
      );
    }
    throw ExtensionError(
      ERR.EMPTY_RESPONSE,
      provider.label + ' returned an empty message. Try again or switch to a different model.'
    );
  }
  return String(output);
}

function isRetryable(error) {
  const code = error && error.code;
  return code === ERR.RATE_LIMIT || code === ERR.SERVER || code === ERR.NETWORK;
}

/** One automatic retry for transient failures. */
async function withNetworkRetry(task, signal) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal && signal.aborted) throw ExtensionError(ERR.CANCELLED, 'The request was cancelled.');
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === 1) throw error;
      await ACP.sleep(1500);
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------------ *
 * Tab capture
 * ------------------------------------------------------------------ */

function describeCaptureError(error) {
  const message = String((error && error.message) || error || '');
  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|too many calls|quota exceeded per second/i.test(message)) {
    return ExtensionError(
      ERR.RATE_LIMIT,
      'Chrome limits screenshots to a few per second. Wait a moment and press Analyze again.'
    );
  }
  if (/cannot access|chrome:\/\/|extensions gallery|restricted|not allowed/i.test(message)) {
    return ExtensionError(
      ERR.RESTRICTED_PAGE,
      'Chrome does not allow screenshots on this page (chrome:// pages, the Web Store, PDF viewer or the new tab page).'
    );
  }
  return ExtensionError(ERR.CAPTURE_FAILED, 'Could not capture the tab. ' + message);
}

async function captureVisible(sender) {
  if (!sender || !sender.tab || typeof sender.tab.windowId !== 'number') {
    throw ExtensionError(ERR.NO_TAB, 'No browser tab was found for this request. Reload the page and try again.');
  }

  // captureVisibleTab captures the *active* tab of sender.tab.windowId. If the
  // user has already switched away we would capture the wrong chart, so refuse.
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
    const active = tabs && tabs[0];
    if (active && active.id !== sender.tab.id) {
      throw ExtensionError(
        ERR.TAB_NOT_ACTIVE,
        'This tab is no longer the active tab, so the screenshot would show the wrong window. Switch back and press Analyze again.'
      );
    }
  } catch (error) {
    if (error && error.code === ERR.TAB_NOT_ACTIVE) throw error;
    // tabs.query failures are not fatal — capture below will report real errors.
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {
      format: 'jpeg',
      quality: 82
    });
    if (!dataUrl) throw new Error('Empty capture result');
    return dataUrl;
  } catch (error) {
    if (error && error.name === 'ExtensionError') throw error;
    throw describeCaptureError(error);
  }
}

/**
 * Tell the content script that the screenshot has been taken so it can show
 * its own UI again (the panel hides itself to keep the capture clean).
 */
function notifyCaptured(sender) {
  if (!sender || !sender.tab || typeof sender.tab.id !== 'number') return;
  try {
    const promise = chrome.tabs.sendMessage(sender.tab.id, { type: MSG.CAPTURED });
    if (promise && typeof promise.catch === 'function') promise.catch(function () {});
  } catch (error) {
    /* the tab may have navigated away — harmless */
  }
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

async function handleAnalyze(payload, sender) {
  const settings = await ACP.settings.read();

  const providerId = payload.providerId || settings.providerId;
  const provider = ACP.providers.get(providerId);
  if (!provider) {
    throw ExtensionError(ERR.UNKNOWN_PROVIDER, 'Unknown AI provider "' + providerId + '". Choose one in Settings.');
  }

  const model =
    String(payload.model || (providerId === settings.providerId ? settings.model : '') || '').trim() ||
    ACP.providers.defaultModel(providerId);
  if (!model) {
    throw ExtensionError(ERR.MISSING_MODEL, 'Choose a model for ' + provider.label + ' in Settings.');
  }

  const apiKey = (settings.apiKeys && settings.apiKeys[providerId]) || '';
  if (!apiKey && provider.requiresKey !== false) {
    throw ExtensionError(
      ERR.NO_API_KEY,
      'No ' + provider.label + ' API key is saved. Open Settings (right-click the extension icon → Options) and add your key.'
    );
  }

  const baseUrl =
    providerId === 'custom' ? String(payload.baseUrl || settings.baseUrl || '').trim() : provider.defaultBaseUrl;
  if (providerId === 'custom' && !baseUrl) {
    throw ExtensionError(
      ERR.MISSING_BASE_URL,
      'The Custom provider needs a base URL, for example https://api.openai.com/v1 or http://localhost:11434/v1.'
    );
  }

  const vision = ACP.providers.visionInfo(providerId, model);
  if (vision.status === 'unsupported') {
    throw ExtensionError(
      ERR.MODEL_NO_VISION,
      provider.label + ' model "' + model + '" cannot analyse images. ' + vision.message
    );
  }

  const timeframe = ACP.TIMEFRAMES.indexOf(payload.timeframe) >= 0 ? payload.timeframe : settings.timeframe;
  const candleCount = ACP.CANDLE_COUNTS.indexOf(Number(payload.candleCount)) >= 0
    ? Number(payload.candleCount)
    : settings.candleCount;

  const requestId = String(payload.requestId || 'req_' + Date.now());
  const record = { controller: new AbortController(), timedOut: false };
  inFlight.set(requestId, record);

  const timeout = setTimeout(function () {
    record.timedOut = true;
    record.controller.abort();
  }, ACP.ANALYSIS_TIMEOUT_MS);

  try {
    // Capture only after the configuration checks so a misconfigured extension
    // never burns a screenshot from Chrome's rate-limited capture quota.
    const dataUrl = await captureVisible(sender);
    notifyCaptured(sender);

    const promptOptions = {
      timeframe: timeframe,
      candleCount: candleCount,
      imageWidth: Number(payload.imageWidth) || undefined,
      imageHeight: Number(payload.imageHeight) || undefined
    };

    let prompt = ACP.prompt.build(promptOptions);
    let lastErrors = [];
    let lastRaw = '';
    const startedAt = Date.now();

    for (let attempt = 1; attempt <= ACP.MAX_JSON_ATTEMPTS; attempt += 1) {
      const signal = record.controller.signal;
      const raw = await withNetworkRetry(function () {
        return requestProvider({
          provider: provider,
          apiKey: apiKey,
          model: model,
          baseUrl: baseUrl,
          dataUrl: dataUrl,
          prompt: prompt,
          signal: signal,
          record: record,
          maxTokens: providerId === 'gemini' ? 8192 : 4000,
          temperature: 0.2
        });
      }, signal);

      const parsed = ACP.schema.parseAnalysis(raw, { timeframe: timeframe, candleCount: candleCount });

      if (parsed.ok) {
        return {
          ok: true,
          analysis: parsed.analysis,
          warnings: parsed.warnings,
          meta: {
            requestId: requestId,
            providerId: providerId,
            providerLabel: provider.label,
            model: model,
            timeframe: timeframe,
            candleCount: candleCount,
            attempt: attempt,
            latencyMs: Date.now() - startedAt,
            capturedAt: Date.now()
          }
        };
      }

      lastErrors = parsed.errors;
      lastRaw = raw;
      if (attempt < ACP.MAX_JSON_ATTEMPTS) {
        prompt = ACP.prompt.buildRepair(promptOptions, parsed.errors, lastRaw);
      }
    }

    throw ExtensionError(
      ERR.BAD_JSON,
      'The model did not return valid analysis JSON after 2 attempts. ' +
        (lastErrors[0] || '') +
        ' Try a stronger vision model, or lower the number of candles.',
      { raw: lastRaw.slice(0, 600) }
    );
  } catch (error) {
    // A timeout can also fire while we wait between retries; report it as such
    // instead of as a user cancellation.
    if (record.timedOut && (!error || !error.code || error.code === ERR.CANCELLED)) {
      throw ExtensionError(
        ERR.TIMEOUT,
        'The AI provider did not answer within ' + Math.round(ACP.ANALYSIS_TIMEOUT_MS / 1000) + ' seconds.'
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    inFlight.delete(requestId);
  }
}

function handleCancel(requestId) {
  if (!requestId) return { ok: true, cancelled: false };
  const record = inFlight.get(requestId);
  if (!record) return { ok: true, cancelled: false };
  record.controller.abort();
  inFlight.delete(requestId);
  return { ok: true, cancelled: true };
}

/* ------------------------------------------------------------------ *
 * Test connection
 * ------------------------------------------------------------------ */

async function handleTestConnection(payload) {
  const settings = await ACP.settings.read();
  const providerId = payload.providerId || settings.providerId;
  const provider = ACP.providers.get(providerId);
  if (!provider) throw ExtensionError(ERR.UNKNOWN_PROVIDER, 'Unknown AI provider "' + providerId + '".');

  const typedKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  const apiKey = typedKey || (settings.apiKeys && settings.apiKeys[providerId]) || '';
  if (!apiKey && provider.requiresKey !== false) {
    throw ExtensionError(ERR.NO_API_KEY, 'Enter a ' + provider.label + ' API key first.');
  }

  const model =
    String(payload.model || (providerId === settings.providerId ? settings.model : '') || '').trim() ||
    ACP.providers.defaultModel(providerId);
  if (!model) throw ExtensionError(ERR.MISSING_MODEL, 'Choose a model to test.');

  const vision = ACP.providers.visionInfo(providerId, model);
  if (vision.status === 'unsupported') {
    throw ExtensionError(ERR.MODEL_NO_VISION, vision.message);
  }

  const baseUrl =
    providerId === 'custom' ? String(payload.baseUrl || settings.baseUrl || '').trim() : provider.defaultBaseUrl;
  if (providerId === 'custom' && !baseUrl) {
    throw ExtensionError(ERR.MISSING_BASE_URL, 'Enter the base URL of your OpenAI-compatible endpoint.');
  }

  // Prefer the screenshot the user attached on the options page: it proves the
  // model really accepts images, not just that the endpoint answers.
  const supplied =
    typeof payload.dataUrl === 'string' && payload.dataUrl.length <= MAX_TEST_IMAGE_CHARS && INLINE_IMAGE.test(payload.dataUrl)
      ? payload.dataUrl
      : '';
  const testImage = supplied || TEST_IMAGE;

  const record = { controller: new AbortController(), timedOut: false };
  const timeout = setTimeout(function () {
    record.timedOut = true;
    record.controller.abort();
  }, 45000);

  try {
    const text = await requestProvider({
      provider: provider,
      apiKey: apiKey,
      model: model,
      baseUrl: baseUrl,
      dataUrl: testImage,
      prompt: ACP.prompt.buildConnectionTest(),
      systemPrompt: 'You are a connectivity test. Reply with JSON only.',
      maxTokens: 64,
      temperature: 0,
      signal: record.controller.signal,
      record: record
    });

    return {
      ok: true,
      message: provider.label + ' · ' + model + ' responded.',
      sample: text.slice(0, 160),
      vision: vision.status,
      usedImage: !!supplied
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ *
 * Content-script injection / panel toggling
 * ------------------------------------------------------------------ */

const RESTRICTED_URL = /^(chrome|chrome-extension|chrome-search|chrome-untrusted|devtools|edge|about|view-source|brave|opera|vivaldi):/i;
const WEB_STORE_URL = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

function isRestrictedUrl(url) {
  if (!url) return false;
  return RESTRICTED_URL.test(url) || WEB_STORE_URL.test(url);
}

async function pingTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
    return !!(response && response.ok);
  } catch (error) {
    return false;
  }
}

async function ensureContentScript(tabId) {
  if (await pingTab(tabId)) return true;
  // No insertCSS: overlay.css is loaded into the overlay's shadow root by
  // content.js, so the host page is never restyled.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ACP.CONTENT_SCRIPTS.slice() });
    return true;
  } catch (error) {
    console.warn('[ACP] could not inject the overlay into this tab:', error && error.message);
    return false;
  }
}

async function togglePanelForTab(tab) {
  if (!tab || typeof tab.id !== 'number') return;
  if (isRestrictedUrl(tab.url)) {
    await setBadge(tab.id, '×', '#b91c1c');
    return;
  }
  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    await setBadge(tab.id, '!', '#b91c1c');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: MSG.TOGGLE_PANEL });
  } catch (error) {
    console.warn('[ACP] toggle failed:', error && error.message);
  }
}

async function setBadge(tabId, text, color) {
  // The badge is cosmetic: never let it break the toggle flow.
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color || '#2563eb' });
  } catch (error) {
    /* ignore */
  }
  try {
    await chrome.action.setBadgeText({ tabId: tabId, text: text || '' });
  } catch (error) {
    return;
  }
  setTimeout(function () {
    try {
      const cleared = chrome.action.setBadgeText({ tabId: tabId, text: '' });
      if (cleared && typeof cleared.catch === 'function') cleared.catch(function () {});
    } catch (error) {
      /* the tab may be gone */
    }
  }, 2500);
}

async function openOptions() {
  try {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  } catch (error) {
    throw ExtensionError(ERR.UNKNOWN, 'Could not open the settings page: ' + (error && error.message));
  }
}

/* ------------------------------------------------------------------ *
 * Settings messages
 * ------------------------------------------------------------------ */

/**
 * Preferences a content script / panel is allowed to persist.
 * Deliberately excludes `apiKeys`: keys can only be written by the options page
 * (which talks to chrome.storage directly) and never travel through messages.
 */
const WRITABLE_PREFS = [
  'providerId',
  'model',
  'baseUrl',
  'timeframe',
  'candleCount',
  'liveEnabled',
  'liveIntervalSec',
  'panel'
];

function pickWritablePrefs(patch) {
  const safe = {};
  WRITABLE_PREFS.forEach(function (key) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) safe[key] = patch[key];
  });
  return safe;
}

async function handleSaveSettings(patch) {
  const current = await ACP.settings.read();
  const next = ACP.settings.deepMerge(current, pickWritablePrefs(patch));
  await ACP.settings.write(next);
  return { ok: true, settings: ACP.settings.redact(next) };
}

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  // Only accept messages that originate inside this extension.
  if (sender && sender.id && sender.id !== chrome.runtime.id) return false;
  const type = message && message.type;

  let task = null;

  try {
    switch (type) {
      case MSG.PING:
        sendResponse({ ok: true, version: ACP.VERSION, alive: true });
        return false;

      case MSG.CANCEL:
        sendResponse(handleCancel(message.requestId));
        return false;

      // Programmatic capture hook (used by automation and manual debugging).
      // Analyse uses captureVisible() internally through MSG.ANALYZE.
      case MSG.CAPTURE:
        task = captureVisible(sender).then(function (dataUrl) {
          return { ok: true, dataUrl: dataUrl };
        });
        break;

      case MSG.ANALYZE:
        task = handleAnalyze(message.payload || {}, sender);
        break;

      case MSG.TEST_CONNECTION:
        task = handleTestConnection(message.payload || {});
        break;

      case MSG.GET_SETTINGS:
        task = ACP.settings.getPublic().then(function (settings) {
          return { ok: true, settings: settings };
        });
        break;

      case MSG.SAVE_SETTINGS: {
        // Two legitimate senders: the options page (an extension URL) and the
        // floating panel running as a content script (which carries sender.tab).
        // Web pages cannot reach this listener at all: the manifest declares no
        // externally_connectable, and sender.id is verified above.
        const fromExtensionPage = !!sender && !!sender.url && sender.url.indexOf(chrome.runtime.getURL('')) === 0;
        const fromContentScript = !!sender && !!sender.tab && typeof sender.tab.id === 'number';
        if (!fromExtensionPage && !fromContentScript) {
          throw ExtensionError(ERR.FORBIDDEN, 'Settings can only be changed from the extension pages.');
        }
        task = handleSaveSettings(message.settings || {});
        break;
      }

      case MSG.OPEN_OPTIONS:
        task = openOptions();
        break;

      case MSG.TOGGLE_PANEL:
        task = (async function () {
          const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!tabs || !tabs[0]) throw ExtensionError(ERR.NO_TAB, 'No active tab.');
          await togglePanelForTab(tabs[0]);
          return { ok: true };
        })();
        break;

      default:
        return false;
    }
  } catch (error) {
    sendResponse({ ok: false, error: normalizeError(error) });
    return false;
  }

  task
    .then(function (result) {
      sendResponse(result);
    })
    .catch(function (error) {
      sendResponse({ ok: false, error: normalizeError(error) });
    });

  return true; // async response
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

chrome.action.onClicked.addListener(function (tab) {
  Promise.resolve(togglePanelForTab(tab)).catch(function (error) {
    console.warn('[ACP] could not show the panel:', error && error.message);
  });
});

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(function (command) {
    if (command !== 'toggle-panel') return;
    chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then(function (tabs) {
        if (tabs && tabs[0]) togglePanelForTab(tabs[0]);
      })
      .catch(function () {});
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  verifyContentScriptList();
  if (details.reason === 'install') {
    // First run: open Settings so the user can paste a key straight away.
    chrome.runtime.openOptionsPage().catch(function () {});
  }
});

chrome.runtime.onStartup.addListener(function () {
  verifyContentScriptList();
});

/**
 * Guard against manifest.json and utils/constants.js drifting apart, which
 * would make programmatic injection load the wrong files in the wrong order.
 */
function verifyContentScriptList() {
  try {
    const manifest = chrome.runtime.getManifest();
    const declared = (manifest.content_scripts && manifest.content_scripts[0] && manifest.content_scripts[0].js) || [];
    if (declared.join('|') !== ACP.CONTENT_SCRIPTS.join('|')) {
      console.error('[ACP] manifest content_scripts.js does not match ACP.CONTENT_SCRIPTS', declared);
    }
  } catch (error) {
    console.warn('[ACP] could not verify content script list', error);
  }
}

verifyContentScriptList();
