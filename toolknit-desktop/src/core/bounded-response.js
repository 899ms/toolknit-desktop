export class ResponseSizeLimitError extends Error {
  constructor() {
    super('response-too-large');
    this.name = 'ResponseSizeLimitError';
  }
}
function assertWithinLimit(byteLength, maxBytes) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maxBytes) {
    throw new ResponseSizeLimitError();
  }
}

export async function readResponseTextLimited(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');

  const declaredLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength >= 0) assertWithinLimit(declaredLength, maxBytes);

  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    assertWithinLimit(new TextEncoder().encode(text).byteLength, maxBytes);
    return text;
  }

  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkLength = value?.byteLength;
      assertWithinLimit(chunkLength, maxBytes);
      const nextReceived = received + chunkLength;
      if (!Number.isSafeInteger(nextReceived) || nextReceived > maxBytes) {
        throw new ResponseSizeLimitError();
      }
      received = nextReceived;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof ResponseSizeLimitError) {
      try { await reader.cancel(); } catch {}
    }
    throw error;
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
}
