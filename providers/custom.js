/**
 * Custom OpenAI-compatible endpoint adapter.
 *
 * Works with Ollama (http://localhost:11434/v1), LM Studio, vLLM, LiteLLM,
 * Together, Fireworks, Azure OpenAI proxies, corporate gateways, etc.
 * The base URL and the model name are both user supplied. When no key is
 * configured the Authorization header is omitted, which local servers prefer.
 */
(function (global) {
  'use strict';

  const ACP = global.ACP;

  ACP.providers.register(
    ACP.providers.createChatAdapter({
      id: 'custom',
      label: 'Custom (OpenAI-compatible)',
      docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
      note: 'Point the base URL at an OpenAI-compatible /v1 endpoint. The model must accept image_url content parts.',
      defaultBaseUrl: '',
      defaultModel: '',
      requiresKey: false,
      supportsJsonMode: false,
      models: []
    })
  );
})(typeof self !== 'undefined' ? self : this);
