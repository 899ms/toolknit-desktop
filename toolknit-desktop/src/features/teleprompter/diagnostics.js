import { LIVE_AUDIO_MIN_RMS, LIVE_AUDIO_TIMING } from './audio-window.js';

// Only the existing qa-devtools native feature sets this marker. Normal
// releases must neither collect audio diagnostics nor print spoken text.
export function createTeleprompterDiagnostics({
  windowRef = globalThis.window,
  consoleRef = globalThis.console
} = {}) {
  const enabled = () => windowRef?.[Symbol.for('toolknit.qa-devtools')] === true;
  const now = () => globalThis.performance?.now?.() ?? Date.now();

  function event(stage, details) {
    if (!enabled()) return;
    try {
      const snapshot = typeof details === 'function' ? details() : details;
      consoleRef?.info?.(`[Teleprompter][${stage}] ${JSON.stringify(snapshot)}`);
    } catch {
      // Console instrumentation must never interrupt capture or following.
    }
  }

  function capture(readState) {
    if (!enabled()) return null;
    let samples = 0;
    let blocks = 0;
    let energy = 0;
    let peak = 0;
    let signalBlocks = 0;
    let gateRms = LIVE_AUDIO_MIN_RMS;
    let noiseRms = 0;
    let closed = false;
    const timer = windowRef?.setInterval?.(() => {
      if (closed) return;
      event('audio', () => ({
        ...readState(),
        blocks, samples, receivedMs: Math.round(samples / LIVE_AUDIO_TIMING.sampleRate * 1000),
        rms: samples ? Number(Math.sqrt(energy / samples).toFixed(1)) : 0,
        peak, gateRms: Number(gateRms.toFixed(1)), noiseRms: Number(noiseRms.toFixed(1)), signalBlocks,
        signal: !blocks ? 'no-audio-callbacks' : signalBlocks ? 'above-gate' : 'below-gate'
      }));
      samples = blocks = energy = peak = signalBlocks = 0;
    }, 1000);
    return {
      accept(input, state) {
        if (closed || !enabled()) return;
        let blockEnergy = 0;
        for (const sample of input) {
          blockEnergy += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
        }
        samples += input.length;
        blocks += 1;
        energy += blockEnergy;
        gateRms = state?.gateRms ?? LIVE_AUDIO_MIN_RMS;
        noiseRms = state?.noiseRms ?? 0;
        if (state?.signal ?? (input.length && Math.sqrt(blockEnergy / input.length) >= gateRms)) signalBlocks += 1;
      },
      stop() {
        closed = true;
        windowRef?.clearInterval?.(timer);
      }
    };
  }

  return { event, capture, now };
}
