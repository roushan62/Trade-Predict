'use strict';

/**
 * Minimal chrome.* mock used by the test harness.
 *
 * It implements just enough of the extension APIs for background.js,
 * content.js and options.js to run head-less:
 *   runtime.onMessage/sendMessage, storage.local + onChanged, tabs, action,
 *   commands, scripting, runtime.getURL/getManifest/openOptionsPage.
 *
 * `dispatchMessage()` invokes the registered runtime.onMessage listeners the
 * same way Chrome does (return true => async sendResponse).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SETTINGS_KEY = 'acpSettingsV1';

function createChromeMock(options) {
  const opts = options || {};

  /**
   * Optional shared backend so several mock contexts (background worker,
   * content page, options page) can act on one chrome.storage.
   */
  const shared = opts.shared || {
    storage: Object.assign({}, opts.storage || {}),
    changeListeners: []
  };

  const state = {
    storage: shared.storage,
    messageListeners: [],
    changeListeners: shared.changeListeners,
    fetchCalls: [],
    fetchHandler: opts.fetchHandler || null,
    captureCalls: [],
    captureImpl: opts.captureImpl || async function () {
      return 'data:image/jpeg;base64,/9j/AAAB';
    },
    activeTabId: typeof opts.activeTabId === 'number' ? opts.activeTabId : 7,
    windowId: 3,
    tabMessages: [],
    badgeCalls: [],
    injectedCss: [],
    executedScripts: [],
    openedOptions: 0,
    lastError: undefined,
    sendMessageImpl: opts.sendMessageImpl || null
  };

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  function fireChange(changes) {
    state.changeListeners.forEach(function (listener) {
      try {
        listener(changes, 'local');
      } catch (error) {
        console.error('change listener failed', error);
      }
    });
  }

  function storageGet(keys, callback) {
    const result = {};
    if (keys == null) {
      Object.assign(result, state.storage);
    } else if (typeof keys === 'string') {
      if (keys in state.storage) result[keys] = state.storage[keys];
    } else if (Array.isArray(keys)) {
      keys.forEach(function (key) {
        if (key in state.storage) result[key] = state.storage[key];
      });
    } else {
      Object.keys(keys).forEach(function (key) {
        result[key] = key in state.storage ? state.storage[key] : keys[key];
      });
    }
    const copy = JSON.parse(JSON.stringify(result));
    Promise.resolve().then(function () {
      if (typeof callback === 'function') callback(copy);
    });
    return Promise.resolve(copy);
  }

  function storageSet(items, callback) {
    const changes = {};
    Object.keys(items || {}).forEach(function (key) {
      changes[key] = { oldValue: state.storage[key], newValue: items[key] };
      state.storage[key] = JSON.parse(JSON.stringify(items[key]));
    });
    Promise.resolve().then(function () {
      if (typeof callback === 'function') callback();
      fireChange(changes);
    });
    return Promise.resolve();
  }

  function storageRemove(keys, callback) {
    const list = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    list.forEach(function (key) {
      changes[key] = { oldValue: state.storage[key], newValue: undefined };
      delete state.storage[key];
    });
    Promise.resolve().then(function () {
      if (typeof callback === 'function') callback();
      fireChange(changes);
    });
    return Promise.resolve();
  }

  function storageClear(callback) {
    state.storage = {};
    Promise.resolve().then(function () {
      if (typeof callback === 'function') callback();
    });
    return Promise.resolve();
  }

  const storageArea = {
    get: storageGet,
    set: storageSet,
    remove: storageRemove,
    clear: storageClear
  };

  const chrome = {
    runtime: {
      id: 'acp-test-extension',
      get lastError() {
        return state.lastError;
      },
      getURL: function (relative) {
        return 'chrome-extension://acp-test-extension/' + String(relative).replace(/^\//, '');
      },
      getManifest: function () {
        return JSON.parse(JSON.stringify(manifest));
      },
      onMessage: {
        addListener: function (listener) {
          state.messageListeners.push(listener);
        },
        removeListener: function (listener) {
          state.messageListeners = state.messageListeners.filter(function (item) {
            return item !== listener;
          });
        }
      },
      onInstalled: { addListener: function () {} },
      onStartup: { addListener: function () {} },
      onConnect: { addListener: function () {} },
      sendMessage: function (message, callback) {
        if (typeof state.sendMessageImpl === 'function') {
          return state.sendMessageImpl(message, callback);
        }
        dispatchMessage(message, { id: 'acp-test-extension', url: 'chrome-extension://acp-test-extension/page' })
          .then(function (response) {
            if (typeof callback === 'function') callback(response);
          })
          .catch(function () {
            if (typeof callback === 'function') callback(undefined);
          });
        return Promise.resolve();
      },
      openOptionsPage: function () {
        state.openedOptions += 1;
        return Promise.resolve();
      }
    },
    storage: {
      local: storageArea,
      sync: storageArea,
      session: storageArea,
      onChanged: {
        addListener: function (listener) {
          state.changeListeners.push(listener);
        },
        removeListener: function (listener) {
          state.changeListeners = state.changeListeners.filter(function (item) {
            return item !== listener;
          });
        }
      }
    },
    tabs: {
      query: function () {
        const active = { id: state.activeTabId, windowId: state.windowId, url: 'https://example.com/chart', active: true };
        return Promise.resolve([active]);
      },
      get: function (tabId) {
        return Promise.resolve({ id: tabId, windowId: state.windowId });
      },
      captureVisibleTab: function (windowId, captureOptions) {
        state.captureCalls.push({ windowId: windowId, options: captureOptions });
        return Promise.resolve(state.captureImpl(windowId, captureOptions, state.captureCalls.length));
      },
      sendMessage: function (tabId, message) {
        state.tabMessages.push({ tabId: tabId, message: message });
        return Promise.resolve({ ok: true });
      }
    },
    action: {
      onClicked: { addListener: function () {} },
      setBadgeText: function (details) {
        state.badgeCalls.push({ type: 'text', details: details });
        return Promise.resolve();
      },
      setBadgeBackgroundColor: function (details) {
        state.badgeCalls.push({ type: 'color', details: details });
        return Promise.resolve();
      }
    },
    commands: {
      onCommand: { addListener: function () {} }
    },
    scripting: {
      insertCSS: function (details) {
        state.injectedCss.push(details);
        return Promise.resolve();
      },
      executeScript: function (details) {
        state.executedScripts.push(details);
        return Promise.resolve([]);
      }
    },
    permissions: {
      contains: function () {
        return Promise.resolve(true);
      }
    }
  };

  /** fetch() replacement: routes every call through state.fetchHandler. */
  function fetchImpl(url, init) {
    state.fetchCalls.push({ url: String(url), init: init || {} });
    const handler = state.fetchHandler;
    if (typeof handler !== 'function') {
      return Promise.reject(new Error('Unexpected network call in test: ' + url));
    }
    return Promise.resolve(handler(String(url), init || {}, state.fetchCalls.length)).then(function (response) {
      if (!response) throw new Error('fetch handler returned nothing');
      if (response instanceof Error) throw response;
      const body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body || {});
      const status = typeof response.status === 'number' ? response.status : 200;
      return {
        ok: status >= 200 && status < 300,
        status: status,
        statusText: String(status),
        headers: { get: function () { return null; } },
        text: function () {
          return Promise.resolve(body);
        },
        json: function () {
          return Promise.resolve(JSON.parse(body));
        }
      };
    });
  }

  /**
   * Deliver a message to every registered runtime.onMessage listener.
   * Resolves with the sendResponse payload (or undefined).
   */
  function dispatchMessage(message, sender) {
    return new Promise(function (resolve) {
      let responded = false;
      let asyncKept = false;

      function sendResponse(payload) {
        if (responded) return;
        responded = true;
        resolve(payload);
      }

      const listeners = state.messageListeners.slice();
      for (let i = 0; i < listeners.length; i += 1) {
        const keepOpen = listeners[i](message, sender, sendResponse);
        if (keepOpen === true) asyncKept = true;
        if (responded) return;
      }

      if (!asyncKept) {
        // Nothing claimed the message — mimic "no receiver".
        setTimeout(function () {
          resolve(undefined);
        }, 20);
      }
    });
  }

  function setSettings(partial) {
    return storageSet((function () {
      const payload = {};
      payload[SETTINGS_KEY] = partial;
      return payload;
    })());
  }

  function readSettings() {
    return JSON.parse(JSON.stringify(state.storage[SETTINGS_KEY] || {}));
  }

  return {
    chrome: chrome,
    state: state,
    shared: shared,
    dispatchMessage: dispatchMessage,
    fetch: fetchImpl,
    setSettings: setSettings,
    readSettings: readSettings,
    SETTINGS_KEY: SETTINGS_KEY,
    ROOT: ROOT
  };
}

module.exports = { createChromeMock: createChromeMock, ROOT: ROOT, SETTINGS_KEY: SETTINGS_KEY };
