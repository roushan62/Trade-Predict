/**
 * AI Chart Predictor — shared constants.
 *
 * This file is loaded in three different JavaScript contexts:
 *   1. the MV3 background service worker (through importScripts)
 *   2. the content script (listed in manifest.json)
 *   3. the options page (through a regular <script> tag)
 *
 * It therefore never uses ES module syntax and attaches everything to a single
 * global namespace object: `ACP`.
 */
(function (global) {
  'use strict';

  const ACP = (global.ACP = global.ACP || {});

  ACP.VERSION = '1.0.0';

  /** Every setting lives in a single chrome.storage.local document. */
  ACP.STORAGE_KEY = 'acpSettingsV1';

  /** Message types used for chrome.runtime messaging. */
  ACP.MSG = Object.freeze({
    PING: 'ACP_PING',
    TOGGLE_PANEL: 'ACP_TOGGLE_PANEL',
    CAPTURE: 'ACP_CAPTURE',
    CAPTURED: 'ACP_CAPTURED',
    ANALYZE: 'ACP_ANALYZE',
    CANCEL: 'ACP_CANCEL',
    TEST_CONNECTION: 'ACP_TEST_CONNECTION',
    GET_SETTINGS: 'ACP_GET_SETTINGS',
    SAVE_SETTINGS: 'ACP_SAVE_SETTINGS',
    OPEN_OPTIONS: 'ACP_OPEN_OPTIONS'
  });

  /** Timeframes offered in the UI. */
  ACP.TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W']);

  /** How many future candles the AI may predict. */
  ACP.CANDLE_COUNTS = Object.freeze([1, 2, 3, 4, 5]);

  /** Live-mode refresh intervals (seconds). */
  ACP.LIVE_INTERVALS = Object.freeze([
    { value: 10, label: '10 seconds' },
    { value: 30, label: '30 seconds' },
    { value: 60, label: '1 minute' },
    { value: 300, label: '5 minutes' }
  ]);

  /** Stop live mode after this many consecutive failures. */
  ACP.MAX_LIVE_ERRORS = 5;

  /** Hard timeout for one provider round-trip. */
  ACP.ANALYSIS_TIMEOUT_MS = 100000;

  /** One normal attempt + one JSON-repair attempt. */
  ACP.MAX_JSON_ATTEMPTS = 2;

  /** Defaults used when nothing has been stored yet. */
  ACP.DEFAULT_SETTINGS = Object.freeze({
    providerId: 'openrouter',
    model: 'openai/gpt-4o',
    baseUrl: '',
    timeframe: '15m',
    candleCount: 3,
    liveEnabled: false,
    liveIntervalSec: 30,
    apiKeys: {},
    panel: { left: null, top: null, collapsed: false }
  });

  /** Shown in the panel, the options page and the README. */
  ACP.DISCLAIMER = 'AI prediction is not financial advice. Trading involves risk.';

  /**
   * Content-script files in injection order.
   * Used by background.js when it has to inject the UI into a tab that was
   * already open before the extension was installed or reloaded.
   * KEEP IN SYNC with manifest.json -> content_scripts[0].js
   * (background.js verifies this at start-up and logs any drift).
   */
  ACP.CONTENT_SCRIPTS = Object.freeze([
    'utils/constants.js',
    'utils/coords.js',
    'utils/settings.js',
    'providers/index.js',
    'providers/openai.js',
    'providers/openrouter.js',
    'providers/gemini.js',
    'providers/anthropic.js',
    'providers/deepseek.js',
    'providers/mistral.js',
    'providers/groq.js',
    'providers/xai.js',
    'providers/custom.js',
    'panel.js',
    'content.js'
  ]);

  /** Stable error codes shared between background and UI. */
  ACP.ERROR_CODES = Object.freeze({
    NO_API_KEY: 'NO_API_KEY',
    UNKNOWN_PROVIDER: 'UNKNOWN_PROVIDER',
    MISSING_MODEL: 'MISSING_MODEL',
    MISSING_BASE_URL: 'MISSING_BASE_URL',
    MODEL_NO_VISION: 'MODEL_NO_VISION',
    NO_TAB: 'NO_TAB',
    TAB_NOT_ACTIVE: 'TAB_NOT_ACTIVE',
    CAPTURE_FAILED: 'CAPTURE_FAILED',
    RESTRICTED_PAGE: 'RESTRICTED_PAGE',
    RATE_LIMIT: 'RATE_LIMIT',
    QUOTA: 'QUOTA',
    AUTH: 'AUTH',
    FORBIDDEN: 'FORBIDDEN',
    NOT_FOUND: 'NOT_FOUND',
    BAD_REQUEST: 'BAD_REQUEST',
    PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
    SERVER: 'SERVER',
    NETWORK: 'NETWORK',
    TIMEOUT: 'TIMEOUT',
    CANCELLED: 'CANCELLED',
    EMPTY_RESPONSE: 'EMPTY_RESPONSE',
    BAD_JSON: 'BAD_JSON',
    UNKNOWN: 'UNKNOWN'
  });

  /** Promise-based sleep helper (used for retry back-off and paint waits). */
  ACP.sleep = function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  };
})(typeof self !== 'undefined' ? self : this);
