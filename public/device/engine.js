// Main-thread side of on-device transcription: decodes audio and drives the worker.
import { SAMPLE_RATE } from '../shared/chunking.js';

export { DEVICE_MODELS, modelTag } from './models.js';

// A model whose GPU run failed is run on the CPU from then on, until Chrome updates
// (a new Chrome often brings GPU driver workarounds), or the user retries the GPU.
const GPU_FAIL_PREFIX = 'playit:gpu-failed:';
const browserVersion = () => navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? navigator.userAgent;

/** Details of a GPU failure for this model on this browser version, or null. */
export function getGpuFailure(modelKey) {
  try {
    const f = JSON.parse(localStorage.getItem(GPU_FAIL_PREFIX + modelKey));
    return f?.browser === browserVersion() ? f : null;
  } catch {
    return null;
  }
}

export function clearGpuFailure(modelKey) {
  localStorage.removeItem(GPU_FAIL_PREFIX + modelKey);
}

// The whole recording is held in memory as 16 kHz floats (~230 MB per hour).
const MAX_DURATION_SEC = 3 * 60 * 60;

/** Why on-device transcription can't run here, or null if it can. */
export function deviceUnsupportedReason() {
  if (!window.isSecureContext) return 'needs the app to be opened over HTTPS or on localhost';
  if (typeof WebAssembly === 'undefined' || !window.Worker) return 'this browser lacks WebAssembly workers';
  return null;
}

export async function hasWebGPU() {
  try {
    return !!(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

/**
 * Decode any format the browser supports (MP3, WAV, M4A/AAC, OGG/Opus, FLAC, WebM…)
 * with its built-in decoder, resampled to 16 kHz mono.
 */
export async function decodeFile(file) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    let buf;
    try {
      buf = await ctx.decodeAudioData(await file.arrayBuffer());
    } catch {
      throw new Error(`This browser can't decode "${file.name}". Try MP3, WAV or M4A.`);
    }
    if (buf.duration > MAX_DURATION_SEC) {
      throw new Error(`Recording is too long (${Math.round(buf.duration / 60)} min, max ${MAX_DURATION_SEC / 3600} h).`);
    }
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i] += ch[i] / buf.numberOfChannels;
    }
    return out;
  } finally {
    ctx.close();
  }
}

/** Encode 16 kHz mono samples as a 16-bit PCM WAV file (for uploading to the server). */
export function encodeWav(samples, name) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, t) => [...t].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new File([view], name.replace(/\.[^.]+$/, '') + '.wav', { type: 'audio/wav' });
}

// One long-lived worker keeps the model in memory between files.
let worker;
let busy = false;

/** Run one job on the long-lived worker, forwarding progress updates. */
async function runJob(message, transfer, onUpdate) {
  if (busy) throw new Error('Another transcription is already running.');
  busy = true;
  try {
    worker ??= new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.type === 'update') onUpdate(data);
        else if (data.type === 'gpu-failed') {
          console.warn('WebGPU failed, falling back to CPU:', data.message, data.gpu);
          localStorage.setItem(
            GPU_FAIL_PREFIX + data.model,
            JSON.stringify({ browser: browserVersion(), message: data.message, gpu: data.gpu, at: new Date().toISOString() })
          );
        } else if (data.type === 'done') resolve(data.result);
        else if (data.type === 'error') reject(new Error(data.message));
      };
      worker.onerror = (e) => {
        // A crashed worker (often out of memory on phones) can't be reused.
        worker.terminate();
        worker = null;
        reject(new Error(e.message || 'The transcription worker crashed (the device may be out of memory).'));
      };
      worker.postMessage(message, transfer);
    });
  } finally {
    busy = false;
  }
}

/**
 * Transcribe a File on this device. With `transcript` (the user's own text), the result is
 * that text timed against the audio instead of Whisper's wording.
 * @param {(update: object) => void} onUpdate receives job-like {phase, progress, segments, duration}
 */
export async function transcribeOnDevice(file, modelKey, onUpdate, { simulateGpuError = false, transcript = null } = {}) {
  onUpdate({ phase: 'decoding' });
  const audio = await decodeFile(file);
  const options = { allowGPU: !getGpuFailure(modelKey), simulateGpuError, transcript };
  return runJob({ type: 'transcribe', audio, model: modelKey, options }, [audio.buffer], onUpdate);
}

/** Time the user's transcript using an existing Whisper result (from the server or history). */
export async function alignOnDevice(file, asr, transcript, duration, onUpdate) {
  onUpdate({ phase: 'decoding' });
  const audio = await decodeFile(file);
  return runJob({ type: 'align', audio, asr, transcript, duration: duration || audio.length / SAMPLE_RATE }, [audio.buffer], onUpdate);
}

/** Add furigana to already-timed segments (e.g. from an imported .lrc file). */
export async function furiganaOnDevice(segments, onUpdate) {
  onUpdate({ phase: 'furigana' });
  return (await runJob({ type: 'furigana', segments }, [], onUpdate)).segments;
}
