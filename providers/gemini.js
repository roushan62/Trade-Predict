/**
 * Google Gemini adapter — https://ai.google.dev/api/generate-content
 *
 * Uses generateContent with an inline_data image part and JSON response mode.
 * The key is sent in the x-goog-api-key header (never in the URL, so it does
 * not end up in logs or history).
 */
(function (global) {
  'use strict';

  const ACP = global.ACP;

  function buildRequest(ctx) {
    const base = ACP.providers.normalizeBaseUrl(ctx.baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
    const parts = ACP.providers.dataUrlToParts(ctx.dataUrl);
    if (!parts || !parts.base64) throw new Error('The screenshot could not be encoded for Gemini.');

    const systemPrompt =
      ctx.systemPrompt ||
      (ACP.prompt && ACP.prompt.system) ||
      'You are a technical analyst. Answer with a single JSON object only.';

    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: parts.mimeType, data: parts.base64 } },
            { text: ctx.prompt }
          ]
        }
      ],
      generationConfig: {
        temperature: typeof ctx.temperature === 'number' ? ctx.temperature : 0.2,
        maxOutputTokens: ctx.maxTokens || 8192,
        responseMimeType: 'application/json'
      },
      safetySettings: []
    };

    return {
      url: base + '/models/' + encodeURIComponent(ctx.model) + ':generateContent',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': ctx.apiKey
        },
        body: JSON.stringify(body)
      }
    };
  }

  function parseResponse(data) {
    const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
    if (!candidate) {
      const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
      if (blocked) throw new Error('Gemini blocked the request (' + blocked + ').');
      return '';
    }

    const content = candidate.content || {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const text = parts
      .map(function (part) {
        return part && typeof part.text === 'string' ? part.text : '';
      })
      .filter(Boolean)
      .join('\n');

    if (!text) {
      if (candidate.finishReason === 'MAX_TOKENS') {
        throw new Error('Gemini stopped at the output token limit before returning JSON. Try a shorter candle count.');
      }
      if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
        throw new Error('Gemini refused to analyse the screenshot (' + candidate.finishReason + ').');
      }
    }
    return text;
  }

  ACP.providers.register({
    id: 'gemini',
    label: 'Google Gemini',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    note: 'Free-tier keys have a per-minute quota; use Live Mode at 1 minute or slower on the free tier.',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    requiresKey: true,
    models: [
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', vision: true },
      { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite', vision: true },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', vision: true },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', vision: true },
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', vision: true },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', vision: true }
    ],
    buildRequest: buildRequest,
    parseResponse: parseResponse
  });
})(typeof self !== 'undefined' ? self : this);
