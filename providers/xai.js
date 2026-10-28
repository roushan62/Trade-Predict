/**
 * xAI Grok adapter — https://docs.x.ai/docs/api-reference
 *
 * OpenAI-compatible endpoint. Grok 2 Vision and Grok 3+ accept images.
 */
(function (global) {
  'use strict';

  const ACP = global.ACP;

  ACP.providers.register(
    ACP.providers.createChatAdapter({
      id: 'xai',
      label: 'xAI Grok',
      docsUrl: 'https://console.x.ai/',
      defaultBaseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-2-vision-1212',
      supportsJsonMode: true,
      models: [
        { id: 'grok-2-vision-1212', label: 'Grok 2 Vision', vision: true },
        { id: 'grok-3', label: 'Grok 3', vision: true },
        { id: 'grok-4', label: 'Grok 4', vision: true },
        { id: 'grok-3-mini', label: 'Grok 3 mini (text only)', vision: false }
      ]
    })
  );
})(typeof self !== 'undefined' ? self : this);
