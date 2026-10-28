/**
 * AI Chart Predictor — floating control panel (shadow-DOM side).
 *
 * Pure UI: it renders settings/analysis and calls back into content.js.
 * Everything lives inside a shadow root so page CSS cannot leak in, and page
 * selectors cannot reach the panel.
 */
(function (global) {
  'use strict';

  const ACP = (global.ACP = global.ACP || {});

  const TEMPLATE = [
    '<div class="acp-panel" id="acp-panel" data-collapsed="false">',
    '  <header class="acp-panel__header" id="acp-header" title="Drag to move · Alt+Shift+A to hide/show">',
    '    <span class="acp-logo" aria-hidden="true">◆</span>',
    '    <span class="acp-title">AI Chart Predictor</span>',
    '    <span class="acp-dot" id="acp-dot" title="Idle"></span>',
    '    <button type="button" class="acp-icon-btn" id="acp-collapse" title="Collapse panel" aria-label="Collapse panel">▾</button>',
    '  </header>',
    '  <div class="acp-panel__body" id="acp-body">',
    '    <div class="acp-row acp-row--2">',
    '      <label class="acp-field">',
    '        <span>Provider</span>',
    '        <select id="acp-provider" title="AI provider"></select>',
    '      </label>',
    '      <label class="acp-field">',
    '        <span>Model</span>',
    '        <input id="acp-model" type="text" list="acp-model-list" spellcheck="false" autocomplete="off" placeholder="model name" title="Model name (editable)">',
    '        <datalist id="acp-model-list"></datalist>',
    '      </label>',
    '    </div>',
    '    <div class="acp-vision" id="acp-vision" hidden></div>',
    '    <div class="acp-row acp-row--3">',
    '      <label class="acp-field">',
    '        <span>Timeframe</span>',
    '        <select id="acp-timeframe"></select>',
    '      </label>',
    '      <label class="acp-field">',
    '        <span>Candles</span>',
    '        <select id="acp-candles"></select>',
    '      </label>',
    '      <div class="acp-field acp-field--switch">',
    '        <span>Live Mode</span>',
    '        <label class="acp-switch" title="Re-capture and re-analyse automatically">',
    '          <input type="checkbox" id="acp-live">',
    '          <i></i>',
    '        </label>',
    '      </div>',
    '    </div>',
    '    <div class="acp-row acp-row--2">',
    '      <label class="acp-field">',
    '        <span>Refresh every</span>',
    '        <select id="acp-interval"></select>',
    '      </label>',
    '      <div class="acp-actions">',
    '        <button type="button" class="acp-btn acp-btn--primary" id="acp-analyze">Analyze chart</button>',
    '        <button type="button" class="acp-btn acp-btn--ghost" id="acp-clear" title="Remove every drawing and stop Live Mode">Clear</button>',
    '      </div>',
    '    </div>',
    '    <div class="acp-status" id="acp-status" hidden>',
    '      <span class="acp-spinner" id="acp-spinner"></span>',
    '      <span class="acp-status__text" id="acp-status-text"></span>',
    '    </div>',
    '    <div class="acp-result" id="acp-result" hidden>',
    '      <div class="acp-result__head">',
    '        <span class="acp-badge" id="acp-trend" data-trend="sideways">—</span>',
    '        <span class="acp-result__symbol" id="acp-symbol"></span>',
    '        <span class="acp-confidence" title="Model confidence">',
    '          <b id="acp-conf-value">0%</b>',
    '          <i class="acp-confidence__bar"><span id="acp-conf-fill"></span></i>',
    '        </span>',
    '      </div>',
    '      <div class="acp-grid">',
    '        <div class="acp-grid__cell"><span>Entry</span><b id="acp-entry">—</b></div>',
    '        <div class="acp-grid__cell"><span>Stop</span><b id="acp-sl" class="is-loss">—</b></div>',
    '        <div class="acp-grid__cell"><span>TP1</span><b id="acp-tp1" class="is-profit">—</b></div>',
    '        <div class="acp-grid__cell"><span>TP2</span><b id="acp-tp2" class="is-profit">—</b></div>',
    '      </div>',
    '      <div class="acp-kv"><span>Structure</span><b id="acp-structure">—</b></div>',
    '      <div class="acp-kv"><span>Risk : Reward</span><b id="acp-rr">—</b></div>',
    '      <div class="acp-kv"><span>Timeframe</span><b id="acp-tf">—</b></div>',
    '      <div class="acp-chips" id="acp-patterns"></div>',
    '      <p class="acp-reasoning" id="acp-reasoning"></p>',
    '      <p class="acp-warning" id="acp-warnings" hidden></p>',
    '      <p class="acp-meta" id="acp-meta"></p>',
    '    </div>',
    '    <div class="acp-footer">',
    '      <button type="button" class="acp-link" id="acp-settings" title="Open the full settings page">Settings</button>',
    '      <span class="acp-footer__hint">Alt+Shift+A</span>',
    '    </div>',
    '  </div>',
    '  <div class="acp-disclaimer" id="acp-disclaimer">AI prediction is not financial advice. Trading involves risk.</div>',
    '</div>'
  ].join('\n');

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function formatPrice(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '—';
    const abs = Math.abs(numeric);
    let digits = 2;
    if (abs > 0 && abs < 0.01) digits = 8;
    else if (abs < 1) digits = 6;
    else if (abs < 100) digits = 4;
    try {
      return numeric.toLocaleString(undefined, {
        minimumFractionDigits: Math.min(2, digits),
        maximumFractionDigits: digits
      });
    } catch (error) {
      return String(numeric);
    }
  }

  function formatConfidence(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.round(clamp(numeric, 0, 100));
  }

  function mount(options) {
    const opts = options || {};
    const host = opts.host;
    if (!host) throw new Error('ACP.panel.mount requires a host element');

    const shell = document.createElement('div');
    shell.className = 'acp-panel-shell';
    shell.innerHTML = TEMPLATE;
    const panel = shell.querySelector('#acp-panel');
    host.appendChild(shell);

    const el = {
      panel: panel,
      header: shell.querySelector('#acp-header'),
      collapse: shell.querySelector('#acp-collapse'),
      body: shell.querySelector('#acp-body'),
      dot: shell.querySelector('#acp-dot'),
      provider: shell.querySelector('#acp-provider'),
      model: shell.querySelector('#acp-model'),
      modelList: shell.querySelector('#acp-model-list'),
      vision: shell.querySelector('#acp-vision'),
      timeframe: shell.querySelector('#acp-timeframe'),
      candles: shell.querySelector('#acp-candles'),
      live: shell.querySelector('#acp-live'),
      interval: shell.querySelector('#acp-interval'),
      analyze: shell.querySelector('#acp-analyze'),
      clear: shell.querySelector('#acp-clear'),
      status: shell.querySelector('#acp-status'),
      spinner: shell.querySelector('#acp-spinner'),
      statusText: shell.querySelector('#acp-status-text'),
      result: shell.querySelector('#acp-result'),
      trend: shell.querySelector('#acp-trend'),
      symbol: shell.querySelector('#acp-symbol'),
      confValue: shell.querySelector('#acp-conf-value'),
      confFill: shell.querySelector('#acp-conf-fill'),
      entry: shell.querySelector('#acp-entry'),
      sl: shell.querySelector('#acp-sl'),
      tp1: shell.querySelector('#acp-tp1'),
      tp2: shell.querySelector('#acp-tp2'),
      structure: shell.querySelector('#acp-structure'),
      rr: shell.querySelector('#acp-rr'),
      tf: shell.querySelector('#acp-tf'),
      patterns: shell.querySelector('#acp-patterns'),
      reasoning: shell.querySelector('#acp-reasoning'),
      warnings: shell.querySelector('#acp-warnings'),
      meta: shell.querySelector('#acp-meta'),
      settings: shell.querySelector('#acp-settings'),
      disclaimer: shell.querySelector('#acp-disclaimer')
    };

    const callbacks = opts.callbacks || {};
    let settings = ACP.settings.normalize(opts.settings || {});
    let analyzing = false;
    let dragState = null;

    el.disclaimer.textContent = ACP.DISCLAIMER;

    /* ---------------------------------------------------------------- *
     * Option lists
     * ---------------------------------------------------------------- */

    function fillProviders() {
      const providers = ACP.providers.list();
      el.provider.textContent = '';
      providers.forEach(function (provider) {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = provider.label;
        el.provider.appendChild(option);
      });
    }

    function fillStaticSelects() {
      el.timeframe.textContent = '';
      ACP.TIMEFRAMES.forEach(function (tf) {
        const option = document.createElement('option');
        option.value = tf;
        option.textContent = tf;
        el.timeframe.appendChild(option);
      });

      el.candles.textContent = '';
      ACP.CANDLE_COUNTS.forEach(function (count) {
        const option = document.createElement('option');
        option.value = String(count);
        option.textContent = count === 1 ? '1 candle' : count + ' candles';
        el.candles.appendChild(option);
      });

      el.interval.textContent = '';
      ACP.LIVE_INTERVALS.forEach(function (item) {
        const option = document.createElement('option');
        option.value = String(item.value);
        option.textContent = item.label;
        el.interval.appendChild(option);
      });
    }

    function fillModels(providerId, keepModel) {
      const models = ACP.providers.modelsFor(providerId);
      el.modelList.textContent = '';
      models.forEach(function (model) {
        const option = document.createElement('option');
        option.value = model.id;
        option.label = model.vision ? model.label : model.label + ' · no image support';
        el.modelList.appendChild(option);
      });
      const fallback = ACP.providers.defaultModel(providerId);
      el.model.value = keepModel != null ? keepModel : fallback;
    }

    function updateVisionWarning() {
      const info = ACP.providers.visionInfo(el.provider.value, el.model.value.trim());
      if (info.status === 'unsupported') {
        el.vision.hidden = false;
        el.vision.dataset.tone = 'error';
        el.vision.textContent = '⚠ ' + info.message;
      } else if (info.status === 'unknown') {
        el.vision.hidden = false;
        el.vision.dataset.tone = 'warn';
        el.vision.textContent = 'ⓘ ' + info.message;
      } else {
        el.vision.hidden = true;
        el.vision.textContent = '';
        delete el.vision.dataset.tone;
      }
    }

    /**
     * Pull every control back into sync with a settings document.
     * `keepModel` avoids overwriting what the user is currently typing.
     */
    function syncFromSettings(next, keepModelValue) {
      settings = ACP.settings.normalize(next || {});
      if (settings.providerId !== el.provider.value) {
        // Provider changed elsewhere (options page / another tab): always adopt
        // the model that belongs to the new provider.
        el.provider.value = settings.providerId;
        fillModels(settings.providerId, settings.model || ACP.providers.defaultModel(settings.providerId));
      } else if (settings.model && !keepModelValue) {
        el.model.value = settings.model;
      }
      el.timeframe.value = settings.timeframe;
      el.candles.value = String(settings.candleCount);
      el.interval.value = String(settings.liveIntervalSec);
      updateVisionWarning();
    }

    /* ---------------------------------------------------------------- *
     * Position + collapse
     * ---------------------------------------------------------------- */

    function applyPosition(left, top) {
      const width = el.panel.offsetWidth || 360;
      const height = el.panel.offsetHeight || 240;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      const maxTop = Math.max(8, window.innerHeight - Math.min(height, 80) - 8);

      if (typeof left === 'number' && typeof top === 'number' && isFinite(left) && isFinite(top)) {
        el.panel.style.left = Math.round(clamp(left, 8, maxLeft)) + 'px';
        el.panel.style.top = Math.round(clamp(top, 8, maxTop)) + 'px';
        el.panel.style.right = 'auto';
      } else {
        el.panel.style.left = 'auto';
        el.panel.style.top = '72px';
        el.panel.style.right = '16px';
      }
    }

    function currentPosition() {
      const rect = el.panel.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    }

    /**
     * Keep the panel on screen after its size changed. A panel still sitting in
     * its default right-anchored position is left there (no user position yet).
     */
    function reclamp() {
      const left = el.panel.style.left;
      if (!left || left === 'auto') {
        applyPosition(null, null);
        return;
      }
      const pos = currentPosition();
      applyPosition(pos.left, pos.top);
    }

    function setCollapsed(value, silent) {
      const collapsed = !!value;
      el.panel.dataset.collapsed = collapsed ? 'true' : 'false';
      el.collapse.textContent = collapsed ? '▸' : '▾';
      el.collapse.title = collapsed ? 'Expand panel' : 'Collapse panel';
      el.collapse.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      // Re-clamp: the collapsed panel is smaller but must stay on screen.
      reclamp();
      if (!silent && typeof callbacks.onCollapseChange === 'function') {
        callbacks.onCollapseChange(collapsed);
      }
    }

    function startDrag(event) {
      if (event.button !== undefined && event.button !== 0) return;
      const target = event.target;
      if (target && target.closest && target.closest('button, input, select, a, label')) return;

      const rect = el.panel.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      panel.dataset.dragging = 'true';
      try {
        el.header.setPointerCapture(event.pointerId);
      } catch (error) {
        /* pointer capture is best effort */
      }
      event.preventDefault();
    }

    function moveDrag(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      applyPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
      event.preventDefault();
    }

    function endDrag(event) {
      if (!dragState) return;
      if (event && event.pointerId !== undefined && event.pointerId !== dragState.pointerId) return;
      dragState = null;
      delete panel.dataset.dragging;
      const pos = currentPosition();
      if (typeof callbacks.onPositionChange === 'function') {
        callbacks.onPositionChange({ left: pos.left, top: pos.top });
      }
    }

    el.header.addEventListener('pointerdown', startDrag);
    el.header.addEventListener('pointermove', moveDrag);
    el.header.addEventListener('pointerup', endDrag);
    el.header.addEventListener('pointercancel', endDrag);
    el.collapse.addEventListener('click', function (event) {
      event.stopPropagation();
      setCollapsed(el.panel.dataset.collapsed !== 'true');
    });

    // Keep page shortcuts (e.g. TradingView hotkeys) from firing while typing.
    panel.addEventListener('keydown', function (event) {
      event.stopPropagation();
    });
    panel.addEventListener('keyup', function (event) {
      event.stopPropagation();
    });
    panel.addEventListener('pointerdown', function (event) {
      event.stopPropagation();
    });
    panel.addEventListener('wheel', function (event) {
      event.stopPropagation();
    });

    /* ---------------------------------------------------------------- *
     * Control wiring
     * ---------------------------------------------------------------- */

    function emitQuickChange(partial) {
      if (typeof callbacks.onQuickChange === 'function') callbacks.onQuickChange(partial);
    }

    el.provider.addEventListener('change', function () {
      const providerId = el.provider.value;
      const model = ACP.providers.defaultModel(providerId);
      fillModels(providerId, model);
      updateVisionWarning();
      emitQuickChange({ providerId: providerId, model: model });
    });

    el.model.addEventListener('input', function () {
      updateVisionWarning();
    });
    el.model.addEventListener('change', function () {
      updateVisionWarning();
      emitQuickChange({ model: el.model.value.trim() });
    });

    el.timeframe.addEventListener('change', function () {
      emitQuickChange({ timeframe: el.timeframe.value });
    });

    el.candles.addEventListener('change', function () {
      emitQuickChange({ candleCount: Number(el.candles.value) });
    });

    el.interval.addEventListener('change', function () {
      emitQuickChange({ liveIntervalSec: Number(el.interval.value) });
    });

    el.live.addEventListener('change', function () {
      if (typeof callbacks.onLiveChange === 'function') callbacks.onLiveChange(el.live.checked);
    });

    el.analyze.addEventListener('click', function () {
      if (analyzing) return;
      if (typeof callbacks.onAnalyze === 'function') callbacks.onAnalyze();
    });

    el.clear.addEventListener('click', function () {
      if (typeof callbacks.onClear === 'function') callbacks.onClear();
    });

    el.settings.addEventListener('click', function () {
      if (typeof callbacks.onOpenOptions === 'function') callbacks.onOpenOptions();
    });

    function onWindowResize() {
      if (dragState) return;
      reclamp();
    }
    window.addEventListener('resize', onWindowResize, { passive: true });

    /* ---------------------------------------------------------------- *
     * Public API
     * ---------------------------------------------------------------- */

    const api = {
      el: el,
      /** Replace the whole settings document (called on storage changes). */
      setSettings: function (next) {
        // Controls only: position/collapse are owned by the user, so a storage
        // echo of our own save must not move the panel around.
        syncFromSettings(next, false);
      },
      /** Apply the persisted window state (called once, after mounting). */
      applyPanelState: function (panelSettings) {
        if (dragState) return;
        const panelState = panelSettings || {};
        applyPosition(
          typeof panelState.left === 'number' ? panelState.left : null,
          typeof panelState.top === 'number' ? panelState.top : null
        );
        setCollapsed(panelState.collapsed === true, true);
      },
      /** Update prefs coming from somewhere else without touching the model field. */
      syncPreferences: function (next) {
        syncFromSettings(next, true);
      },
      setLive: function (enabled) {
        el.live.checked = !!enabled;
        el.interval.disabled = !enabled;
      },
      setBusy: function (busy, label) {
        analyzing = !!busy;
        el.analyze.disabled = analyzing;
        el.analyze.textContent = analyzing ? label || 'Analyzing…' : 'Analyze chart';
        // Clear also cancels the in-flight request, so advertise that.
        el.clear.textContent = analyzing ? 'Cancel' : 'Clear';
        el.clear.title = analyzing
          ? 'Cancel the running analysis and clear the drawings'
          : 'Remove every drawing and stop Live Mode';
        el.panel.dataset.busy = analyzing ? 'true' : 'false';
      },
      setStatus: function (text, state) {
        const info = state || {};
        if (!text) {
          el.status.hidden = true;
          el.statusText.textContent = '';
          el.status.classList.remove('is-error', 'is-success');
          el.dot.dataset.state = 'idle';
          el.dot.title = 'Idle';
          return;
        }
        el.status.hidden = false;
        el.statusText.textContent = text;
        el.status.classList.toggle('is-error', info.tone === 'error');
        el.status.classList.toggle('is-success', info.tone === 'success');
        el.spinner.hidden = !info.loading;
        el.dot.dataset.state = info.loading ? 'loading' : info.tone === 'error' ? 'error' : info.tone === 'success' ? 'success' : 'idle';
        el.dot.title = text;
      },
      setResult: function (analysis, meta, warnings) {
        if (!analysis) {
          el.result.hidden = true;
          return;
        }
        el.result.hidden = false;

        const trend = analysis.trend || 'sideways';
        el.trend.dataset.trend = trend;
        el.trend.textContent = trend.charAt(0).toUpperCase() + trend.slice(1);

        el.symbol.textContent = analysis.symbol || (meta && meta.symbol) || '';

        const confidence = formatConfidence(analysis.confidence);
        el.confValue.textContent = confidence + '%';
        el.confFill.style.width = confidence + '%';
        el.confFill.dataset.level = confidence >= 70 ? 'high' : confidence >= 45 ? 'medium' : 'low';

        const trade = analysis.trade || {};
        el.entry.textContent = formatPrice(trade.entry);
        el.sl.textContent = formatPrice(trade.stop_loss);
        el.tp1.textContent = formatPrice(trade.target1);
        el.tp2.textContent = formatPrice(trade.target2);

        el.structure.textContent = analysis.market_structure || '—';
        el.rr.textContent = trade.risk_reward || '—';
        el.tf.textContent =
          (analysis.timeframe || (meta && meta.timeframe) || '—') +
          (meta && meta.candleCount ? ' · ' + meta.candleCount + ' candle' + (meta.candleCount === 1 ? '' : 's') : '');

        el.patterns.textContent = '';
        const tags = []
          .concat(analysis.patterns && analysis.patterns.candlestick ? analysis.patterns.candlestick : [])
          .concat(analysis.patterns && analysis.patterns.chart ? analysis.patterns.chart : [])
          .slice(0, 6);
        tags.forEach(function (tag) {
          const chip = document.createElement('span');
          chip.className = 'acp-chip';
          chip.textContent = tag;
          el.patterns.appendChild(chip);
        });
        if (!tags.length) el.patterns.textContent = '';

        el.reasoning.textContent = analysis.reasoning || '';

        const warningText = (Array.isArray(warnings) ? warnings : []).filter(Boolean).join(' ');
        el.warnings.hidden = !warningText;
        el.warnings.textContent = warningText;

        const metaParts = [];
        if (meta && meta.providerLabel) metaParts.push(meta.providerLabel);
        if (meta && meta.model) metaParts.push(meta.model);
        if (meta && meta.latencyMs) metaParts.push((meta.latencyMs / 1000).toFixed(1) + 's');
        if (meta && meta.attempt > 1) metaParts.push('retry #' + meta.attempt);
        el.meta.textContent = metaParts.join(' · ');
      },
      clearResult: function () {
        el.result.hidden = true;
        el.patterns.textContent = '';
      },
      /** Current control values — read live so typing without blurring still counts. */
      getValues: function () {
        return {
          providerId: el.provider.value,
          model: el.model.value.trim() || ACP.providers.defaultModel(el.provider.value),
          timeframe: el.timeframe.value,
          candleCount: Number(el.candles.value),
          liveIntervalSec: Number(el.interval.value)
        };
      },
      isCollapsed: function () {
        return el.panel.dataset.collapsed === 'true';
      },
      setCollapsed: setCollapsed,
      toggleCollapsed: function () {
        setCollapsed(el.panel.dataset.collapsed !== 'true');
      },
      clampToViewport: function () {
        if (dragState) return;
        reclamp();
      },
      applyPosition: applyPosition,
      getPosition: currentPosition,
      destroy: function () {
        window.removeEventListener('resize', onWindowResize);
        shell.remove();
      },
      root: shell
    };

    /* ---------------------------------------------------------------- *
     * Initial render
     * ---------------------------------------------------------------- */

    fillProviders();
    fillStaticSelects();
    el.provider.value = settings.providerId;
    fillModels(settings.providerId, settings.model || ACP.providers.defaultModel(settings.providerId));
    el.timeframe.value = settings.timeframe;
    el.candles.value = String(settings.candleCount);
    el.interval.value = String(settings.liveIntervalSec);
    el.interval.disabled = !settings.liveEnabled;
    el.live.checked = settings.liveEnabled;
    updateVisionWarning();

    const panelSettings = settings.panel || {};
    applyPosition(
      typeof panelSettings.left === 'number' ? panelSettings.left : null,
      typeof panelSettings.top === 'number' ? panelSettings.top : null
    );
    setCollapsed(panelSettings.collapsed === true, true);
    api.setStatus('', {});

    return api;
  }

  ACP.panel = { mount: mount, formatPrice: formatPrice };
})(typeof self !== 'undefined' ? self : this);
