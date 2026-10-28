/**
 * OpenRouter adapter — https://openrouter.ai/docs
 * OpenAI-compatible API that proxies hundreds of models (use any vision model,
 * e.g. "openai/gpt-4o", "anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash-001").
 * Note: OpenRouter is not sent an API key for any other provider; it receives
 * only its own key.
 */
(function (global) {
  'use strict';

  const ACP = global.ACP;

  ACP.providers.register(
    ACP.providers.createChatAdapter({
      id: 'openrouter',
      label: 'OpenRouter',
      docsUrl: 'https://openrouter.ai/keys',
      defaultBaseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-4o',
      supportsJsonMode: false,
      models: [
        { id: 'openai/gpt-4o', label: 'OpenAI GPT-4o', vision: true },
        { id: 'openai/gpt-4o-mini', label: 'OpenAI GPT-4o mini', vision: true },
        { id: 'anthropic/claude-3.5-sonnet', label: 'Anthropic Claude 3.5 Sonnet', vision: true },
        { id: 'anthropic/claude-sonnet-4', label: 'Anthropic Claude Sonnet 4', vision: true },
        { id: 'google/gemini-2.0-flash-001', label: 'Google Gemini 2.0 Flash', vision: true },
        { id: 'google/gemini-2.5-pro', label: 'Google Gemini 2.5 Pro', vision: true },
        { id: 'x-ai/grok-2-vision-1212', label: 'xAI Grok 2 Vision', vision: true },
        { id: 'meta-llama/llama-3.2-90b-vision-instruct', label: 'Llama 3.2 90B Vision', vision: true },
        { id: 'mistralai/pixtral-large-2411', label: 'Mistral Pixtral Large', vision: true },
        { id: 'qwen/qwen2.5-vl-72b-instruct', label: 'Qwen 2.5 VL 72B', vision: true },
        { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat (text only)', vision: false }
      ],
      /** OpenRouter recommends attribution headers; they are optional. */
      extraHeaders: function extraHeaders() {
        return {
          'HTTP-Referer': 'https://github.com/roushan62/Trade-Predict',
          'X-Title': 'AI Chart Predictor'
        };
      }
    })
  );
})(typeof self !== 'undefined' ? self : this);
