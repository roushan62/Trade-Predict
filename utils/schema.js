/**
 * AI Chart Predictor — AI response extraction + strict validation.
 *
 * Models regularly wrap JSON in prose or markdown fences, emit trailing commas
 * or return numbers as strings ("75%"). This module extracts the first usable
 * JSON value, validates every field we draw with, and normalises everything
 * into a predictable shape. Anything that cannot be repaired is reported back
 * so background.js can retry the request once with a repair instruction.
 */
(function (global) {
  'use strict';

  const ACP = (global.ACP = global.ACP || {});
  const coords = ACP.coords;
  const clamp = coords.clamp;
  const clamp01 = coords.clamp01;
  const asNumber = coords.asNumber;

  const MAX_LEVELS = 24;
  const MAX_ZONES = 12;
  const MAX_TRENDLINES = 12;
  const MAX_TAGS = 12;

  const TREND_MAP = {
    bullish: 'bullish',
    bull: 'bullish',
    long: 'bullish',
    up: 'bullish',
    uptrend: 'bullish',
    'bullish trend': 'bullish',
    bearish: 'bearish',
    bear: 'bearish',
    short: 'bearish',
    down: 'bearish',
    downtrend: 'bearish',
    'bearish trend': 'bearish',
    sideways: 'sideways',
    sideway: 'sideways',
    range: 'sideways',
    ranging: 'sideways',
    ranging_sideways: 'sideways',
    neutral: 'sideways',
    flat: 'sideways',
    consolidation: 'sideways',
    chop: 'sideways',
    choppy: 'sideways'
  };

  const DIRECTION_MAP = {
    long: 'long',
    buy: 'long',
    bullish: 'long',
    short: 'short',
    sell: 'short',
    bearish: 'short',
    none: 'none',
    neutral: 'none',
    wait: 'none',
    no_trade: 'none',
    'no trade': 'none'
  };

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /** First defined value of the given keys. */
  function pick(source, keys) {
    if (!isPlainObject(source)) return undefined;
    for (let i = 0; i < keys.length; i += 1) {
      const value = source[keys[i]];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  /** Single-line, trimmed, length-capped string. */
  function asString(value, maxLength) {
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string') return '';
    const text = value.replace(/\s+/g, ' ').trim();
    return typeof maxLength === 'number' ? text.slice(0, maxLength) : text;
  }

  /** Multi-line text (reasoning) with whitespace tidied up. */
  function asText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const text = value
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return typeof maxLength === 'number' ? text.slice(0, maxLength) : text;
  }

  function asList(value, maxLength) {
    const out = [];
    if (typeof value === 'string') {
      value.split(/[,;|]/).forEach(function (part) {
        const text = asString(part, maxLength);
        if (text) out.push(text);
      });
    } else if (Array.isArray(value)) {
      value.forEach(function (item) {
        const text = asString(
          isPlainObject(item) ? pick(item, ['name', 'pattern', 'type', 'label']) : item,
          maxLength
        );
        if (text) out.push(text);
      });
    }
    return out.slice(0, MAX_TAGS);
  }

  /* ------------------------------------------------------------------ *
   * JSON extraction
   * ------------------------------------------------------------------ */

  /** Return the index of the bracket that closes the one at `start`, or -1. */
  function matchBalanced(text, start) {
    const openChar = text[start];
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === openChar) {
        depth += 1;
      } else if (char === closeChar) {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** Every balanced {...} / [...] block in the string, in order of appearance. */
  function findJsonCandidates(text) {
    const candidates = [];
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (char !== '{' && char !== '[') continue;
      const end = matchBalanced(text, i);
      if (end < i) continue;
      // Outer object first, then its nested objects (which are reached by the
      // normal loop increment) so a truncated outer object can still be saved
      // by a well-formed inner one.
      candidates.push(text.slice(i, end + 1));
    }
    return candidates;
  }

  function tryParse(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (error) {
      /* fall through to a light repair pass */
    }
    // Common model mistakes: trailing commas, smart quotes, leading // comments.
    const repaired = text
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    try {
      return { ok: true, value: JSON.parse(repaired), repaired: true };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : 'Invalid JSON' };
    }
  }

  /**
   * Extract the first JSON object/array found in `rawText`.
   * @returns {{ok:boolean, value?:object, error?:string}}
   */
  function extractJson(rawText) {
    const raw = String(rawText == null ? '' : rawText).replace(/^\uFEFF/, '').trim();
    if (!raw) return { ok: false, error: 'The model returned an empty response.' };

    const sources = [];
    const fenced = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fenced && fenced[1] && fenced[1].trim()) sources.push(fenced[1].trim());
    sources.push(raw);

    let lastError = 'No JSON object was found in the response.';

    for (let s = 0; s < sources.length; s += 1) {
      const source = sources[s];
      const direct = tryParse(source);
      if (direct.ok && (isPlainObject(direct.value) || Array.isArray(direct.value))) {
        return { ok: true, value: direct.value, repaired: direct.repaired === true };
      }
      if (!direct.ok && direct.error) lastError = direct.error;

      const candidates = findJsonCandidates(source);
      for (let c = 0; c < candidates.length; c += 1) {
        const parsed = tryParse(candidates[c]);
        if (parsed.ok && (isPlainObject(parsed.value) || Array.isArray(parsed.value))) {
          return { ok: true, value: parsed.value, repaired: parsed.repaired === true };
        }
        if (!parsed.ok && parsed.error) lastError = parsed.error;
      }
    }

    return { ok: false, error: lastError };
  }

  /* ------------------------------------------------------------------ *
   * Validation
   * ------------------------------------------------------------------ */

  /**
   * Detect models that answered in 0-100 percentages instead of 0-1 fractions.
   * Returns 1 (already normalised) or 100 (divide by 100).
   */
  function detectCoordScale(data) {
    const values = [];
    const push = function (value) {
      const numeric = asNumber(value);
      if (numeric != null) values.push(Math.abs(numeric));
    };

    const levels = data.support_resistance || data.supportResistance || data.levels;
    (Array.isArray(levels) ? levels : []).forEach(function (level) {
      if (!isPlainObject(level)) return;
      push(level.y);
      push(level.y1);
      push(level.y2);
    });

    (Array.isArray(data.zones) ? data.zones : []).forEach(function (zone) {
      if (!isPlainObject(zone)) return;
      push(zone.x1);
      push(zone.y1);
      push(zone.x2);
      push(zone.y2);
    });

    (Array.isArray(data.trendlines) ? data.trendlines : []).forEach(function (line) {
      if (!isPlainObject(line)) return;
      push(line.x1);
      push(line.y1);
      push(line.x2);
      push(line.y2);
    });

    const scaleRaw = data.price_scale || data.priceScale || data.scale;
    if (isPlainObject(scaleRaw)) {
      [scaleRaw.point_a || scaleRaw.pointA, scaleRaw.point_b || scaleRaw.pointB].forEach(function (point) {
        if (isPlainObject(point)) push(point.y);
      });
    }

    const lastCandle = data.last_candle || data.lastCandle;
    if (isPlainObject(lastCandle)) {
      push(lastCandle.x);
      push(lastCandle.y);
      push(lastCandle.width);
    }

    if (!values.length) return 1;
    let large = 0;
    let maximum = 0;
    values.forEach(function (value) {
      if (value > maximum) maximum = value;
      if (value > 1.05) large += 1;
    });
    if (maximum > 100) return 1; // unusable anyway, clamping handles it
    if (large >= 2 && large >= Math.floor(values.length * 0.5)) return 100;
    return 1;
  }

  function normalizeLevels(rawLevels, scale) {
    const out = [];
    (Array.isArray(rawLevels) ? rawLevels : []).forEach(function (raw) {
      if (!isPlainObject(raw)) return;
      const price = asNumber(pick(raw, ['price', 'level', 'value']));
      const yRaw = asNumber(pick(raw, ['y', 'norm_y', 'y_norm']));
      if (price == null && yRaw == null) return;

      const typeRaw = asString(pick(raw, ['type', 'kind', 'role']), 24).toLowerCase();
      const type = /supp|demand|floor/.test(typeRaw) ? 'support' : /resist|supply|ceiling/.test(typeRaw) ? 'resistance' : 'level';

      out.push({
        type: type,
        price: price,
        y: yRaw == null ? null : clamp01(yRaw / scale),
        label: asString(pick(raw, ['label', 'note', 'description']), 60)
      });
    });
    return out.slice(0, MAX_LEVELS);
  }

  function normalizeZones(rawZones, scale) {
    const out = [];
    (Array.isArray(rawZones) ? rawZones : []).forEach(function (raw) {
      if (!isPlainObject(raw)) return;
      const x1 = asNumber(pick(raw, ['x1', 'left', 'x_start']));
      const y1 = asNumber(pick(raw, ['y1', 'top', 'y_start']));
      const x2 = asNumber(pick(raw, ['x2', 'right', 'x_end']));
      const y2 = asNumber(pick(raw, ['y2', 'bottom', 'y_end']));
      if (x1 == null || y1 == null || x2 == null || y2 == null) return;

      const typeRaw = asString(pick(raw, ['type', 'kind', 'zone_type']), 24).toLowerCase();
      const type = /demand|support|bull/.test(typeRaw) ? 'demand' : /supply|resist|bear/.test(typeRaw) ? 'supply' : 'neutral';

      out.push({
        type: type,
        x1: clamp01(x1 / scale),
        y1: clamp01(y1 / scale),
        x2: clamp01(x2 / scale),
        y2: clamp01(y2 / scale),
        label: asString(pick(raw, ['label', 'note', 'description']), 60)
      });
    });
    return out.slice(0, MAX_ZONES);
  }

  function normalizeTrendlines(rawLines, scale) {
    const out = [];
    (Array.isArray(rawLines) ? rawLines : []).forEach(function (raw) {
      if (!isPlainObject(raw)) return;
      const x1 = asNumber(pick(raw, ['x1', 'start_x', 'x_start']));
      const y1 = asNumber(pick(raw, ['y1', 'start_y', 'y_start']));
      const x2 = asNumber(pick(raw, ['x2', 'end_x', 'x_end']));
      const y2 = asNumber(pick(raw, ['y2', 'end_y', 'y_end']));
      if (x1 == null || y1 == null || x2 == null || y2 == null) return;
      out.push({
        x1: clamp01(x1 / scale),
        y1: clamp01(y1 / scale),
        x2: clamp01(x2 / scale),
        y2: clamp01(y2 / scale),
        label: asString(pick(raw, ['label', 'note', 'description']), 60)
      });
    });
    return out.slice(0, MAX_TRENDLINES);
  }

  function normalizeCandle(raw, fallbackClose) {
    if (!isPlainObject(raw)) return null;
    const open = asNumber(pick(raw, ['open', 'o']));
    const high = asNumber(pick(raw, ['high', 'h']));
    const low = asNumber(pick(raw, ['low', 'l']));
    const close = asNumber(pick(raw, ['close', 'c']));
    const any = [open, high, low, close].filter(function (value) {
      return value != null;
    });
    if (!any.length) return null;

    const openValue = open != null ? open : fallbackClose != null ? fallbackClose : any[0];
    const closeValue = close != null ? close : openValue;

    let highValue = high != null ? high : Math.max(openValue, closeValue);
    let lowValue = low != null ? low : Math.min(openValue, closeValue);

    // Repair inverted or too-tight wicks instead of rejecting the whole answer.
    highValue = Math.max(highValue, openValue, closeValue);
    lowValue = Math.min(lowValue, openValue, closeValue);

    return { open: openValue, high: highValue, low: lowValue, close: closeValue };
  }

  function normalizeTrade(raw) {
    const trade = isPlainObject(raw) ? raw : {};
    const directionRaw = asString(pick(trade, ['direction', 'side', 'bias']), 24).toLowerCase();
    const entry = asNumber(pick(trade, ['entry', 'entry_price', 'entryPrice']));
    const stop = asNumber(pick(trade, ['stop_loss', 'stopLoss', 'stop', 'sl']));
    const target1 = asNumber(pick(trade, ['target1', 'target_1', 'tp1', 'take_profit_1', 'takeProfit1']));
    const target2 = asNumber(pick(trade, ['target2', 'target_2', 'tp2', 'take_profit_2', 'takeProfit2']));

    let riskReward = asString(pick(trade, ['risk_reward', 'riskReward', 'rr', 'r_r']), 24);
    if (!riskReward && entry != null && stop != null && target1 != null) {
      const risk = Math.abs(entry - stop);
      const reward = Math.abs(target1 - entry);
      if (risk > 0 && reward > 0) riskReward = '1 : ' + (reward / risk).toFixed(2);
    }
    if (riskReward && !/^\d/.test(riskReward)) riskReward = riskReward.replace(/^[^0-9]*/, '');

    return {
      direction: DIRECTION_MAP[directionRaw] || 'none',
      entry: entry,
      stop_loss: stop,
      target1: target1,
      target2: target2,
      risk_reward: riskReward
    };
  }

  function normalizePatterns(raw) {
    if (Array.isArray(raw) || typeof raw === 'string') {
      return { candlestick: asList(raw, 80), chart: [] };
    }
    const source = isPlainObject(raw) ? raw : {};
    return {
      candlestick: asList(pick(source, ['candlestick', 'candlesticks', 'candle_patterns', 'candlestick_patterns']), 80),
      chart: asList(pick(source, ['chart', 'chart_patterns', 'patterns']), 80)
    };
  }

  function normalizeIndicators(raw) {
    const source = isPlainObject(raw) ? raw : {};
    return {
      rsi: asString(pick(source, ['rsi', 'RSI']), 120),
      macd: asString(pick(source, ['macd', 'MACD']), 120),
      ma: asString(pick(source, ['ma', 'moving_average', 'moving_averages', 'emas']), 120),
      volume: asString(pick(source, ['volume', 'vol']), 120)
    };
  }

  function normalizePriceScale(raw, scale) {
    if (!isPlainObject(raw)) return null;
    const a = raw.point_a || raw.pointA || raw.a;
    const b = raw.point_b || raw.pointB || raw.b;
    if (!isPlainObject(a) || !isPlainObject(b)) return null;
    const priceA = asNumber(a.price);
    const priceB = asNumber(b.price);
    const yA = asNumber(a.y);
    const yB = asNumber(b.y);
    if (priceA == null || priceB == null || yA == null || yB == null) return null;
    return {
      point_a: { price: priceA, y: clamp01(yA / scale) },
      point_b: { price: priceB, y: clamp01(yB / scale) }
    };
  }

  function normalizeLastCandle(raw, scale) {
    if (!isPlainObject(raw)) return null;
    const x = asNumber(pick(raw, ['x', 'center_x', 'cx']));
    const y = asNumber(pick(raw, ['y', 'center_y', 'cy']));
    const width = asNumber(pick(raw, ['width', 'w', 'body_width']));
    if (x == null) return null;
    return {
      x: clamp01(x / scale),
      y: y == null ? null : clamp01(y / scale),
      width: width == null ? 0.015 : clamp(width / scale, 0.004, 0.06)
    };
  }

  /**
   * Normalise a provider reply into the shape the overlay draws.
   *
   * @param {string} rawText Raw model output.
   * @param {{candleCount?:number, timeframe?:string}} options
   * @returns {{ok:boolean, analysis:object|null, errors:string[], warnings:string[]}}
   */
  function parseAnalysis(rawText, options) {
    const opts = options || {};
    const expectedCandles = clamp(Math.round(asNumber(opts.candleCount) != null ? asNumber(opts.candleCount) : 3), 1, 5);

    const errors = [];
    const warnings = [];
    const fail = function () {
      return { ok: false, analysis: null, errors: errors, warnings: warnings };
    };

    const extracted = extractJson(rawText);
    if (!extracted.ok) {
      errors.push('Response was not valid JSON (' + extracted.error + ').');
      return fail();
    }

    let data = extracted.value;
    if (Array.isArray(data)) data = data[0];
    if (!isPlainObject(data)) {
      errors.push('The JSON root must be an object.');
      return fail();
    }
    if (isPlainObject(data.analysis)) data = data.analysis;

    const scale = detectCoordScale(data);

    /* --- trend ---------------------------------------------------- */
    const trendRaw = asString(pick(data, ['trend', 'market_trend', 'bias']), 32).toLowerCase();
    const trend = TREND_MAP[trendRaw] || null;
    if (!trend) {
      errors.push('"trend" must be one of "bullish", "bearish" or "sideways" (received: ' + (trendRaw || 'nothing') + ').');
    }

    /* --- confidence ----------------------------------------------- */
    let confidence = asNumber(pick(data, ['confidence', 'confidence_percent', 'conviction']));
    if (confidence == null) {
      confidence = 50;
      warnings.push('The model did not return a confidence value; 50% was assumed.');
    } else {
      if (confidence > 0 && confidence <= 1) confidence *= 100; // 0.82 -> 82
      confidence = Math.round(clamp(confidence, 0, 100));
    }

    /* --- levels / zones / trendlines ------------------------------ */
    const levels = normalizeLevels(
      data.support_resistance || data.supportResistance || data.levels,
      scale
    );
    if (!levels.length) warnings.push('No support/resistance levels were returned.');
    const zones = normalizeZones(data.zones || data.supply_demand_zones, scale);
    const trendlines = normalizeTrendlines(data.trendlines || data.trend_lines, scale);

    /* --- predicted candles ---------------------------------------- */
    const rawCandles = data.predicted_candles || data.predictedCandles || data.ghost_candles;
    let predicted = (Array.isArray(rawCandles) ? rawCandles : [])
      .map(function (candle) {
        return normalizeCandle(candle, null);
      })
      .filter(Boolean);

    if (!predicted.length) {
      errors.push('"predicted_candles" must be a non-empty array of OHLC objects.');
    } else {
      if (predicted.length > expectedCandles) predicted = predicted.slice(0, expectedCandles);
      if (predicted.length < expectedCandles) {
        warnings.push(
          'Asked for ' + expectedCandles + ' candle(s) but the model returned ' + predicted.length +
          '; the remainder is drawn flat at the last close.'
        );
        while (predicted.length < expectedCandles) {
          const lastClose = predicted[predicted.length - 1].close;
          predicted.push({ open: lastClose, high: lastClose, low: lastClose, close: lastClose });
        }
      }
    }

    if (!trend || !predicted.length) return fail();

    /* --- everything else ------------------------------------------ */
    const trade = normalizeTrade(data.trade || data.trade_setup || data.tradeSetup);

    const analysis = {
      symbol: asString(pick(data, ['symbol', 'ticker', 'pair', 'instrument']), 40),
      timeframe: asString(pick(data, ['timeframe', 'time_frame', 'interval']), 20) || asString(opts.timeframe, 20),
      trend: trend,
      market_structure: asString(pick(data, ['market_structure', 'structure', 'market_structure_hh_hl']), 160),
      confidence: confidence,
      reasoning: asText(pick(data, ['reasoning', 'analysis', 'explanation', 'summary']), 2400),
      support_resistance: levels,
      zones: zones,
      trendlines: trendlines,
      patterns: normalizePatterns(data.patterns || data.pattern),
      indicators: normalizeIndicators(data.indicators || data.indicator),
      trade: trade,
      price_scale: normalizePriceScale(data.price_scale || data.priceScale || data.scale, scale),
      last_candle: normalizeLastCandle(data.last_candle || data.lastCandle, scale),
      predicted_candles: predicted
    };

    if (!analysis.reasoning) warnings.push('The model returned no reasoning text.');
    if (!zones.length) warnings.push('No supply/demand zones were returned.');
    if (!trendlines.length) warnings.push('No trendlines were returned.');
    if (analysis.last_candle == null) {
      warnings.push('No last_candle anchor was returned; ghost candles were placed automatically.');
    }
    if (extracted.repaired) warnings.push('The response JSON needed light repairs (trailing commas or smart quotes).');

    return { ok: true, analysis: analysis, errors: [], warnings: warnings };
  }

  ACP.schema = {
    parseAnalysis: parseAnalysis,
    extractJson: extractJson,
    TREND_MAP: TREND_MAP
  };
})(typeof self !== 'undefined' ? self : this);
