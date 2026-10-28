/**
 * AI Chart Predictor — content script.
 *
 * Creates a full-screen canvas overlay + floating panel inside a shadow root,
 * asks the background worker to capture and analyse the tab, then draws the
 * result (levels, zones, trendlines, trade levels, ghost candles) on top of the
 * page. Predicted candles can be dragged anywhere on screen.
 */
(function () {
  'use strict';

  const ACP = self.ACP;

  if (!ACP || !ACP.MSG || !ACP.panel) {
    console.warn('[ACP] content script loaded without its dependencies — aborting.');
    return;
  }

  /* Re-injection must never build a second overlay. If the instance already on
     the page still belongs to a live extension (it was injected twice, or the
     page was re-focused) just show it again. If it was orphaned by an extension
     reload, its messaging APIs are dead — tear it down and start over. */
  const previousInstance = window.__AI_CHART_PREDICTOR;
  if (previousInstance && typeof previousInstance.openPanel === 'function') {
    let stillAlive = false;
    try {
      stillAlive = typeof previousInstance.isAlive === 'function' && previousInstance.isAlive() === true;
    } catch (error) {
      stillAlive = false;
    }
    if (stillAlive) {
      previousInstance.openPanel();
      return;
    }
    try {
      if (typeof previousInstance.destroy === 'function') previousInstance.destroy();
    } catch (error) {
      /* the orphan is beyond saving — carry on and replace it */
    }
  }

  const MSG = ACP.MSG;
  const coords = ACP.coords;
  const clamp = coords.clamp;
  const clamp01 = coords.clamp01;

  const FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", sans-serif';

  const COLORS = {
    support: '#22c55e',
    resistance: '#ef4444',
    level: '#94a3b8',
    demand: 'rgba(34, 197, 94, 0.12)',
    supply: 'rgba(239, 68, 68, 0.12)',
    neutral: 'rgba(148, 163, 184, 0.10)',
    demandStroke: 'rgba(34, 197, 94, 0.55)',
    supplyStroke: 'rgba(239, 68, 68, 0.55)',
    neutralStroke: 'rgba(148, 163, 184, 0.45)',
    trendline: '#60a5fa',
    entry: '#38bdf8',
    stop: '#ef4444',
    target: '#22c55e',
    bullish: '#22c55e',
    bullishFill: 'rgba(34, 197, 94, 0.30)',
    bearish: '#ef4444',
    bearishFill: 'rgba(239, 68, 68, 0.30)',
    ghostOutline: 'rgba(96, 165, 250, 0.65)',
    ghostLabel: '#bfdbfe',
    panelBg: 'rgba(9, 12, 20, 0.84)'
  };

  /** Minimal styling used if overlay.css cannot be loaded into the shadow root. */
  const FALLBACK_CSS = [
    ':host{all:initial}',
    '.acp-canvas{position:absolute;left:0;top:0;pointer-events:none}',
    '.acp-panel-container{position:absolute;inset:0;pointer-events:none}',
    '.acp-ghost-handle{position:absolute;pointer-events:auto;cursor:grab;touch-action:none}',
    '.acp-panel{position:fixed;top:72px;right:16px;width:360px;max-width:calc(100vw - 24px);',
    'background:#0f1420;color:#e5e7eb;font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
    'border:1px solid #263041;border-radius:12px;pointer-events:auto;box-shadow:0 18px 44px rgba(0,0,0,.55);z-index:2}',
    '.acp-panel__header{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move}',
    '.acp-panel__body{padding:0 12px 12px;display:flex;flex-direction:column;gap:8px}',
    '.acp-panel[data-collapsed="true"] .acp-panel__body{display:none}',
    '.acp-disclaimer{padding:6px 12px;font-size:10px;color:#94a3b8;border-top:1px solid #263041}'
  ].join('\n');

  const state = {
    host: null,
    shadow: null,
    canvas: null,
    ctx: null,
    handle: null,
    panel: null,
    viewport: { w: 1, h: 1, sx: 1, sy: 1, dpr: 1 },
    publicSettings: null,
    analysis: null,
    meta: null,
    warnings: [],
    ghost: null,
    lastAnchor: null,
    scrollOrigin: null,
    drag: null,
    rafId: 0,
    analyzing: false,
    requestId: null,
    suppressUser: false,
    suppressCapture: false,
    live: { enabled: false, timer: 0, ticker: 0, nextAt: 0, errors: 0 },
    saveTimer: 0,
    settingsTimer: 0,
    lastSavedDoc: null,
    pendingPatch: null,
    removeSettingsListener: null,
    disposed: false
  };

  /* ------------------------------------------------------------------ *
   * Messaging helpers
   * ------------------------------------------------------------------ */

  function sendMessage(message) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const done = function (fn, value) {
        if (settled) return;
        settled = true;
        fn(value);
      };
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) {
            done(reject, new Error(chrome.runtime.lastError.message || 'Messaging failed.'));
            return;
          }
          done(resolve, response);
        });
      } catch (error) {
        done(reject, error);
      }
    });
  }

  /** Runtime errors arrive as plain objects: { code, message, details }. */
  function makeError(payload, fallback) {
    const error = new Error((payload && payload.message) || fallback || 'Unknown error');
    error.code = (payload && payload.code) || 'UNKNOWN';
    return error;
  }

  /* ------------------------------------------------------------------ *
   * Overlay construction
   * ------------------------------------------------------------------ */

  function ensureHost() {
    if (state.host && state.host.isConnected) return true;
    const parent = document.documentElement || document.body;
    if (!parent) return false;

    const host = document.createElement('div');
    host.id = 'acp-root';
    host.style.cssText =
      'all: initial !important;' +
      'position: fixed !important;' +
      'inset: 0 !important;' +
      'z-index: 2147483647 !important;' +
      'pointer-events: none !important;' +
      'display: block !important;' +
      'visibility: visible !important;' +
      'opacity: 1 !important;' +
      'margin: 0 !important;' +
      'padding: 0 !important;' +
      'border: 0 !important;' +
      'transform: none !important;' +
      'filter: none !important;';

    const shadow = host.attachShadow({ mode: 'open' });

    // Fallback rules first, the packaged stylesheet second (it wins on order).
    const fallback = document.createElement('style');
    fallback.textContent = FALLBACK_CSS;
    shadow.appendChild(fallback);

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('overlay.css');
    shadow.appendChild(link);

    parent.appendChild(host);

    state.host = host;
    state.shadow = shadow;

    // Belt and braces: fetch the same sheet as text in case <link> is blocked.
    fetch(chrome.runtime.getURL('overlay.css'))
      .then(function (response) {
        return response.ok ? response.text() : '';
      })
      .then(function (css) {
        if (!css || !shadow.contains(link)) return;
        const inline = document.createElement('style');
        inline.textContent = css;
        shadow.insertBefore(inline, link);
      })
      .catch(function () {
        /* the fallback CSS above keeps the UI usable */
      });

    return true;
  }

  function buildOverlay() {
    const shadow = state.shadow;

    const canvas = document.createElement('canvas');
    canvas.className = 'acp-canvas';
    shadow.appendChild(canvas);

    const handle = document.createElement('div');
    handle.className = 'acp-ghost-handle';
    handle.hidden = true;
    handle.title = 'Drag the predicted candles anywhere';
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', 'Drag predicted candles');
    shadow.appendChild(handle);

    state.canvas = canvas;
    state.ctx = canvas.getContext('2d');
    state.handle = handle;

    handle.addEventListener('pointerdown', onGhostPointerDown);
    handle.addEventListener('pointermove', onGhostPointerMove);
    handle.addEventListener('pointerup', onGhostPointerUp);
    handle.addEventListener('pointercancel', onGhostPointerUp);
    // Stop the page from scrolling/zooming while dragging on touch devices.
    handle.addEventListener(
      'touchstart',
      function (event) {
        event.preventDefault();
      },
      { passive: false }
    );

    resizeCanvas();
  }

  function mountPanel() {
    const container = document.createElement('div');
    container.className = 'acp-panel-container';
    state.shadow.appendChild(container);

    state.panel = ACP.panel.mount({
      host: container,
      settings: state.publicSettings || ACP.DEFAULT_SETTINGS,
      callbacks: {
        onAnalyze: function () {
          runAnalysis({});
        },
        onClear: function () {
          stopLive(true);
          cancelAnalysis();
          clearAnalysis();
          state.panel.setStatus('Cleared.', {});
        },
        onQuickChange: function (patch) {
          savePrefs(patch);
          if (patch && patch.liveIntervalSec && state.live.enabled) {
            // Apply the new cadence right away instead of after the old wait.
            scheduleLive(patch.liveIntervalSec * 1000);
          }
        },
        onLiveChange: function (enabled) {
          // stopLive() persists liveEnabled=false; only the "on" case needs it.
          if (enabled) {
            startLive();
            savePrefs({ liveEnabled: true });
          } else {
            stopLive(false);
          }
        },
        onOpenOptions: function () {
          sendMessage({ type: MSG.OPEN_OPTIONS }).catch(function () {});
        },
        onPositionChange: function (position) {
          savePrefs({ panel: { left: position.left, top: position.top } });
        },
        onCollapseChange: function (collapsed) {
          savePrefs({ panel: { collapsed: collapsed } });
        }
      }
    });

    state.panel.setLive(state.live.enabled);
    state.panel.applyPanelState((state.publicSettings || {}).panel);
  }

  function resizeCanvas() {
    if (!state.canvas) return;
    const width = Math.max(1, Math.round(window.innerWidth || document.documentElement.clientWidth || 1));
    const height = Math.max(1, Math.round(window.innerHeight || document.documentElement.clientHeight || 1));
    const dpr = window.devicePixelRatio || 1;

    state.canvas.width = Math.max(1, Math.round(width * dpr));
    state.canvas.height = Math.max(1, Math.round(height * dpr));
    state.canvas.style.width = width + 'px';
    state.canvas.style.height = height + 'px';

    state.viewport = {
      w: width,
      h: height,
      sx: state.canvas.width / width,
      sy: state.canvas.height / height,
      dpr: dpr
    };
  }

  /* ------------------------------------------------------------------ *
   * Scheduling
   * ------------------------------------------------------------------ */

  function scheduleDraw() {
    if (state.rafId) return;
    state.rafId = window.requestAnimationFrame(function () {
      state.rafId = 0;
      draw();
    });
  }

  function handleResize() {
    resizeCanvas();
    if (state.analysis) {
      // Rebuild the ghost geometry for the new viewport, keeping the drag offset.
      const previousOffset = state.ghost ? state.ghost.offset : { x: 0, y: 0 };
      state.ghost = buildGhost(state.analysis);
      state.ghost.offset = clampGhostOffset(state.ghost, previousOffset.x, previousOffset.y);
    }
    if (state.panel) state.panel.clampToViewport();
    scheduleDraw();
  }

  /* ------------------------------------------------------------------ *
   * Canvas helpers
   * ------------------------------------------------------------------ */

  function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawPill(ctx, text, x, y, color, align) {
    if (!text) return;
    const { w, h } = state.viewport;
    ctx.save();
    ctx.font = '600 11px ' + FONT_STACK;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const padding = 6;
    const height = 18;
    const width = Math.min(w - 8, ctx.measureText(text).width + padding * 2);
    let left = align === 'left' ? x : x - width;
    left = clamp(left, 4, Math.max(4, w - width - 4));
    const top = clamp(y - height / 2, 4, Math.max(4, h - height - 4));

    ctx.fillStyle = COLORS.panelBg;
    roundRect(ctx, left, top, width, height, 4);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(text, left + padding, top + height / 2 + 0.5, width - padding * 2);
    ctx.restore();
  }

  function horizontalLine(ctx, y, color, dash, opacity) {
    const { w } = state.viewport;
    ctx.save();
    ctx.globalAlpha = opacity == null ? 1 : opacity;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  /* ------------------------------------------------------------------ *
   * Ghost candle geometry
   * ------------------------------------------------------------------ */

  function resolveAnchor(analysis) {
    const last = analysis && analysis.last_candle;
    if (last && Number.isFinite(last.x)) {
      return {
        x: clamp01(last.x),
        y: Number.isFinite(last.y) ? clamp01(last.y) : 0.55,
        width: clamp(last.width || 0.015, 0.004, 0.06),
        auto: false
      };
    }
    // Reuse the previous anchor (keeps ghosts in place across live refreshes)
    // while remembering whether it came from the model or from the fallback.
    if (state.lastAnchor) return Object.assign({}, state.lastAnchor);
    return { x: 0.82, y: 0.55, width: 0.015, auto: true };
  }

  function resolveScale(analysis, anchor, candles) {
    const fromModel = analysis && analysis.price_scale ? coords.buildPriceScale(analysis.price_scale) : null;
    if (fromModel) return fromModel;

    const fromLevels = analysis ? coords.scaleFromLevels(analysis.support_resistance) : null;
    if (fromLevels) return fromLevels;

    return coords.autoFitScale(candles, anchor.y != null ? anchor.y : 0.55, 0.16);
  }

  /**
   * Build the ghost-candle model: screen placement, price scale and the user's
   * drag offset (which survives live refreshes until Clear).
   */
  function buildGhost(analysis) {
    const candles = (analysis && analysis.predicted_candles) || [];
    const anchor = resolveAnchor(analysis);
    const scale = resolveScale(analysis, anchor, candles);
    const { w, h } = state.viewport;

    const width = anchor.width || 0.015;
    const step = Math.max(6, width * w * 1.6);
    const bodyWidth = Math.max(3, width * w);

    const previousOffset = state.ghost ? state.ghost.offset : { x: 0, y: 0 };

    let firstCenter = anchor.x * w + step * 0.75;
    const span = step * Math.max(0, candles.length - 1);
    const maxRight = w - bodyWidth / 2 - 6;
    if (firstCenter + span > maxRight) firstCenter = maxRight - span;
    firstCenter = Math.max(bodyWidth / 2 + 6, firstCenter);

    let top = Infinity;
    let bottom = -Infinity;
    if (scale) {
      candles.forEach(function (candle) {
        const highY = scale.yFor(candle.high) * h;
        const lowY = scale.yFor(candle.low) * h;
        if (!Number.isFinite(highY) || !Number.isFinite(lowY)) return;
        top = Math.min(top, highY, lowY);
        bottom = Math.max(bottom, highY, lowY);
      });
    }
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
      top = clamp(anchor.y, 0, 1) * h - 40;
      bottom = top + 80;
    }

    const base = {
      left: firstCenter - bodyWidth / 2,
      right: firstCenter + span + bodyWidth / 2,
      top: top,
      bottom: bottom
    };

    return {
      candles: candles,
      scale: scale,
      anchor: anchor,
      step: step,
      bodyWidth: bodyWidth,
      firstCenter: firstCenter,
      base: base,
      offset: { x: previousOffset.x || 0, y: previousOffset.y || 0 },
      geometry: scale ? { left: base.left, right: base.right, top: base.top, bottom: base.bottom } : null
    };
  }

  /**
   * Keep the whole ghost group inside the viewport.
   * `minX` is the offset that puts the group's LEFT edge on the margin, `maxX`
   * the offset that puts its RIGHT edge on the opposite margin.
   */
  function clampGhostOffset(ghost, x, y) {
    const { w, h } = state.viewport;
    const margin = 24;
    const minX = margin - ghost.base.left;
    const maxX = w - margin - ghost.base.right;
    const minY = margin - ghost.base.top;
    const maxY = h - margin - ghost.base.bottom;
    const loX = Math.min(minX, maxX);
    const hiX = Math.max(minX, maxX);
    const loY = Math.min(minY, maxY);
    const hiY = Math.max(minY, maxY);
    return {
      x: clamp(x, loX, hiX),
      y: clamp(y, loY, hiY)
    };
  }

  function positionHandle() {
    const handle = state.handle;
    if (!handle) return;
    const geometry = state.ghost && state.ghost.geometry;
    if (!geometry) {
      handle.hidden = true;
      return;
    }
    const padding = 10;
    const { w, h } = state.viewport;
    const left = clamp(geometry.left - padding, 0, w);
    const top = clamp(geometry.top - padding, 0, h);
    const width = clamp(geometry.right - geometry.left + padding * 2, 24, w);
    const height = clamp(geometry.bottom - geometry.top + padding * 2, 24, h);
    handle.hidden = false;
    handle.style.left = Math.round(left) + 'px';
    handle.style.top = Math.round(top) + 'px';
    handle.style.width = Math.round(width) + 'px';
    handle.style.height = Math.round(height) + 'px';
  }

  /* ------------------------------------------------------------------ *
   * Drawing
   * ------------------------------------------------------------------ */

  function drawZone(ctx, zone) {
    const { w, h } = state.viewport;
    const left = Math.min(zone.x1, zone.x2) * w;
    const top = Math.min(zone.y1, zone.y2) * h;
    const width = Math.abs(zone.x2 - zone.x1) * w;
    const height = Math.abs(zone.y2 - zone.y1) * h;
    if (width < 3 || height < 3) return;

    const fill = zone.type === 'demand' ? COLORS.demand : zone.type === 'supply' ? COLORS.supply : COLORS.neutral;
    const stroke =
      zone.type === 'demand' ? COLORS.demandStroke : zone.type === 'supply' ? COLORS.supplyStroke : COLORS.neutralStroke;

    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    roundRect(ctx, left, top, width, height, 4);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    const label = zone.label || zone.type;
    if (label) drawPill(ctx, String(label).toUpperCase(), left + 6, top + 12, stroke, 'left');
  }

  function drawTrendline(ctx, line) {
    const { w, h } = state.viewport;
    const x1 = line.x1 * w;
    const y1 = line.y1 * h;
    const x2 = line.x2 * w;
    const y2 = line.y2 * h;
    if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) return;
    if (Math.abs(x2 - x1) < 4 && Math.abs(y2 - y1) < 4) return;

    ctx.save();
    ctx.strokeStyle = COLORS.trendline;
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(96, 165, 250, 0.55)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // Arrow head at the end point
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const size = 9;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 7), y2 - size * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 7), y2 - size * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fillStyle = COLORS.trendline;
    ctx.fill();
    ctx.restore();

    if (line.label) {
      drawPill(ctx, line.label, (x1 + x2) / 2 + 30, (y1 + y2) / 2 - 12, COLORS.trendline, 'left');
    }
  }

  function drawLevels(ctx, levels, scale) {
    const { w, h } = state.viewport;
    levels.forEach(function (level) {
      let y = null;
      if (Number.isFinite(level.y)) {
        y = clamp01(level.y) * h;
      } else if (scale && Number.isFinite(level.price)) {
        const normalized = scale.yFor(level.price);
        if (normalized == null || normalized < -0.05 || normalized > 1.05) return;
        y = clamp01(normalized) * h;
      }
      if (y == null) return;

      const color =
        level.type === 'support' ? COLORS.support : level.type === 'resistance' ? COLORS.resistance : COLORS.level;
      horizontalLine(ctx, y, color, [8, 6], 0.9);

      const priceText = Number.isFinite(level.price) ? ACP.panel.formatPrice(level.price) : '';
      const text = (level.type === 'level' ? '' : level.type.toUpperCase()) + (priceText ? ' ' + priceText : '');
      if (text.trim()) drawPill(ctx, text.trim(), w - 8, y, color, 'right');
    });
  }

  function drawTradeLevels(ctx, trade, scale) {
    if (!trade || !scale) return;
    const { w, h } = state.viewport;

    function yFor(price) {
      if (!Number.isFinite(price)) return null;
      const normalized = scale.yFor(price);
      if (normalized == null || !isFinite(normalized)) return null;
      return normalized * h;
    }

    const entryY = yFor(trade.entry);
    const stopY = yFor(trade.stop_loss);
    const target1Y = yFor(trade.target1);
    const target2Y = yFor(trade.target2);

    if (entryY != null && stopY != null) {
      ctx.save();
      ctx.fillStyle = 'rgba(239, 68, 68, 0.07)';
      ctx.fillRect(0, Math.min(entryY, stopY), w, Math.abs(stopY - entryY));
      ctx.restore();
    }
    if (entryY != null && target1Y != null) {
      ctx.save();
      ctx.fillStyle = 'rgba(34, 197, 94, 0.07)';
      ctx.fillRect(0, Math.min(entryY, target1Y), w, Math.abs(target1Y - entryY));
      ctx.restore();
    }

    const rows = [
      { price: trade.entry, y: entryY, color: COLORS.entry, label: 'ENTRY', dash: [] },
      { price: trade.stop_loss, y: stopY, color: COLORS.stop, label: 'SL', dash: [10, 6] },
      { price: trade.target1, y: target1Y, color: COLORS.target, label: 'TP1', dash: [10, 6] },
      { price: trade.target2, y: target2Y, color: COLORS.target, label: 'TP2', dash: [4, 6] }
    ];

    rows.forEach(function (row) {
      if (row.y == null) return;
      horizontalLine(ctx, row.y, row.color, row.dash, 0.95);
      drawPill(ctx, row.label + ' ' + ACP.panel.formatPrice(row.price), w - 8, row.y, row.color, 'right');
    });
  }

  function drawGhostCandles(ctx) {
    const ghost = state.ghost;
    if (!ghost || !ghost.scale || !ghost.candles.length) return;

    const { h } = state.viewport;
    const offset = ghost.offset;
    const bodyWidth = ghost.bodyWidth;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    ghost.candles.forEach(function (candle, index) {
      const centerX = ghost.firstCenter + index * ghost.step + offset.x;
      const yOpen = ghost.scale.yFor(candle.open) * h + offset.y;
      const yClose = ghost.scale.yFor(candle.close) * h + offset.y;
      const yHigh = ghost.scale.yFor(candle.high) * h + offset.y;
      const yLow = ghost.scale.yFor(candle.low) * h + offset.y;

      if (![yOpen, yClose, yHigh, yLow].every(Number.isFinite)) return;

      const bullish = candle.close >= candle.open;
      const edge = bullish ? COLORS.bullish : COLORS.bearish;
      const fill = bullish ? COLORS.bullishFill : COLORS.bearishFill;
      const bodyTop = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(1.5, Math.abs(yClose - yOpen));

      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = edge;
      ctx.beginPath();
      ctx.moveTo(Math.round(centerX) + 0.5, yHigh);
      ctx.lineTo(Math.round(centerX) + 0.5, yLow);
      ctx.stroke();

      ctx.fillStyle = fill;
      roundRect(ctx, centerX - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight, 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      minX = Math.min(minX, centerX - bodyWidth / 2);
      maxX = Math.max(maxX, centerX + bodyWidth / 2);
      minY = Math.min(minY, yHigh);
      maxY = Math.max(maxY, yLow);

      // Open / close ticks make the prediction easier to read.
      ctx.save();
      ctx.strokeStyle = edge;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1;
      [yOpen, yClose].forEach(function (y) {
        ctx.beginPath();
        ctx.moveTo(centerX - bodyWidth / 2 - 2, y);
        ctx.lineTo(centerX + bodyWidth / 2 + 2, y);
        ctx.stroke();
      });
      ctx.restore();
    });

    if (!Number.isFinite(minX)) return;

    const padding = 10;
    ctx.save();
    ctx.strokeStyle = COLORS.ghostOutline;
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1;
    roundRect(ctx, minX - padding, minY - padding, maxX - minX + padding * 2, maxY - minY + padding * 2, 8);
    ctx.stroke();
    ctx.restore();

    drawPill(
      ctx,
      'AI · ' + ghost.candles.length + ' × ' + ((state.meta && state.meta.timeframe) || '') + ' (drag me)',
      maxX + padding + 8,
      minY - padding,
      COLORS.ghostLabel,
      'left'
    );

    ghost.geometry = {
      left: minX - padding,
      right: maxX + padding,
      top: minY - padding,
      bottom: maxY + padding
    };

    if (state.drag && state.handle) positionHandle();
  }

  function draw() {
    const ctx = state.ctx;
    const canvas = state.canvas;
    if (!ctx || !canvas) return;

    const { w, h, sx, sy } = state.viewport;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!state.analysis) {
      if (state.ghost) state.ghost.geometry = null;
      positionHandle();
      return;
    }

    const analysis = state.analysis;
    const scale = state.ghost ? state.ghost.scale : null;

    // Keep drawings glued to the chart when the page itself scrolls.
    const scrollX = window.pageXOffset || window.scrollX || 0;
    const scrollY = window.pageYOffset || window.scrollY || 0;
    const dx = state.scrollOrigin ? state.scrollOrigin.x - scrollX : 0;
    const dy = state.scrollOrigin ? state.scrollOrigin.y - scrollY : 0;

    ctx.save();
    ctx.translate(dx, dy);
    (analysis.zones || []).forEach(function (zone) {
      drawZone(ctx, zone);
    });
    (analysis.trendlines || []).forEach(function (line) {
      drawTrendline(ctx, line);
    });
    drawLevels(ctx, analysis.support_resistance || [], scale);
    drawTradeLevels(ctx, analysis.trade, scale);
    ctx.restore();

    // Ghost candles live in screen space because the user places them by hand.
    drawGhostCandles(ctx);
    positionHandle();
  }

  /* ------------------------------------------------------------------ *
   * Ghost dragging
   * ------------------------------------------------------------------ */

  function onGhostPointerDown(event) {
    if (!state.ghost) return;
    if (event.button !== undefined && event.button !== 0) return;

    state.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: state.ghost.offset.x,
      originY: state.ghost.offset.y
    };
    try {
      state.handle.setPointerCapture(event.pointerId);
    } catch (error) {
      /* pointer capture is best effort */
    }
    state.handle.dataset.dragging = 'true';
    event.preventDefault();
    event.stopPropagation();
  }

  function onGhostPointerMove(event) {
    if (!state.drag || !state.ghost || event.pointerId !== state.drag.pointerId) return;
    const next = clampGhostOffset(
      state.ghost,
      state.drag.originX + (event.clientX - state.drag.startX),
      state.drag.originY + (event.clientY - state.drag.startY)
    );
    state.ghost.offset = next;
    scheduleDraw();
    event.preventDefault();
    event.stopPropagation();
  }

  function onGhostPointerUp(event) {
    if (!state.drag) return;
    if (event && event.pointerId !== undefined && event.pointerId !== state.drag.pointerId) return;
    state.drag = null;
    if (state.handle) state.handle.dataset.dragging = 'false';
  }

  /* ------------------------------------------------------------------ *
   * Analysis lifecycle
   * ------------------------------------------------------------------ */

  function applyAnalysis(response) {
    state.analysis = response.analysis;
    state.meta = response.meta || null;
    state.warnings = Array.isArray(response.warnings) ? response.warnings : [];
    state.lastAnchor = resolveAnchor(response.analysis);
    state.scrollOrigin = {
      x: window.pageXOffset || window.scrollX || 0,
      y: window.pageYOffset || window.scrollY || 0
    };
    state.ghost = buildGhost(response.analysis);

    if (state.panel) state.panel.setResult(response.analysis, state.meta, state.warnings);
    scheduleDraw();
  }

  function clearAnalysis() {
    state.analysis = null;
    state.meta = null;
    state.warnings = [];
    state.ghost = null;
    state.scrollOrigin = null;
    state.drag = null;
    if (state.panel) state.panel.clearResult();
    if (state.handle) state.handle.hidden = true;
    scheduleDraw();
  }

  function cancelAnalysis() {
    if (!state.analyzing || !state.requestId) return;
    sendMessage({ type: MSG.CANCEL, requestId: state.requestId }).catch(function () {});
  }

  function isFatalLiveError(code) {
    return (
      code === 'AUTH' ||
      code === 'FORBIDDEN' ||
      code === 'NO_API_KEY' ||
      code === 'MODEL_NO_VISION' ||
      code === 'UNKNOWN_PROVIDER' ||
      code === 'MISSING_MODEL' ||
      code === 'MISSING_BASE_URL' ||
      code === 'RESTRICTED_PAGE' ||
      code === 'TAB_NOT_ACTIVE'
    );
  }

  function handleError(error, options) {
    const opts = options || {};
    const message = (error && error.message) || 'Unknown error';
    const code = (error && error.code) || 'UNKNOWN';

    if (code === 'CANCELLED') {
      if (state.panel) state.panel.setStatus('Analysis cancelled.', {});
      return;
    }

    if (state.live.enabled) {
      state.live.errors += 1;

      if (isFatalLiveError(code)) {
        stopLive(true);
        if (state.panel) state.panel.setStatus('Live Mode stopped: ' + message, { tone: 'error' });
        return;
      }
      if (state.live.errors >= ACP.MAX_LIVE_ERRORS) {
        const errors = state.live.errors;
        stopLive(true);
        if (state.panel) {
          state.panel.setStatus(
            'Live Mode stopped after ' + errors + ' failed refreshes. Last error: ' + message,
            { tone: 'error' }
          );
        }
        return;
      }
      if (state.panel) {
        state.panel.setStatus('Live Mode will retry · ' + message, { tone: 'error' });
      }
      return;
    }

    if (state.panel) state.panel.setStatus(message, { tone: 'error' });
  }

  async function runAnalysis(options) {
    const opts = options || {};
    if (state.analyzing || !state.panel) return;

    // Claim the slot synchronously: a live tick and a button press can land in
    // the same task, and two overlapping captures would fight for the overlay.
    state.analyzing = true;
    const requestId = 'acp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    state.requestId = requestId;

    try {
      if (!state.publicSettings) await loadSettings();

      const quick = state.panel.getValues ? state.panel.getValues() : null;
      const settings = state.publicSettings || ACP.settings.normalize(ACP.DEFAULT_SETTINGS);
      const providerId = quick ? quick.providerId : settings.providerId;
      const model = quick ? quick.model : settings.model;
      const timeframe = quick ? quick.timeframe : settings.timeframe;
      const candleCount = quick ? quick.candleCount : settings.candleCount;

      state.panel.setBusy(true);
      state.panel.setStatus(opts.silent ? 'Live refresh · capturing the chart…' : 'Capturing the chart…', {
        loading: true
      });

      // Hide our own UI so the screenshot contains only the chart.
      setOverlayHidden(true, 'capture');

      const response = await sendMessage({
        type: MSG.ANALYZE,
        payload: {
          requestId: requestId,
          providerId: providerId,
          model: model,
          baseUrl: settings.baseUrl || '',
          timeframe: timeframe,
          candleCount: candleCount,
          imageWidth: state.viewport.w,
          imageHeight: state.viewport.h
        }
      });

      if (!response) throw makeError(null, 'The background worker did not answer. Reload the extension.');
      if (!response.ok) throw makeError(response.error, 'Analysis failed.');

      applyAnalysis(response);
      state.live.errors = 0;

      const seconds = response.meta && response.meta.latencyMs ? (response.meta.latencyMs / 1000).toFixed(1) : null;
      const suffix =
        (seconds ? ' · ' + seconds + 's' : '') + (response.meta && response.meta.attempt > 1 ? ' · retried once' : '');
      state.panel.setStatus(
        state.live.enabled ? 'Live Mode · refreshed' + suffix : 'Analysis ready' + suffix,
        { tone: 'success' }
      );
    } catch (error) {
      handleError(error, opts);
    } finally {
      setOverlayHidden(false, 'capture');
      state.analyzing = false;
      state.requestId = null;
      state.panel.setBusy(false);
      if (state.live.enabled && !state.live.timer) scheduleLive();
    }
  }

  /* ------------------------------------------------------------------ *
   * Live mode
   * ------------------------------------------------------------------ */

  function liveIntervalMs() {
    const settings = state.publicSettings || {};
    const seconds = ACP.LIVE_INTERVALS.some(function (item) {
      return item.value === settings.liveIntervalSec;
    })
      ? settings.liveIntervalSec
      : 30;
    return seconds * 1000;
  }

  function scheduleLive(delay) {
    if (state.live.timer) {
      clearTimeout(state.live.timer);
      state.live.timer = 0;
    }
    if (!state.live.enabled) return;

    const wait = typeof delay === 'number' ? delay : liveIntervalMs();
    state.live.nextAt = Date.now() + wait;
    state.live.timer = setTimeout(liveTick, wait);
  }

  async function liveTick() {
    state.live.timer = 0;
    if (!state.live.enabled) return;
    if (state.suppressUser || document.hidden) {
      scheduleLive(4000);
      return;
    }
    if (state.analyzing) {
      scheduleLive(2000);
      return;
    }
    await runAnalysis({ silent: true, fromLive: true });
    if (state.live.enabled && !state.live.timer) scheduleLive();
  }

  function startLive() {
    state.live.enabled = true;
    state.live.errors = 0;
    if (state.panel) {
      state.panel.setLive(true);
      state.panel.setStatus('Live Mode on · starting the first refresh…', { loading: true });
    }
    if (!state.live.ticker) {
      state.live.ticker = setInterval(function () {
        if (!state.live.enabled || state.analyzing || !state.panel) return;
        const remaining = Math.max(0, Math.ceil((state.live.nextAt - Date.now()) / 1000));
        state.panel.setStatus('Live Mode · next refresh in ' + remaining + 's', {});
      }, 1000);
    }
    if (!state.analyzing) runAnalysis({ silent: true, fromLive: true });
    else scheduleLive(1500);
  }

  function stopLive(silent) {
    const wasEnabled = state.live.enabled;
    state.live.enabled = false;
    if (state.live.timer) {
      clearTimeout(state.live.timer);
      state.live.timer = 0;
    }
    if (state.live.ticker) {
      clearInterval(state.live.ticker);
      state.live.ticker = 0;
    }
    state.live.errors = 0;
    if (state.panel) {
      state.panel.setLive(false);
      if (!silent) state.panel.setStatus('Live Mode off.', {});
    }
    if (wasEnabled) savePrefs({ liveEnabled: false });
  }

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  function savePrefs(patch) {
    state.pendingPatch = Object.assign({}, state.pendingPatch, patch);
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(function () {
      state.saveTimer = 0;
      const payload = state.pendingPatch || {};
      state.pendingPatch = null;
      sendMessage({ type: MSG.SAVE_SETTINGS, settings: payload })
        .then(function (response) {
          if (response && response.ok && response.settings) {
            state.publicSettings = response.settings;
            state.lastSavedDoc = response.settings;
            if (state.live.enabled && !state.live.timer) scheduleLive();
          }
        })
        .catch(function () {
          /* best effort: the UI still works for this page */
        });
    }, 250);
  }

  /** Fields the panel shows; used to recognise the echo of our own save. */
  const MANAGED_PREFS = ['providerId', 'model', 'baseUrl', 'timeframe', 'candleCount', 'liveEnabled', 'liveIntervalSec'];

  function sameManagedPrefs(a, b) {
    if (!a || !b) return false;
    for (let i = 0; i < MANAGED_PREFS.length; i += 1) {
      const key = MANAGED_PREFS[i];
      if (String(a[key]) !== String(b[key])) return false;
    }
    const panelA = a.panel || {};
    const panelB = b.panel || {};
    return (
      Number(panelA.left) === Number(panelB.left) &&
      Number(panelA.top) === Number(panelB.top) &&
      !!panelA.collapsed === !!panelB.collapsed
    );
  }

  /**
   * Fetch the redacted settings document.
   *
   * @param {'apply'|'skip'|'auto'} [mode='apply'] panel handling: always apply,
   *   never apply, or skip when the document is just the echo of our own save
   *   (which would otherwise revert a change the user made a moment later).
   */
  function loadSettings(mode) {
    const decision = mode || 'apply';
    return sendMessage({ type: MSG.GET_SETTINGS })
      .then(function (response) {
        const next =
          response && response.ok && response.settings
            ? response.settings
            : ACP.settings.normalize(ACP.DEFAULT_SETTINGS);
        state.publicSettings = next;
        let apply = decision !== 'skip';
        if (decision === 'auto') apply = !(state.lastSavedDoc && sameManagedPrefs(next, state.lastSavedDoc));
        if (state.panel && apply) {
          state.panel.setSettings(next);
          state.panel.setLive(state.live.enabled);
          // The panel now reflects an arbitrary stored snapshot, so a later
          // document that merely equals our last save must be applied again.
          state.lastSavedDoc = null;
        }
        return next;
      })
      .catch(function () {
        state.publicSettings = ACP.settings.normalize(ACP.DEFAULT_SETTINGS);
        if (state.panel && decision !== 'skip') state.panel.setSettings(state.publicSettings);
        return state.publicSettings;
      });
  }

  function watchSettings() {
    if (state.removeSettingsListener) state.removeSettingsListener();

    const listener = function (changes, areaName) {
      if (areaName !== 'local' || !changes[ACP.STORAGE_KEY]) return;
      window.clearTimeout(state.settingsTimer);
      state.settingsTimer = window.setTimeout(function () {
        // 'auto' skips the panel only when this change is the echo of our own
        // save, so a rapid second edit is never reverted by the older snapshot.
        // Refetch the redacted copy instead of reading the raw change payload.
        loadSettings('auto');
      }, 200);
    };

    chrome.storage.onChanged.addListener(listener);
    state.removeSettingsListener = function () {
      chrome.storage.onChanged.removeListener(listener);
    };
  }

  /* ------------------------------------------------------------------ *
   * Visibility
   * ------------------------------------------------------------------ */

  function applyVisibility() {
    if (!state.host) return;
    const hidden = state.suppressUser || state.suppressCapture;
    state.host.style.setProperty('display', hidden ? 'none' : 'block', 'important');
  }

  function setOverlayHidden(hidden, reason) {
    if (reason === 'capture') state.suppressCapture = !!hidden;
    else state.suppressUser = !!hidden;
    applyVisibility();
  }

  function toggleVisibility() {
    state.suppressUser = !state.suppressUser;
    applyVisibility();
    if (!state.suppressUser) {
      handleResize();
      if (state.panel) state.panel.clampToViewport();
      scheduleDraw();
    }
    return !state.suppressUser;
  }

  /* ------------------------------------------------------------------ *
   * Messages + wiring
   * ------------------------------------------------------------------ */

  function onRuntimeMessage(message, sender, sendResponse) {
    if (!message || !message.type) return false;
    switch (message.type) {
      case MSG.PING:
        sendResponse({ ok: true, version: ACP.VERSION, visible: !state.suppressUser });
        return false;
      case MSG.TOGGLE_PANEL:
        sendResponse({ ok: true, visible: toggleVisibility() });
        return false;
      case MSG.CAPTURED:
        // The screenshot has been taken — bring our own UI back immediately.
        setOverlayHidden(false, 'capture');
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  }

  function onVisibilityChange() {
    if (document.hidden) return;
    handleResize();
    scheduleDraw();
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  window.addEventListener('resize', handleResize, { passive: true });
  window.addEventListener('orientationchange', handleResize, { passive: true });
  window.addEventListener('scroll', scheduleDraw, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function boot() {
    if (state.disposed) return;
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
      return;
    }
    if (!ensureHost()) {
      setTimeout(boot, 300);
      return;
    }
    buildOverlay();
    loadSettings()
      .catch(function (error) {
        console.warn('[ACP] could not load the saved settings', error);
        return ACP.settings.normalize(ACP.DEFAULT_SETTINGS);
      })
      .then(function () {
        // A page that navigated away mid-request must not mount a panel here.
        if (state.disposed) return;
        mountPanel();
        watchSettings();

        const settings = state.publicSettings || {};
        if (settings.panel && settings.panel.collapsed === true && state.panel) {
          state.panel.setCollapsed(true, true);
        }
        if (settings.liveEnabled === true) startLive();
        scheduleDraw();
      });
  }

  /**
   * Is this instance still attached to a live extension? After the extension is
   * reloaded/updated the page keeps the old script, but its `chrome.*` bindings
   * are revoked, so `chrome.runtime.id` becomes undefined. `isAlive()` runs in
   * the *old* closure, which is exactly where that can be observed.
   */
  function isAlive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  /**
   * Remove every trace of this instance: timers, listeners, panel, overlay.
   * Only used when replacing an orphaned copy of the content script.
   */
  function destroy() {
    if (state.disposed) return;
    state.disposed = true;

    stopLive(true);
    cancelAnalysis();
    clearAnalysis();

    if (state.rafId) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
    window.clearTimeout(state.saveTimer);
    window.clearTimeout(state.settingsTimer);
    state.saveTimer = 0;
    state.settingsTimer = 0;

    if (state.removeSettingsListener) {
      state.removeSettingsListener();
      state.removeSettingsListener = null;
    }
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (error) {
      /* the context is already gone */
    }
    window.removeEventListener('resize', handleResize);
    window.removeEventListener('orientationchange', handleResize);
    window.removeEventListener('scroll', scheduleDraw, { capture: true });
    document.removeEventListener('visibilitychange', onVisibilityChange);

    if (state.panel) {
      state.panel.destroy();
      state.panel = null;
    }
    if (state.host && state.host.parentNode) state.host.parentNode.removeChild(state.host);
    state.host = null;
    state.shadow = null;
    state.canvas = null;
    state.ctx = null;
    state.handle = null;

    if (window.__AI_CHART_PREDICTOR && window.__AI_CHART_PREDICTOR.destroy === destroy) {
      delete window.__AI_CHART_PREDICTOR;
    }
  }

  // Public handle for re-injection / debugging (isolated world only).
  window.__AI_CHART_PREDICTOR = {
    toggle: toggleVisibility,
    analyze: function () {
      return runAnalysis({});
    },
    clear: function () {
      stopLive(true);
      clearAnalysis();
    },
    openPanel: function () {
      state.suppressUser = false;
      applyVisibility();
      handleResize();
    },
    destroy: destroy,
    isAlive: isAlive,
    state: state
  };

  boot();
})();
