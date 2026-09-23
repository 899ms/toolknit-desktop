import { generateRsaKeyPair, generateSm2KeyPair, runCryptoOperation } from '../../crypto-tool-core.js';

self.addEventListener('message', async event => {
  const { taskId, type = 'run', payload = {} } = event.data || {};
  try {
    const result = type === 'generate-rsa' ? await generateRsaKeyPair(payload.size, payload.scheme)
      : type === 'generate-sm2' ? generateSm2KeyPair()
      : await runCryptoOperation(payload);
    self.postMessage({ taskId, ok: true, result });
  } catch (error) {
    self.postMessage({ taskId, ok: false, error: String(error?.message || error) });
  }
});
