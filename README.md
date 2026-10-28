# AI Chart Predictor

A Chrome extension (Manifest V3) that screenshots the chart on your active tab, asks a
**vision AI** for a full technical analysis, and **draws the answer back on top of your chart** —
support/resistance, supply/demand zones, trendlines, entry/SL/TP levels and **ghost candles**
for the next 1–5 candles of the timeframe you pick.

Works on TradingView, Binance, Coinbase, Zerodha Kite, Upstox, MT5 web, Investing.com,
Yahoo Finance — any page where a chart is visible.

> ⚠️ **AI prediction is not financial advice. Trading involves risk.**

---

## Table of contents

1. [Install](#1-install)
2. [Add an API key](#2-add-an-api-key)
3. [Use it](#3-use-it)
4. [Features](#4-features)
5. [Providers and vision models](#5-providers-and-vision-models)
6. [How the coordinates work](#6-how-the-coordinates-work)
7. [Troubleshooting](#7-troubleshooting)
8. [Privacy and security](#8-privacy-and-security)
9. [Project structure](#9-project-structure)
10. [Development](#10-development)

---

## 1. Install

1. Download or clone this repository.
   ```bash
   git clone https://github.com/roushan62/Trade-Predict.git
   ```
2. Open Chrome (or any Chromium browser: Edge, Brave, Arc, Opera) and go to
   **`chrome://extensions`**.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder — the one that contains
   `manifest.json`.
5. The **AI Chart Predictor** icon appears in the toolbar. Pin it if you like
   (puzzle-piece icon → pin).

No build step, no npm install, no dependencies. Everything is plain JS/CSS/HTML.

> After editing any file, press the **reload** button on the extension card in
> `chrome://extensions` and **refresh your chart tab** (content scripts only re-attach
> after a reload).

---

## 2. Add an API key

On first install the Settings page opens automatically. You can always reopen it from:

- the toolbar icon → right-click → **Options**, or
- `chrome://extensions` → **AI Chart Predictor** → **Details** → **Extension options**, or
- the **Settings** link at the bottom of the floating panel.

Then:

1. Choose a **Provider**.
2. Keep the suggested **Model** or type any vision-capable model name.
3. Paste your **API key** (a password field — press **Show** to check it).
4. Press **Test connection**. Optionally pick a screenshot file first: with an image
   attached the test also proves the model accepts images.
5. Press **Save changes**.

Keys are stored in `chrome.storage.local` only and are sent to the selected provider and nowhere else.

### Where to get keys

| Provider | Key page | Free tier |
| --- | --- | --- |
| OpenRouter | <https://openrouter.ai/keys> | Some free vision models |
| OpenAI | <https://platform.openai.com/api-keys> | Paid |
| Google Gemini | <https://aistudio.google.com/app/apikey> | Yes (rate limited) |
| Anthropic | <https://console.anthropic.com/settings/keys> | Paid |
| DeepSeek | <https://platform.deepseek.com/api_keys> | Paid, **text-only models** |
| Mistral | <https://console.mistral.ai/api-keys> | Limited |
| Groq | <https://console.groq.com/keys> | Yes |
| xAI Grok | <https://console.x.ai/> | Paid |
| Custom | your own endpoint (Ollama, LM Studio, LiteLLM, vLLM…) | Local / free |

---

## 3. Use it

1. Open a chart in a tab and make sure it is the **active tab**.
2. Press **`Alt+Shift+A`** (or click the toolbar icon) to show the panel.
   You can change the shortcut at `chrome://extensions/shortcuts`.
3. Pick the **Timeframe** (1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W) and how many **Candles** to predict (1–5).
4. Press **Analyze chart**.
   - The panel hides itself for a moment so the screenshot contains only the chart.
   - The screenshot is captured, sent to your provider, validated, and drawn on top of the page.
5. Read the **result card**: trend, confidence, entry / stop / TP1 / TP2, market structure,
   risk:reward, patterns and the model's reasoning.
6. **Drag** the predicted candles anywhere on the screen to compare them with the real chart.
7. Press **Clear** to remove every drawing.

### Live mode

Flip **Live Mode** on and choose **10 s / 30 s / 1 min / 5 min**. The extension
re-captures, re-analyses and redraws automatically:

- requests never overlap (a tick is skipped while one is running),
- ticks are skipped while the tab is hidden,
- transient failures are retried with back-off,
- Live Mode stops automatically after 5 consecutive failures, or immediately on
  authentication / quota / restricted-page errors,
- the status line shows a countdown to the next refresh.

> Live Mode costs one API call per tick. Keep 1–5 minutes for paid keys and mind the
> provider's rate limits. The button also stays disabled while an analysis is running.

---

## 4. Features

- **Screen access** — `chrome.tabs.captureVisibleTab` (JPEG, quality 82), only when you ask for it.
- **Transparent overlay** — a full-screen `<canvas>` with `pointer-events: none`, plus a
  dedicated pointer-enabled drag handle for the ghost candles and the panel.
- **Shadow DOM** — the UI and the page cannot style each other, and no page CSS can break the panel.
- **Timeframes** — 1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W; the prompt tells the model which timeframe
  the visible candles represent and asks for predictions of that same timeframe.
- **Analysis** — trend, market structure (HH/HL/LH/LL), support/resistance, supply/demand zones,
  candlestick + chart patterns, trendlines, indicators (RSI/MACD/MA/volume when visible),
  entry / SL / TP1 / TP2, risk:reward, confidence, reasoning, and the next N OHLC candles.
- **Strict JSON** — the reply is extracted (markdown fences, prose, trailing commas are tolerated),
  validated field by field, and **retried once** with an explicit repair prompt when invalid.
- **Drawing** — levels (with prices), semi-transparent zones, trendlines with arrow heads,
  entry/SL/TP lines with labels + risk/reward shading, and dashed **ghost candles**
  (green = bullish, red = bearish) grouped in a dashed outline that says *drag me*.
- **Dragging** — smooth pointer dragging with mouse, pen and touch (`pointer events` +
  `setPointerCapture` + `touch-action: none`), clamped to the viewport.
- **Live mode** — see above.
- **Multi-provider** — one adapter per provider, all network calls inside the service worker.
- **Errors** — invalid key, no internet, quota/rate limit, model without vision, oversized image,
  invalid JSON, restricted pages (`chrome://`, Web Store, PDF viewer), tab switched away.
- **HiDPI correct** — the canvas is sized in CSS pixels and scaled by `devicePixelRatio`,
  rebuilt on resize/orientation change.

---

## 5. Providers and vision models

| Provider | Request format | Notes |
| --- | --- | --- |
| **OpenRouter** | OpenAI chat completions | Any vision model by any vendor, e.g. `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`, `google/gemini-2.0-flash-001` |
| **OpenAI** | OpenAI chat completions | `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-5`, `o4-mini`, `o3` |
| **Google Gemini** | `generateContent` + `inline_data` | `gemini-2.0-flash`, `gemini-2.5-pro`, `gemini-1.5-*` |
| **Anthropic** | `messages` + base64 image block | `claude-3-5-sonnet-latest`, `claude-sonnet-4-20250514` |
| **DeepSeek** | OpenAI-compatible | **Text-only models** — the UI blocks them with a warning |
| **Mistral** | OpenAI-compatible | `pixtral-large-latest`, `pixtral-12b-2409` |
| **Groq** | OpenAI-compatible | `meta-llama/llama-4-scout-*`, `llama-4-maverick-*` |
| **xAI Grok** | OpenAI-compatible | `grok-2-vision-1212`, `grok-3`, `grok-4` |
| **Custom** | OpenAI-compatible | Any base URL + model; no key needed for local servers |

Model names in the dropdown are suggestions — the field next to it is editable, so a newly
released model works without touching the code. If a model looks text-only, the panel and the
options page show an orange/red warning before you spend a request on it.

**Custom provider examples**

| Server | Base URL | Model |
| --- | --- | --- |
| Ollama | `http://localhost:11434/v1` | `llava`, `qwen2.5vl`, `llama3.2-vision` |
| LM Studio | `http://localhost:1234/v1` | whatever is loaded |
| vLLM | `http://localhost:8000/v1` | your served model |
| LiteLLM proxy | `https://your-proxy/v1` | any proxied model |

CORS: local servers must allow the extension origin. Ollama allows it when started with
`OLLAMA_ORIGINS=chrome-extension://*` (or `*`).

---

## 6. How the coordinates work

The prompt asks the model for **normalised coordinates** (0 = top/left edge, 1 = bottom/right
edge of the screenshot), which makes the mapping independent of screen size and HiDPI:

```
pixelX = x * screenWidth          (CSS pixels, canvas scaled by devicePixelRatio)
pixelY = y * screenHeight
```

Price → pixel conversion uses, in order of preference:

1. `price_scale` — two reference points (`price` + `y`) returned by the model,
2. two support/resistance levels that include both `price` and `y`,
3. an automatic fit that stretches the predicted candles into a band around the last candle.

If the model answers in percentages (`71` instead of `0.71`) the values are detected and
divided by 100. If it answers without a `last_candle` anchor, the ghost candles are placed just
right of centre and the user can drag them into place.

Drawings follow window resizes and page scrolls. The ghost candles are placed in screen space
on purpose — you position them by hand, and the offset survives Live Mode refreshes until you
press **Clear**.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| *"Chrome does not allow screenshots on this page"* | `chrome://`, the Chrome Web Store, the PDF viewer and the new-tab page are off-limits. Use a normal web page. |
| *"This tab is no longer the active tab"* | If you switch tabs during analysis the capture would show another page, so it is refused. Switch back and press Analyze again. |
| *"Chrome limits screenshots to a few per second"* | `captureVisibleTab` is throttled; wait a second. Very short Live intervals (10 s) on multiple tabs can trigger it. |
| *"No … API key is saved"* | Add the key in Settings → **Save changes**, then refresh the chart tab. |
| *"… cannot analyse images"* | Pick a vision model. DeepSeek chat and Llama 3.x text models cannot read screenshots. |
| *"The model did not return valid analysis JSON after 2 attempts"* | Small/fast models often fail this. Use a stronger vision model (GPT-4o, Gemini 2.x Flash, Claude Sonnet, Llama 4 Maverick) and predict fewer candles. |
| *Rate limit / 429* | Slow Live Mode down (1 min or 5 min) or upgrade the provider plan. |
| *Blank panel on a site* | Some sites use a very high z-index or `transform` on `<html>`. Reload the tab; if it persists, report the site. |
| Panel does not appear after install | Content scripts only attach to tabs loaded after install. Reload the tab, or press `Alt+Shift+A` (the background injects the scripts on demand). |
| Nothing happens on `Alt+Shift+A` | The shortcut may conflict with the site. Change it at `chrome://extensions/shortcuts`. |
| Panel works but `file://` charts do not | Chrome blocks extensions on local files until you enable **Allow access to file URLs** on the extension's details page. |
| *"answered with a web page instead of an API response"* | The Custom provider's base URL is wrong. It must point at the API root, e.g. `https://api.openai.com/v1` or `http://localhost:11434/v1`. |
| Ollama requests fail with CORS | Start Ollama with `OLLAMA_ORIGINS=chrome-extension://*` so the extension origin is allowed. |

---

## 8. Privacy and security

- **Keys** live in `chrome.storage.local`. They are never written to the page, never logged and
  never sent anywhere except the provider you selected (header only — never in a URL).
- **Content script** receives a redacted settings copy (`apiKeys` stripped, only a `••••1234`
  hint), so even a compromised page cannot read your keys.
- **Network calls** happen exclusively in the background service worker via `fetch`.
- **Capture** only happens when you press Analyze or Live Mode fires.
- **No telemetry, no analytics, no remote code** — everything is packaged in this folder.
- The extension has a broad host permission (`<all_urls>`) because it must run on any chart
  site and needs to reach any provider endpoint. It only acts when you trigger it.

---

## 9. Project structure

```
manifest.json              MV3 manifest (permissions, content scripts, command, options page)
background.js              service worker: capture, provider calls, JSON retry, message router
content.js                 overlay canvas, drawing, ghost-candle dragging, live mode
panel.js                   floating control panel (shadow DOM UI)
overlay.css                panel + overlay styling (loaded into the shadow root)
options.html               settings page markup
options.css                settings page styling
options.js                 settings page logic (keys, models, test connection)
providers/
  index.js                 registry, vision heuristics, OpenAI-compatible adapter factory
  openai.js                OpenAI (incl. reasoning-model quirks)
  openrouter.js            OpenRouter
  gemini.js                Google Gemini generateContent
  anthropic.js             Anthropic messages API
  deepseek.js              DeepSeek
  mistral.js               Mistral / Pixtral
  groq.js                  Groq
  xai.js                   xAI Grok
  custom.js                any OpenAI-compatible endpoint
utils/
  constants.js             shared constants, message types, default settings, content-script list
  coords.js                coordinate mapper + price-scale math
  schema.js                strict JSON extraction/validation (the "json validator")
  settings.js              chrome.storage.local wrapper (read/write/redact)
  prompt.js                the analysis prompt + repair prompt
icons/
  icon16.png icon48.png icon128.png      real generated PNGs (checkerboard-free RGBA)
tools/
  generate-icons.py        regenerates the icons (standard library only)
test/
  run-tests.js             unit + integration tests for utils, adapters and the worker router
  dom-tests.js             content-script tests in a simulated page (overlay, draw, drag, live)
  options-tests.js         settings page tests (keys, providers, save, test connection)
  e2e-tests.js             options page → storage → worker → provider → overlay, end to end
  mock-chrome.js           minimal chrome.* mock shared by the test suites
package.json               dev tooling only (jsdom for the tests) — the extension itself has none
```

### How one analysis flows

```
panel "Analyze"
      │  MSG.ANALYZE {timeframe, candleCount, viewport}
      ▼
content.js ── hides the panel so the screenshot shows only the chart
      │
      ▼
background.js
  1. validate settings  (provider → model → key → base URL → vision support)
  2. chrome.tabs.captureVisibleTab(windowId, {format:'jpeg', quality:82})
  3. notify content.js (MSG.CAPTURED) so the panel comes back
  4. build the prompt (timeframe + candle count + JSON schema example)
  5. provider adapter → fetch()  (keys stay in this worker)
  6. extract JSON → validate → ON FAILURE retry once with a repair prompt
      │  {ok, analysis, warnings, meta}
      ▼
content.js ── maps normalised coordinates to pixels, draws, keeps the ghost
              candles draggable until Clear
```

---

## 10. Development

The extension itself has **zero runtime dependencies**. The tests use
[jsdom](https://github.com/jsdom/jsdom) to run the real `content.js`, `panel.js`, `options.js`
and `background.js` against a mocked `chrome.*` and `fetch`, so no browser install is needed.

```bash
npm install          # installs jsdom (dev only)
npm test             # runs all four suites

npm run test:unit    # node test/run-tests.js     – 94 tests
npm run test:dom     # node test/dom-tests.js     – 38 tests
npm run test:options # node test/options-tests.js – 22 tests
npm run test:e2e     # node test/e2e-tests.js     – 21 tests
```

| Suite | What it proves |
| --- | --- |
| `run-tests.js` | manifest validity (MV3, permissions, every referenced file, PNG headers, `node --check` on all sources), JSON extraction/repair, schema normalisation (string numbers, percentages, padded/truncated candles), the coordinate mapper, every provider's URL/headers/body + response parser, settings merge/redact, prompts, the worker router (auth, quota, 5xx retry, network, restricted page, tab switch, cancel, secret redaction), and static wiring (message types, DOM ids) |
| `dom-tests.js` | the overlay mounts once in a shadow root, canvas sizing with `devicePixelRatio`, point-events, result card, labels/zones/trendlines/ghost candles drawn, drag + clamping + stale pointer ids, resize with an offset preserved, live-mode timer hygiene (no duplicate intervals), fatal-error stop, settings propagation, collapse/panel drag, Clear and Alt+Shift+A toggling |
| `options-tests.js` | provider switching, per-provider key drafts, show/hide, text-only warnings, save/merge rules, custom base URL validation, "Test connection" success/failure, uploaded screenshot forwarding, no key in the DOM |
| `e2e-tests.js` | the real options page writes storage → the real worker captures, calls the provider adapter, validates and returns → the real content script draws → drag → resize → clear, plus auth failure, text-only refusal, restricted page, invalid-JSON retry, connection test, live refresh without overlap, double-click concurrency, in-flight cancellation and re-injection of a live vs. orphaned content script |

Regenerate the icons after changing the drawing code:

```bash
npm run icons        # python3 tools/generate-icons.py
```

### Manual test checklist

1. Load the extension, add a key, press **Test connection** → green status.
2. Open a chart, `Alt+Shift+A`, **Analyze chart** → drawings appear, result card fills in.
3. Drag the ghost candles across the chart → smooth, stays inside the window.
4. Resize the window → drawings stay aligned with the chart.
5. Toggle **Live Mode** (30 s) → countdown, fresh analysis, no overlapping requests.
6. Press **Clear** → everything disappears.
7. Open `chrome://version` and press `Alt+Shift+A` → nothing breaks (badge shows `×`).
8. Set an invalid key → clear "API key was rejected" error, no crash.
9. Set DeepSeek + `deepseek-chat` → "cannot analyse images" warning before any call.
10. Reload the extension, then press `Alt+Shift+A` on an already-open tab → the panel still appears.

---

MIT licensed. Built for personal research — not a signal service.
```
