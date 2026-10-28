/**
 * AI Chart Predictor — prompt builder.
 *
 * The prompt is intentionally explicit about coordinates (0..1 fractions of
 * the screenshot) so the overlay can place every drawing deterministically.
 * The example object doubles as a schema reference for the model.
 */
(function (global) {
  'use strict';

  const ACP = (global.ACP = global.ACP || {});

  const SYSTEM_PROMPT = [
    'You are a senior technical analyst and price-action specialist.',
    'You receive ONE screenshot of a trading chart and you answer with a single JSON object.',
    '',
    'COORDINATE SYSTEM',
    '- Every "x" and "y" is a fraction of the screenshot: 0 = left/top edge, 1 = right/bottom edge.',
    '- Use the visible price axis to estimate y. High prices are near the top (small y).',
    '- "last_candle" must point at the most recent COMPLETED candle that is visible (x = its centre, width = its body width, all as fractions).',
    '',
    'RULES',
    '- Output raw JSON only. No markdown fences, no comments, no prose before or after.',
    '- Numbers must be JSON numbers (write 64250.5, never "64250.5" or "64,250").',
    '- Do not invent indicators that are not visible in the screenshot; use an empty string when absent.',
    '- If price levels are unreadable, still give your best numeric estimate; never return null for prices.',
    '- The last predicted candle must not be more than 5% away from the last visible close.',
    '- Be honest in "confidence": 0-100.'
  ].join('\n');

  const JSON_TEMPLATE = {
    symbol: 'BTCUSD',
    timeframe: '15m',
    trend: 'bullish',
    market_structure: 'HH/HL — higher highs and higher lows since the 09:00 retest',
    confidence: 68,
    reasoning: 'Price reclaimed the 4h demand zone and printed a bullish engulfing candle above the 20 EMA. RSI is 58 and turning up; MACD histogram is shrinking negative. Expect a retest of the supply zone above.',
    support_resistance: [
      { type: 'support', price: 64120.5, y: 0.71, label: '4h demand' },
      { type: 'resistance', price: 66240.0, y: 0.24, label: 'swing high' }
    ],
    zones: [
      { type: 'demand', x1: 0.08, y1: 0.68, x2: 0.92, y2: 0.76, label: 'demand block' },
      { type: 'supply', x1: 0.2, y1: 0.18, x2: 0.95, y2: 0.27, label: 'supply zone' }
    ],
    trendlines: [{ x1: 0.05, y1: 0.82, x2: 0.9, y2: 0.52, label: 'rising trendline' }],
    patterns: { candlestick: ['bullish engulfing', 'hammer'], chart: ['ascending triangle'] },
    indicators: { rsi: 'RSI 58 rising', macd: 'MACD below zero, histogram rising', ma: 'price above 20/50 EMA', volume: 'volume expanding on the breakout' },
    trade: { direction: 'long', entry: 65180, stop_loss: 64320, target1: 66240, target2: 67310, risk_reward: '1 : 1.24' },
    price_scale: { point_a: { price: 66240.0, y: 0.24 }, point_b: { price: 64120.5, y: 0.71 } },
    last_candle: { x: 0.86, y: 0.46, width: 0.015 },
    predicted_candles: [{ open: 65180, high: 65740, low: 65010, close: 65620 }]
  };

  /**
   * @param {{timeframe:string, candleCount:number, imageWidth?:number, imageHeight?:number}} options
   * @returns {string} user prompt
   */
  function build(options) {
    const opts = options || {};
    const timeframe = opts.timeframe || '15m';
    const candleCount = Math.max(1, Math.min(5, Number(opts.candleCount) || 1));
    const resolution = opts.imageWidth && opts.imageHeight
      ? '\nScreenshot size: ' + opts.imageWidth + ' x ' + opts.imageHeight + ' pixels.'
      : '';

    const template = JSON.parse(JSON.stringify(JSON_TEMPLATE));
    template.timeframe = timeframe;
    template.predicted_candles = [];
    const base = JSON_TEMPLATE.predicted_candles[0];
    for (let i = 0; i < candleCount; i += 1) {
      const drift = i * 120;
      template.predicted_candles.push({
        open: base.open + drift,
        high: base.high + drift,
        low: base.low + drift,
        close: base.close + drift
      });
    }
    template.trade.entry = 65180;
    template.trade.stop_loss = 64320;
    template.trade.target1 = 66240;
    template.trade.target2 = 67310;

    return [
      'Analyse the trading chart in the attached screenshot.' + resolution,
      '',
      'Selected timeframe: ' + timeframe + ' (the visible chart may show another timeframe — assume the visible candles are ' + timeframe + ' candles and predict the next ' + timeframe + ' candles).',
      'Predict exactly ' + candleCount + ' future candle' + (candleCount === 1 ? '' : 's') + ' of the ' + timeframe + ' timeframe, continuing from the last closed candle.',
      '',
      'Report all of the following:',
      '1. trend: "bullish", "bearish" or "sideways".',
      '2. market_structure: the swing sequence using HH/HL/LH/LL notation.',
      '3. support_resistance: the horizontal levels you can see, with their price AND their y position.',
      '4. zones: supply and demand / order-block rectangles as x1,y1 (top-left) and x2,y2 (bottom-right).',
      '5. trendlines: the dominant lines with both end points.',
      '6. patterns: candlestick and chart patterns that are actually visible.',
      '7. indicators: RSI, MACD, moving averages and volume ONLY if they are visible in the screenshot.',
      '8. trade: direction, entry, stop_loss, target1, target2 and risk_reward.',
      '9. confidence: 0-100 and reasoning: two or three sentences.',
      '10. predicted_candles: ' + candleCount + ' OHLC candle' + (candleCount === 1 ? '' : 's') + ' for ' + timeframe + ' after the last visible candle. Each candle must satisfy low <= open/close <= high and must be a plausible continuation of the chart.',
      '',
      'Return exactly one JSON object with this shape (the values below are an EXAMPLE - replace every one of them with the real analysis of the screenshot):',
      JSON.stringify(template, null, 2),
      '',
      'Output the JSON object now. Nothing else.'
    ].join('\n');
  }

  /**
   * Follow-up prompt used for the single JSON retry.
   * @param {{timeframe:string, candleCount:number, imageWidth?:number, imageHeight?:number}} options
   * @param {string[]} errors validation errors from the first attempt
   * @param {string} previousText the rejected raw answer
   */
  function buildRepair(options, errors, previousText) {
    const list = (Array.isArray(errors) ? errors : [])
      .slice(0, 6)
      .map(function (error) {
        return '- ' + error;
      })
      .join('\n');

    const previous = typeof previousText === 'string' ? previousText.slice(0, 1200) : '';

    return [
      build(options),
      '',
      '---',
      'YOUR PREVIOUS ANSWER WAS REJECTED because:',
      list || '- the JSON was invalid.',
      '',
      previous ? 'Previous answer (for reference only, do not copy it):\n' + previous : '',
      '',
      'Return the corrected FULL JSON object and nothing else. Keep every required key.'
    ].join('\n');
  }

  /** Minimal prompt used by the "Test connection" button. */
  function buildConnectionTest() {
    return 'Reply with exactly this JSON and nothing else: {"ok": true}';
  }

  ACP.prompt = {
    system: SYSTEM_PROMPT,
    build: build,
    buildRepair: buildRepair,
    buildConnectionTest: buildConnectionTest,
    template: JSON_TEMPLATE
  };
})(typeof self !== 'undefined' ? self : this);
