/**
 * AI Chart Predictor — provider registry + shared OpenAI-compatible adapter.
 *
 * Every provider is described by a small object with:
 *   id, label, docsUrl, defaultBaseUrl, defaultModel, models[], requiresKey
 *   buildRequest(ctx)  -> { url, init }            (ctx: apiKey, model, baseUrl, dataUrl, prompt, ...)
 *   parseResponse(json) -> string                  (the raw model text)
 *
 * OpenAI-style providers are created with `createChatAdapter`; Gemini and
 * Anthropic ship their own `buildRequest` / `parseResponse` implementations.
 */
(function (global) {
  'use strict';

  const ACP = (global.ACP = global.ACP || {});

  const registry = Object.create(null);
  const order = [];

  function register(adapter) {
    if (!adapter || !adapter.id) {
      console.warn('[ACP] register() called without an adapter id');
      return;
    }
    if (!registry[adapter.id]) order.push(adapter.id);
    registry[adapter.id] = adapter;
  }

  function list() {
    return order.map(function (id) {
      return registry[id];
    });
  }

  function get(id) {
    return registry[id] || null;
  }

  function modelsFor(id) {
    const provider = get(id);
    return provider && Array.isArray(provider.models) ? provider.models : [];
  }

  function defaultModel(id) {
    const provider = get(id);
    if (!provider) return '';
    if (provider.defaultModel) return provider.defaultModel;
    const models = modelsFor(id);
    return models.length ? models[0].id : '';
  }

  /* ------------------------------------------------------------------ *
   * Vision capability heuristics
   * ------------------------------------------------------------------ */

  const TEXT_ONLY_PATTERNS = [
    /\b(gpt-3\.5|text-embedding|whisper|tts-1|dall-e|gpt-image|moderation)/,
    /\b(o1-mini|o1-preview)\b/,
    /\bgemini-1\.0/,
    /\bdeepseek-(chat|reasoner|coder|v3|r1)\b/,
    /\bmistral-(tiny|small|medium|large|nemo|7b)\b/,
    /\b(llama-?3\.?[12]?-(8b|70b|405b)|llama3-(8b|70b))/,
    /\b(mixtral|qwen-?(7b|14b|32b|72b)-instruct|gemma)/,
    /\b(phi-?[34]|granite|command-r)\b/
  ];

  const VISION_PATTERNS = [
    /\b(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|o3|o4-mini)\b/,
    /\bgemini-(1\.5|2|2\.5|3)/,
    /\bclaude-(3|4|instant|sonnet|opus|haiku)\b/,
    /\b(grok-(2|3|4))/,
    /\b(llava|pixtral|qwen[\w.-]*vl|llama[\w.-]*vision|internvl|minicpm-v)\b/,
    /vision/
  ];

  /**
   * @returns {{status:('supported'|'unsupported'|'unknown'), message:string}}
   */
  function visionInfo(providerId, modelId) {
    const provider = get(providerId);
    const model = String(modelId || '').trim();

    if (!provider) {
      return { status: 'unknown', message: 'Unknown provider "' + providerId + '".' };
    }
    if (!model) {
      return { status: 'unknown', message: 'Pick a model to check image support.' };
    }

    const lower = model.toLowerCase();
    const known = modelsFor(providerId).filter(function (entry) {
      return String(entry.id).toLowerCase() === lower;
    })[0];
    if (known) {
      return known.vision
        ? { status: 'supported', message: known.label + ' can read images.' }
        : {
            status: 'unsupported',
            message:
              provider.label + ' model "' + model +
              '" cannot read images. Choose a vision model or the analysis will fail.'
          };
    }

    const prefixMatch = modelsFor(providerId).filter(function (entry) {
      return lower.indexOf(String(entry.id).toLowerCase()) === 0;
    })[0];
    if (prefixMatch && prefixMatch.vision) {
      return { status: 'supported', message: prefixMatch.label + ' can read images.' };
    }

    if (TEXT_ONLY_PATTERNS.some(function (re) { return re.test(lower); })) {
      return {
        status: 'unsupported',
        message:
          'Model "' + model + '" looks text-only, so it cannot analyse a screenshot. Pick a vision-capable model.'
      };
    }
    if (VISION_PATTERNS.some(function (re) { return re.test(lower); })) {
      return { status: 'supported', message: 'Model "' + model + '" appears to support images.' };
    }
    return {
      status: 'unknown',
      message:
        'Image support for "' + model + '" is not in the built-in list. ' +
        'If it is text-only the provider will return an error.'
    };
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  /** Trim, add https:// when missing, drop a pasted /chat/completions suffix. */
  function normalizeBaseUrl(value) {
    let base = String(value || '').trim();
    if (!base) return '';
    base = base.replace(/\/+$/, '');
    base = base.replace(/\/chat\/completions$/i, '');
    base = base.replace(/\/messages$/i, '');
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    return base;
  }

  /** Split a data URL into its mime type and base64 payload. */
  function dataUrlToParts(dataUrl) {
    const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''));
    if (!match) return null;
    return {
      mimeType: match[1] || 'image/jpeg',
      base64: match[2] ? match[3] : '',
      raw: match[3]
    };
  }

  /** Pull the assistant text out of an OpenAI-style chat completion. */
  function extractChatText(data) {
    if (!data || typeof data !== 'object') return '';
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice) {
      const message = choice.message || {};
      if (typeof message.content === 'string') return message.content;
      if (Array.isArray(message.content)) {
        return message.content
          .map(function (part) {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            return typeof part.text === 'string' ? part.text : '';
          })
          .filter(Boolean)
          .join('\n');
      }
      if (typeof choice.text === 'string') return choice.text;
    }
    if (typeof data.output_text === 'string') return data.output_text;
    if (typeof data.content === 'string') return data.content;
    if (Array.isArray(data.content)) {
      return data.content
        .map(function (part) {
          return part && typeof part.text === 'string' ? part.text : '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  /**
   * Create an adapter for an OpenAI-compatible /chat/completions endpoint.
   * @param {object} config
   */
  function createChatAdapter(config) {
    const adapter = {
      id: config.id,
      label: config.label,
      docsUrl: config.docsUrl || '',
      note: config.note || '',
      defaultBaseUrl: config.defaultBaseUrl || '',
      defaultModel: config.defaultModel || '',
      models: Array.isArray(config.models) ? config.models : [],
      requiresKey: config.requiresKey !== false,
      supportsJsonMode: config.supportsJsonMode === true,

      buildRequest: function buildRequest(ctx) {
        const base = normalizeBaseUrl(ctx.baseUrl || adapter.defaultBaseUrl);
        if (!base) throw new Error('No base URL configured for ' + adapter.label + '.');

        const systemPrompt =
          ctx.systemPrompt ||
          (ACP.prompt && ACP.prompt.system) ||
          'You are a technical analyst. Answer with a single JSON object only.';

        const body = {
          model: ctx.model,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: [
                { type: 'text', text: ctx.prompt },
                { type: 'image_url', image_url: { url: ctx.dataUrl, detail: 'high' } }
              ]
            }
          ],
          temperature: typeof ctx.temperature === 'number' ? ctx.temperature : 0.2,
          max_tokens: ctx.maxTokens || 2000,
          stream: false
        };

        if (adapter.supportsJsonMode) body.response_format = { type: 'json_object' };
        if (typeof adapter.customizeBody === 'function') adapter.customizeBody(body, ctx);

        const headers = { 'Content-Type': 'application/json' };
        if (ctx.apiKey) headers.Authorization = 'Bearer ' + ctx.apiKey;
        Object.assign(
          headers,
          typeof adapter.extraHeaders === 'function' ? adapter.extraHeaders(ctx) : adapter.extraHeaders || {}
        );

        return {
          url: base + '/chat/completions',
          init: { method: 'POST', headers: headers, body: JSON.stringify(body) }
        };
      },

      parseResponse: config.parseResponse || extractChatText
    };

    if (typeof config.customizeBody === 'function') adapter.customizeBody = config.customizeBody;
    if (config.extraHeaders) adapter.extraHeaders = config.extraHeaders;

    return adapter;
  }

  ACP.providers = {
    register: register,
    list: list,
    get: get,
    modelsFor: modelsFor,
    defaultModel: defaultModel,
    visionInfo: visionInfo,
    normalizeBaseUrl: normalizeBaseUrl,
    dataUrlToParts: dataUrlToParts,
    extractChatText: extractChatText,
    createChatAdapter: createChatAdapter
  };
})(typeof self !== 'undefined' ? self : this);
