import { AiProviderError, normalizeAiProviderConfig } from '../ai-provider-core.js';
import { createLifecycleScope } from './tool-lifecycle.js';

const AI_PLATFORMS = Object.freeze({
  deepseek: Object.freeze({ url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', label: 'DeepSeek' }),
  openai: Object.freeze({ url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', label: 'OpenAI' }),
  qwen: Object.freeze({ url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', label: 'Qwen' }),
  moonshot: Object.freeze({ url: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k', label: 'Moonshot' }),
  custom: Object.freeze({ url: '', model: '', label: 'Custom' })
});

const AI_PLATFORM_KEY = 'ai_platform';
const AI_CUSTOM_URL_KEY = 'ai_custom_url';
const AI_CUSTOM_MODEL_KEY = 'ai_custom_model';
const AI_PRIVATE_HTTP_KEY = 'ai_custom_allow_private_http';

/** Owns the AI provider form, protected key gate and provider configuration. */
export function createAiSettingsRuntime({
  root = globalThis.document,
  storage = globalThis.localStorage,
  aiKeyStore,
  aiApiKeyReady = Promise.resolve(),
  translate = key => key,
  onOpenSettings = () => {},
  onError = error => console.error('AI settings error:', error)
} = {}) {
  const scope = createLifecycleScope({ onError });
  const bindEvent = (target, type, listener, options) => target?.addEventListener
    ? scope.event(target, type, listener, options)
    : () => {};
  const byId = id => root?.getElementById?.(id) || null;
  const btnApiKey = byId('settingsApiKey');
  const apiKeyOverlay = byId('apiKeyOverlay');
  const apiKeyBack = byId('apiKeyBack');
  const apiKeyInput = byId('apiKeyInput');
  const apiKeyToggle = byId('apiKeyToggle');
  const apiKeySave = byId('apiKeySave');
  const apiKeyClear = byId('apiKeyClear');
  const apiKeyStatus = byId('apiKeyStatus');
  const apiKeyDropdown = byId('apiKeyDropdown');
  const apiKeyDropdownTrigger = byId('apiKeyDropdownTrigger');
  const apiKeyDropdownMenu = byId('apiKeyDropdownMenu');
  const apiKeyDropdownValue = byId('apiKeyDropdownValue');
  const apiKeyCustomWrap = byId('apiKeyCustomWrap');
  const apiKeyCustomUrl = byId('apiKeyCustomUrl');
  const apiKeyCustomModel = byId('apiKeyCustomModel');
  const apiKeyPrivateHttpSwitch = byId('apiKeyPrivateHttpSwitch');
  const aiKeyRequiredOverlay = byId('aiKeyRequiredOverlay');
  const aiKeyRequiredCancel = byId('aiKeyRequiredCancel');
  const aiKeyRequiredGoSettings = byId('aiKeyRequiredGoSettings');
  let apiKeyPlatformValue = 'deepseek';

  const read = (key, fallback = '') => {
    try { return storage?.getItem(key) ?? fallback; } catch { return fallback; }
  };
  const write = (key, value) => {
    try { storage?.setItem(key, value); } catch (error) { onError(error); }
  };
  const remove = key => {
    try { storage?.removeItem(key); } catch (error) { onError(error); }
  };

  const getAiPlatformConfig = () => {
    const platform = read(AI_PLATFORM_KEY, 'deepseek');
    const base = AI_PLATFORMS[platform] || AI_PLATFORMS.deepseek;
    if (platform === 'custom') {
      return {
        url: read(AI_CUSTOM_URL_KEY),
        model: read(AI_CUSTOM_MODEL_KEY),
        allowPrivateHttp: read(AI_PRIVATE_HTTP_KEY) === 'true'
      };
    }
    return { url: base.url, model: base.model, allowPrivateHttp: false };
  };

  const hasAiApiKey = () => Boolean(aiKeyStore?.hasKey?.());

  const setApiKeyPlatform = value => {
    apiKeyPlatformValue = AI_PLATFORMS[value] ? value : 'deepseek';
    apiKeyDropdownMenu?.querySelectorAll('.api-key-dropdown-item').forEach(item => {
      const active = item.dataset.value === apiKeyPlatformValue;
      item.classList.toggle('active', active);
      if (active && apiKeyDropdownValue) apiKeyDropdownValue.textContent = item.textContent;
    });
    if (apiKeyCustomWrap) apiKeyCustomWrap.style.display = apiKeyPlatformValue === 'custom' ? '' : 'none';
  };

  const setPrivateHttpPermission = enabled => {
    if (!apiKeyPrivateHttpSwitch) return;
    apiKeyPrivateHttpSwitch.classList.toggle('active', Boolean(enabled));
    apiKeyPrivateHttpSwitch.setAttribute('aria-checked', enabled ? 'true' : 'false');
  };

  const openApiKeySettings = async event => {
    event?.stopPropagation?.();
    if (!apiKeyOverlay) return;
    onOpenSettings();
    const savedPlatform = read(AI_PLATFORM_KEY, 'deepseek');
    const savedKey = await aiKeyStore?.get?.() || '';
    setApiKeyPlatform(savedPlatform);
    if (apiKeyInput) apiKeyInput.value = savedKey;
    if (apiKeyCustomUrl) apiKeyCustomUrl.value = read(AI_CUSTOM_URL_KEY);
    if (apiKeyCustomModel) apiKeyCustomModel.value = read(AI_CUSTOM_MODEL_KEY);
    setPrivateHttpPermission(read(AI_PRIVATE_HTTP_KEY) === 'true');
    apiKeyStatus?.classList.remove('show', 'success', 'error');
    apiKeyOverlay.classList.add('visible');
    apiKeyOverlay.setAttribute('aria-hidden', 'false');
    apiKeyInput?.focus();
  };

  const closeApiKeySettings = () => {
    apiKeyOverlay?.classList.remove('visible');
    apiKeyOverlay?.setAttribute('aria-hidden', 'true');
  };

  const setStatus = (message, kind) => {
    if (!apiKeyStatus) return;
    apiKeyStatus.textContent = message;
    apiKeyStatus.className = `api-key-status show ${kind}`;
  };

  bindEvent(apiKeyPrivateHttpSwitch, 'click', () => {
    setPrivateHttpPermission(apiKeyPrivateHttpSwitch.getAttribute('aria-checked') !== 'true');
  });
  bindEvent(apiKeyDropdownTrigger, 'click', event => {
    event.stopPropagation();
    apiKeyDropdown?.classList.toggle('open');
  });
  bindEvent(root, 'click', event => {
    if (apiKeyDropdown && !apiKeyDropdown.contains(event.target)) apiKeyDropdown.classList.remove('open');
  });
  apiKeyDropdownMenu?.querySelectorAll('.api-key-dropdown-item').forEach(item => {
      bindEvent(item, 'click', () => {
      setApiKeyPlatform(item.dataset.value);
      apiKeyDropdown?.classList.remove('open');
    });
  });
  bindEvent(btnApiKey, 'click', openApiKeySettings);
  bindEvent(apiKeyBack, 'click', closeApiKeySettings);
  bindEvent(apiKeyToggle, 'click', () => {
    if (apiKeyInput) apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  });
  bindEvent(apiKeySave, 'click', async () => {
    const key = apiKeyInput?.value.trim() || '';
    if (!key) { setStatus(translate('apiKey.errEmpty'), 'error'); return; }
    const platform = apiKeyPlatformValue;
    let customUrl = '';
    let customModel = '';
    if (platform === 'custom') {
      customUrl = apiKeyCustomUrl?.value.trim() || '';
      customModel = apiKeyCustomModel?.value.trim() || '';
      if (!customUrl || !customModel) { setStatus(translate('apiKey.errCustom'), 'error'); return; }
      try {
        const normalized = normalizeAiProviderConfig({
          url: customUrl,
          model: customModel,
          allowPrivateHttp: apiKeyPrivateHttpSwitch?.getAttribute('aria-checked') === 'true'
        });
        customUrl = normalized.url;
        customModel = normalized.model;
      } catch (error) {
        const errorKey = error instanceof AiProviderError && error.code === 'private_http_requires_opt_in'
          ? 'apiKey.errPrivateHttp'
          : error instanceof AiProviderError && error.code === 'insecure_http_not_allowed'
            ? 'apiKey.errInsecureHttp'
            : 'apiKey.errInvalidUrl';
        setStatus(translate(errorKey), 'error');
        return;
      }
    }
    if (!apiKeySave) return;
    apiKeySave.disabled = true;
    try {
      await aiKeyStore?.set?.(key);
      write(AI_PLATFORM_KEY, platform);
      if (platform === 'custom') {
        write(AI_CUSTOM_URL_KEY, customUrl);
        write(AI_CUSTOM_MODEL_KEY, customModel);
        write(AI_PRIVATE_HTTP_KEY, apiKeyPrivateHttpSwitch?.getAttribute('aria-checked') === 'true' ? 'true' : 'false');
      }
      setStatus(translate('apiKey.saved'), 'success');
      root?.dispatchEvent?.(new Event('toolknit:ai-key-change'));
      window.setTimeout(closeApiKeySettings, 800);
    } catch (error) {
      onError(error);
      setStatus(translate('apiKey.errStorage'), 'error');
    } finally {
      apiKeySave.disabled = false;
    }
  });
  bindEvent(apiKeyClear, 'click', async () => {
    if (!apiKeyClear) return;
    apiKeyClear.disabled = true;
    try {
      await aiKeyStore?.remove?.();
      if (apiKeyInput) apiKeyInput.value = '';
      [AI_PLATFORM_KEY, AI_CUSTOM_URL_KEY, AI_CUSTOM_MODEL_KEY, AI_PRIVATE_HTTP_KEY].forEach(remove);
      setPrivateHttpPermission(false);
      setStatus(translate('apiKey.cleared'), 'success');
      root?.dispatchEvent?.(new Event('toolknit:ai-key-change'));
      window.setTimeout(closeApiKeySettings, 800);
    } catch (error) {
      onError(error);
      setStatus(translate('apiKey.errStorage'), 'error');
    } finally {
      apiKeyClear.disabled = false;
    }
  });

  const hideAiKeyRequiredOverlay = () => {
    aiKeyRequiredOverlay?.classList.remove('visible');
    aiKeyRequiredOverlay?.setAttribute('aria-hidden', 'true');
  };
  const showAiKeyRequiredOverlay = () => {
    if (!aiKeyRequiredOverlay) return false;
    aiKeyRequiredOverlay.classList.add('visible');
    aiKeyRequiredOverlay.setAttribute('aria-hidden', 'false');
    return true;
  };
  bindEvent(aiKeyRequiredCancel, 'click', hideAiKeyRequiredOverlay);
  bindEvent(aiKeyRequiredGoSettings, 'click', () => {
    hideAiKeyRequiredOverlay();
    void openApiKeySettings();
  });

  const openToolWithAiCheck = async openFn => {
    await aiApiKeyReady;
    if (!hasAiApiKey()) {
      showAiKeyRequiredOverlay();
      return false;
    }
    await openFn?.();
    return true;
  };

  return Object.freeze({
    aiApiKeyReady,
    dispose: scope.dispose,
    getAiPlatformConfig,
    hasAiApiKey,
    hideAiKeyRequiredOverlay,
    openApiKeySettings,
    openToolWithAiCheck,
    setApiKeyPlatform,
    showAiKeyRequiredOverlay
  });
}
