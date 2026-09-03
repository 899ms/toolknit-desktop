import { AiProviderError, requestAiCompletion } from '../ai-provider-core.js';
import { tauriCorePromise } from '../platform/tauri-runtime.js';

/** Creates the shared AI request adapter used by AI tools. */
export function createAiRequestRuntime({ getApiKey, getConfig, translate = value => value } = {}) {
  return async function requestAi(messages, signal, maxTokens) {
    const apiKey = await getApiKey?.();
    if (!apiKey) throw new Error(translate('home.aiPolish.noApiKey'));
    const config = getConfig?.() || {};
    if (!config.url || !config.model) throw new Error(translate('home.aiPolish.noApiKey'));
    try {
      return await requestAiCompletion({
        url: config.url,
        apiKey,
        model: config.model,
        messages,
        maxTokens,
        signal,
        allowPrivateHttp: config.allowPrivateHttp,
        nativeRequestImpl: async request => {
          const { invoke } = await tauriCorePromise;
          return invoke('request_private_ai_completion', { request });
        }
      });
    } catch (error) {
      if (error instanceof AiProviderError) {
        const suffix = error.code === 'http_error' && error.status !== null
          ? `: ${error.status}`
          : '';
        throw new Error(`${translate('home.aiPolish.apiError')}${suffix}`);
      }
      throw error;
    }
  };
}
