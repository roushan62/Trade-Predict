/**
 * Mistral AI adapter — https://docs.mistral.ai/
 *
 * OpenAI-compatible endpoint. Vision is available through the Pixtral family.
 */
(function (global) {
  'use strict';

  const ACP = global.ACP;

  ACP.providers.register(
    ACP.providers.createChatAdapter({
      id: 'mistral',
      label: 'Mistral',
      docsUrl: 'https://console.mistral.ai/api-keys',
      defaultBaseUrl: 'https://api.mistral.ai/v1',
      defaultModel: 'pixtral-large-latest',
      supportsJsonMode: true,
      models: [
        { id: 'pixtral-large-latest', label: 'Pixtral Large', vision: true },
        { id: 'pixtral-12b-2409', label: 'Pixtral 12B', vision: true },
        { id: 'mistral-large-latest', label: 'Mistral Large (text only)', vision: false },
        { id: 'mistral-small-latest', label: 'Mistral Small (text only)', vision: false }
      ]
    })
  );
})(typeof self !== 'undefined' ? self : this);
