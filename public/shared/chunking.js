// Shared by the Node server (lib/audio.js) and the in-browser engine (public/device/worker.js).

export const SAMPLE_RATE = 16000; // Whisper expects 16 kHz mono

/**
 * Split audio into chunks no longer than `maxSec`, cutting at the quietest
 * point between `minSec` and `maxSec` so words aren't sliced in half.
 */
export function splitAtSilence(audio, { minSec = 18, maxSec = 28, sampleRate = SAMPLE_RATE } = {}) {
  const win = Math.floor(sampleRate * 0.1); // 100 ms energy windows
  const chunks = [];
  let start = 0;
  while (start < audio.length) {
    const remaining = audio.length - start;
    if (remaining <= maxSec * sampleRate) {
      chunks.push({ start, end: audio.length });
      break;
    }
    let best = start + maxSec * sampleRate;
    let bestEnergy = Infinity;
    for (let p = start + minSec * sampleRate; p + win <= start + maxSec * sampleRate; p += win) {
      let e = 0;
      for (let k = p; k < p + win; k++) e += audio[k] * audio[k];
      if (e < bestEnergy) {
        bestEnergy = e;
        best = p + (win >> 1);
      }
    }
    chunks.push({ start, end: best });
    start = best;
  }
  return chunks;
}

export function rms(audio, start = 0, end = audio.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += audio[i] * audio[i];
  return Math.sqrt(s / Math.max(1, end - start));
}
