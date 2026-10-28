/**
 * DeepSeek adapter — https://api-docs.deepseek.com/
 *
 * OpenAI-compatible endpoint. IMPORTANT: the public DeepSeek chat models are
 * text-only, so a chart screenshot cannot be analysed with them. The adapter is
 * still complete and will work as soon as a vision model is available; until
 * then the UI blocks requests with a clear warning.
 */
(function (global) {
  'use strict';

  const ACP = global.ACP;

  ACP.providers.register(
    ACP.providers.createChatAdapter({
      id: 'deepseek',
      label: 'DeepSeek',
      docsUrl: 'https://platform.deepseek.com/api_keys',
      note: 'DeepSeek chat models are text-only and cannot read a screenshot. Use DeepSeek through OpenRouter with a vision model instead.',
      defaultBaseUrl: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-chat',
      supportsJsonMode: true,
      models: [
        { id: 'deepseek-chat', label: 'DeepSeek Chat (text only)', vision: false },
        { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (text only)', vision: false },
        { id: 'deepseek-vl2', label: 'DeepSeek VL2 (self-hosted vision)', vision: true }
      ]
    })
  );
})(typeof self !== 'undefined' ? self : this);
