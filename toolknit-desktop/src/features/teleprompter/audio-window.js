export const LIVE_AUDIO_TIMING = Object.freeze({
  sampleRate: 16_000,
  windowSeconds: 3.2,
  firstWindowSeconds: 0.9,
  hopSeconds: 0.45,
  tailSeconds: 0.3,
  utteranceGapSeconds: 0.85,
  prerollSeconds: 0.25
});

export const LIVE_AUDIO_MIN_RMS = 12;

function normalizeWindow(samples) {
  let energy = 0;
  let peak = 0;
  for (const sample of samples) {
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(energy / Math.max(1, samples.length));
  // One gain per decode, bounded by both amplification and peak headroom.
  const gain = rms ? Math.max(1, Math.min(64, 1200 / rms, 28000 / Math.max(1, peak))) : 1;
  if (gain > 1) {
    for (let index = 0; index < samples.length; index += 1) samples[index] = Math.round(samples[index] * gain);
  }
  return { inputRms: rms, gain };
}

// One bounded ring, not a queue: a slow decoder always resumes at live audio.
export function createLiveAudioWindow() {
  const rate = LIVE_AUDIO_TIMING.sampleRate;
  const buffer = new Int16Array(Math.round(rate * LIVE_AUDIO_TIMING.windowSeconds));
  let total = 0;
  let decodedEnd = 0;
  let voicedEnd = 0;
  let utterance = 0;
  let utteranceStart = 0;
  let decodedVoiceEnd = 0;
  let noiseRms = 4;
  let gateRms = LIVE_AUDIO_MIN_RMS;
  let signal = false;
  let activeSamples = 0;

  return {
    state() { return { gateRms, noiseRms, signal }; },
    append(samples) {
      let energy = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        buffer[(total + index) % buffer.length] = sample;
        energy += sample * sample;
      }
      const rms = samples.length ? Math.sqrt(energy / samples.length) : 0;
      gateRms = Math.max(LIVE_AUDIO_MIN_RMS, noiseRms * 2.5);
      signal = samples.length > 0 && rms >= gateRms;
      // Only learn from quiet blocks, so a sustained sentence cannot raise its
      // own gate. This rejects low background energy, not non-speech sounds.
      if (samples.length && !signal) {
        const weight = 1 - Math.exp(-samples.length / rate / 1.5);
        noiseRms += (rms - noiseRms) * weight;
      }
      if (signal) {
        if (!voicedEnd || total - voicedEnd >= rate * LIVE_AUDIO_TIMING.utteranceGapSeconds) {
          utterance += 1;
          utteranceStart = total;
          activeSamples = 0;
        }
        activeSamples += samples.length;
        voicedEnd = total + samples.length;
      }
      total += samples.length;
    },
    take() {
      const preroll = Math.round(rate * LIVE_AUDIO_TIMING.prerollSeconds);
      const available = total - Math.max(0, utteranceStart - preroll);
      if (!voicedEnd || activeSamples < rate * 0.08 || available < rate * LIVE_AUDIO_TIMING.firstWindowSeconds
        || total - decodedEnd < rate * LIVE_AUDIO_TIMING.hopSeconds) return null;
      const tail = rate * LIVE_AUDIO_TIMING.tailSeconds;
      const needsTail = decodedEnd - voicedEnd < tail && total - voicedEnd >= tail;
      if (voicedEnd <= decodedVoiceEnd && !needsTail) return null;
      // Do not let a stale speech segment trigger an all-silence decode.
      const start = Math.max(0, total - buffer.length, utteranceStart - preroll);
      if (voicedEnd <= start) return null;
      const samples = new Array(total - start);
      for (let index = start; index < total; index += 1) samples[index - start] = buffer[index % buffer.length];
      decodedEnd = total;
      decodedVoiceEnd = voicedEnd;
      const levels = normalizeWindow(samples);
      return { samples, windowStart: start, windowEnd: total, utterance, ...levels };
    }
  };
}
