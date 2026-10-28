/**
 * Groq adapter — https://console.groq.com/docs/openai
 *
 * OpenAI-compatible endpoint. Only the Llama 4 multimodal models accept images.
 */
(function (global) {
  'use strict';

  const ACP = global.ACP;

  ACP.providers.register(
    ACP.providers.createChatAdapter({
      id: 'groq',
      label: 'Groq',
      docsUrl: 'https://console.groq.com/keys',
      defaultBaseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
      supportsJsonMode: true,
      models: [
        { id: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout (vision)', vision: true },
        { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick (vision)', vision: true },
        { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (text only)', vision: false },
        { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (text only)', vision: false }
      ]
    })
  );
})(typeof self !== 'undefined' ? self : this);
