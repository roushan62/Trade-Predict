/**
 * OpenAI (ChatGPT) adapter — https://platform.openai.com/docs/api-reference/chat
 * Request: OpenAI chat completions with an image_url content part.
 */
(function (global) {
  'use strict';

  const ACP = global.ACP;

  ACP.providers.register(
    ACP.providers.createChatAdapter({
      id: 'openai',
      label: 'OpenAI (ChatGPT)',
      docsUrl: 'https://platform.openai.com/api-keys',
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
      supportsJsonMode: true,
      models: [
        { id: 'gpt-4o', label: 'GPT-4o', vision: true },
        { id: 'gpt-4o-mini', label: 'GPT-4o mini', vision: true },
        { id: 'gpt-4.1', label: 'GPT-4.1', vision: true },
        { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', vision: true },
        { id: 'gpt-5', label: 'GPT-5 (reasoning)', vision: true },
        { id: 'o4-mini', label: 'o4-mini (reasoning)', vision: true },
        { id: 'o3', label: 'o3 (reasoning)', vision: true },
        { id: 'o1', label: 'o1 (reasoning)', vision: true },
        { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (text only)', vision: false }
      ],
      /**
       * Reasoning models reject `max_tokens` and custom temperatures, so the
       * body has to be adjusted per model family.
       */
      customizeBody: function customizeBody(body, ctx) {
        const model = String(ctx.model || '');
        const isOSeries = /^o\d/i.test(model);
        const isGpt5 = /^gpt-5/i.test(model);

        if (isOSeries || isGpt5) {
          delete body.max_tokens;
          body.max_completion_tokens = ctx.maxTokens || 4000;
          delete body.temperature;
        }
        if (isOSeries) {
          // json_object mode is not available on every o-series snapshot.
          delete body.response_format;
        }
      }
    })
  );
})(typeof self !== 'undefined' ? self : this);
