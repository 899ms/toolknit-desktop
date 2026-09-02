import { replaceImageColors } from './core.js';

self.addEventListener('message', event => {
  const { taskId, buffer, width, height, options } = event.data || {};
  try {
    const result = replaceImageColors(new Uint8ClampedArray(buffer), width, height, options);
    self.postMessage({ taskId, ok: true, buffer: result.data.buffer, changedPixels: result.changedPixels }, [result.data.buffer]);
  } catch (error) {
    self.postMessage({ taskId, ok: false, error: String(error?.message || error) });
  }
});
