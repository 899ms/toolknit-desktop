import { AiProviderError, requestAiCompletion } from '../ai-provider-core.js';
import { tauriCorePromise } from '../platform/tauri-runtime.js';

/** Creates the shared AI request adapter used by AI tools. */
export function createAiRequestRuntime({ getApiKey, getConfig, translate = value => value, isTauri = false } = {}) {
  return async function requestAi(messages, signal, maxTokens, options = {}) {
    const apiKey = await getApiKey?.();
    if (!apiKey) throw new Error(translate('home.aiPolish.noApiKey'));
    const config = getConfig?.() || {};
    if (!config.url || !config.model) throw new Error(translate('home.aiPolish.noApiKey'));
    if (options.expectedProvider && ['url', 'model', 'allowPrivateHttp'].some(key => (config[key] || '') !== (options.expectedProvider[key] || ''))) {
      throw new AiProviderError('provider_changed');
    }
    try {
      return await requestAiCompletion({
        url: config.url,
        apiKey,
        model: config.model,
        messages,
        maxTokens,
        timeoutMs: options.timeoutMs,
        reasoningEffort: options.reasoningEffort,
        diagnostics: options.diagnostics === true && (isTauri || Boolean(import.meta.env?.DEV)),
        signal,
        allowPrivateHttp: config.allowPrivateHttp,
        nativeRequestImpl: isTauri
          ? async request => {
              const { invoke } = await tauriCorePromise;
              if (signal?.aborted) throw new AiProviderError('aborted');
              const requestId = globalThis.crypto.randomUUID();
              const abort = () => { void invoke('cancel_private_ai_completion', { requestId }).catch(() => {}); };
              signal?.addEventListener('abort', abort, { once: true });
              try {
                return await invoke('request_private_ai_completion', { request: { ...request, requestId } });
              } finally { signal?.removeEventListener('abort', abort); }
            }
          : undefined
      });
    } catch (error) {
      if (error instanceof AiProviderError) {
        const suffix = error.code === 'http_error' && error.status !== null
          ? `: ${error.status}`
          : '';
        const key = {
          timeout: 'home.aiRequestErrors.timeout',
          response_truncated: 'home.aiRequestErrors.truncated',
          empty_response: 'home.aiRequestErrors.empty',
          invalid_request: 'home.aiRequestErrors.invalidRequest',
          invalid_response: 'home.aiRequestErrors.invalidResponse',
          response_too_large: 'home.aiRequestErrors.tooLarge'
        }[error.code] || 'home.aiPolish.apiError';
        throw new AiProviderError(error.code, error.status, `${translate(key)}${suffix}`, error.diagnostics);
      }
      throw error;
    }
  };
}
