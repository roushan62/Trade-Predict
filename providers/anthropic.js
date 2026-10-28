/**
 * Anthropic Claude adapter — https://docs.anthropic.com/en/api/messages
 *
 * Uses the Messages API with a base64 image block. The key travels in the
 * x-api-key header only. `anthropic-dangerous-direct-browser-access` is the
 * documented opt-in for CORS-friendly callers such as browser extensions.
 */
(function (global) {
  'use strict';

  const ACP = global.ACP;

  const SUPPORTED_MEDIA = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

  function buildRequest(ctx) {
    const base = ACP.providers.normalizeBaseUrl(ctx.baseUrl || 'https://api.anthropic.com/v1');
    const parts = ACP.providers.dataUrlToParts(ctx.dataUrl);
    if (!parts || !parts.base64) throw new Error('The screenshot could not be encoded for Claude.');

    const mediaType = SUPPORTED_MEDIA.indexOf(parts.mimeType) >= 0 ? parts.mimeType : 'image/jpeg';
    const systemPrompt =
      ctx.systemPrompt ||
      (ACP.prompt && ACP.prompt.system) ||
      'You are a technical analyst. Answer with a single JSON object only.';

    const body = {
      model: ctx.model,
      max_tokens: ctx.maxTokens || 4096,
      temperature: typeof ctx.temperature === 'number' ? ctx.temperature : 0.2,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: parts.base64 } },
            { type: 'text', text: ctx.prompt }
          ]
        }
      ]
    };

    return {
      url: base + '/messages',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctx.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body)
      }
    };
  }

  function parseResponse(data) {
    const blocks = data && Array.isArray(data.content) ? data.content : [];
    const text = blocks
      .map(function (block) {
        return block && block.type === 'text' && typeof block.text === 'string' ? block.text : '';
      })
      .filter(Boolean)
      .join('\n');

    if (!text && data && data.stop_reason === 'max_tokens') {
      throw new Error('Claude hit the max_tokens limit before returning JSON. Reduce the candle count and retry.');
    }
    return text;
  }

  ACP.providers.register({
    id: 'anthropic',
    label: 'Anthropic Claude',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-sonnet-latest',
    requiresKey: true,
    models: [
      { id: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet', vision: true },
      { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku', vision: true },
      { id: 'claude-3-7-sonnet-latest', label: 'Claude 3.7 Sonnet', vision: true },
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', vision: true },
      { id: 'claude-opus-4-20250514', label: 'Claude Opus 4', vision: true }
    ],
    buildRequest: buildRequest,
    parseResponse: parseResponse
  });
})(typeof self !== 'undefined' ? self : this);
