/**
 * AI Chart Predictor — coordinate helpers.
 *
 * The AI is asked to return y coordinates as a fraction of the screenshot
 * height (and x as a fraction of the width). This module converts between those
 * normalised values, screen pixels and price values.
 *
 * Import modes (all optional, the others take over when one is missing):
 *   1. `price_scale`  — two reference points (price + normalised y) supplied by
 *                        the model, which lets prices be mapped onto the chart.
 *   2. two support/resistance levels — same idea, derived from the levels list.
 *   3. `autoFitScale` — pure fallback that fits the predicted candles into a
 *                        band around the last visible candle.
 */
(function (global) {
  'use strict';

  const ACP = (global.ACP = global.ACP || {});
  const EPS = 1e-9;

  function isNum(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function clamp(value, min, max) {
    if (!isNum(value)) return min;
    return value < min ? min : value > max ? max : value;
  }

  function clamp01(value) {
    return clamp(value, 0, 1);
  }

  /**
   * Tolerant number parser: accepts numbers, numeric strings, prices with
   * thousands separators / currency symbols and percentages.
   * Returns null when the value cannot be interpreted as a finite number.
   */
  function asNumber(value) {
    if (isNum(value)) return value;
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/[,\s%$€£¥]/g, '').replace(/[^\d.eE+-]/g, '');
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Normalised y (0 = top, 1 = bottom) -> pixel y for the given canvas height. */
  function normToPx(value, size) {
    return clamp01(value) * size;
  }

  /** Pixel y -> normalised y for the given canvas height. */
  function pxToNorm(pixels, size) {
    if (!isNum(size) || size <= 0) return 0;
    return clamp01(pixels / size);
  }

  function toPoint(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const price = asNumber(raw.price != null ? raw.price : raw.value);
    const y = asNumber(raw.y != null ? raw.y : raw.norm_y);
    if (price == null || y == null) return null;
    return { price: price, y: clamp01(y) };
  }

  /**
   * Build a linear price <-> pixel-y mapping from two reference points.
   * `slope` is (pixel delta) / (price delta); prices rise upwards on screen so
   * the slope is normally negative.
   */
  function buildPriceScale(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const a = toPoint(raw.point_a || raw.pointA || raw.a);
    const b = toPoint(raw.point_b || raw.pointB || raw.b);
    if (!a || !b) return null;

    const priceDelta = a.price - b.price;
    const yDelta = a.y - b.y;
    if (Math.abs(priceDelta) < EPS || Math.abs(yDelta) < 1e-4) return null;

    const slope = yDelta / priceDelta;
    if (!isNum(slope) || Math.abs(slope) < EPS) return null;

    return {
      pointA: a,
      pointB: b,
      slope: slope,
      /** price -> normalised y */
      yFor: function (price) {
        const numeric = asNumber(price);
        if (numeric == null) return null;
        return a.y + (numeric - a.price) * slope;
      },
      /** normalised y -> price */
      priceFor: function (y) {
        const numeric = asNumber(y);
        if (numeric == null) return null;
        return a.price + (numeric - a.y) / slope;
      }
    };
  }

  /**
   * Derive a price scale from any two levels that carry both a price and a
   * normalised y value. Picks the widest price separation for accuracy.
   */
  function scaleFromLevels(levels) {
    if (!Array.isArray(levels)) return null;
    const points = [];
    for (let i = 0; i < levels.length; i += 1) {
      const level = levels[i];
      if (!level || typeof level !== 'object') continue;
      const price = asNumber(level.price);
      const y = asNumber(level.y);
      if (price == null || y == null) continue;
      points.push({ price: price, y: clamp01(y) });
    }
    if (points.length < 2) return null;

    let best = null;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const priceGap = Math.abs(points[i].price - points[j].price);
        const yGap = Math.abs(points[i].y - points[j].y);
        if (priceGap < EPS || yGap < 1e-4) continue;
        if (!best || priceGap > best.priceGap) {
          best = { priceGap: priceGap, a: points[i], b: points[j] };
        }
      }
    }
    if (!best) return null;
    return buildPriceScale({ point_a: best.a, point_b: best.b });
  }

  /**
   * Fallback scale: stretch the predicted candle range into a band around
   * `anchorY` (normalised). Used when the model gave no reference points at all.
   */
  function autoFitScale(candles, anchorY, span) {
    const prices = [];
    (Array.isArray(candles) ? candles : []).forEach(function (candle) {
      if (!candle) return;
      ['high', 'low', 'open', 'close'].forEach(function (key) {
        const value = asNumber(candle[key]);
        if (value != null) prices.push(value);
      });
    });
    if (prices.length < 2) return null;

    let min = prices[0];
    let max = prices[0];
    for (let i = 1; i < prices.length; i += 1) {
      if (prices[i] < min) min = prices[i];
      if (prices[i] > max) max = prices[i];
    }
    if (!(max > min)) return null;

    const anchor = clamp(asNumber(anchorY) != null ? asNumber(anchorY) : 0.55, 0.1, 0.9);
    const half = clamp(asNumber(span) != null ? asNumber(span) : 0.09, 0.02, 0.4);

    return buildPriceScale({
      point_a: { price: max, y: clamp(anchor - half, 0, 1) },
      point_b: { price: min, y: clamp(anchor + half, 0, 1) }
    });
  }

  ACP.coords = {
    isNum: isNum,
    clamp: clamp,
    clamp01: clamp01,
    asNumber: asNumber,
    normToPx: normToPx,
    pxToNorm: pxToNorm,
    buildPriceScale: buildPriceScale,
    scaleFromLevels: scaleFromLevels,
    autoFitScale: autoFitScale
  };
})(typeof self !== 'undefined' ? self : this);
