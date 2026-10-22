// On-device transcription: Whisper (Transformers.js) + furigana (kuromoji), all in the browser.
// Runs as a module worker so model inference never blocks the UI thread.
import { pipeline, env } from '../vendor/transformers/transformers.min.js';
import { splitAtSilence, rms, SAMPLE_RATE } from '../shared/chunking.js';
import { tokensToRuby } from '../shared/ruby.js';
import { DEVICE_MODELS } from './models.js';

// Below this level a chunk is treated as silence and skipped (Whisper hallucinates on silence).
const SILENCE_RMS = 0.002;

env.allowLocalModels = false;
// Serve the ONNX Runtime WASM from this site instead of a CDN so the app works offline.
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('../vendor/ort/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
  wasm: new URL('../vendor/ort/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href,
};

const post = (msg) => self.postMessage(msg);

let current = null; // { key, device, asr }

async function hasWebGPU() {
  try {
    return !!(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

async function loadModel(key) {
  if (current?.key === key) return current;
  if (current) {
    await current.asr.dispose?.();
    current = null;
  }
  const model = DEVICE_MODELS[key];
  const device = model.preferWebGPU && (await hasWebGPU()) ? 'webgpu' : 'wasm';
  const files = new Map();
  const asr = await pipeline('automatic-speech-recognition', model.id, {
    device,
    dtype: model.dtype,
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0, total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      post({ type: 'update', phase: 'loading-model', progress: total ? loaded / total : 0, device });
    },
  });
  current = { key, device, asr };
  return current;
}

let tokenizerPromise;
function loadTokenizer() {
  tokenizerPromise ??= (async () => {
    // kuromoji ships a UMD bundle; module workers can't importScripts, so evaluate it globally.
    const src = await (await fetch(new URL('../vendor/kuromoji/kuromoji.js', import.meta.url))).text();
    (0, eval)(src);
    // kuromoji joins paths with path.join, which mangles full URLs — give it an absolute path.
    const dicPath = new URL('../vendor/kuromoji-dict/', import.meta.url).pathname;
    return new Promise((resolve, reject) =>
      self.kuromoji.builder({ dicPath }).build((err, t) => (err ? reject(err) : resolve(t)))
    );
  })();
  tokenizerPromise.catch(() => (tokenizerPromise = null));
  return tokenizerPromise;
}

async function transcribe(audio, key) {
  const duration = audio.length / SAMPLE_RATE;
  post({ type: 'update', phase: 'loading-model', progress: 0 });
  const [{ asr, device }, tokenizer] = await Promise.all([loadModel(key), loadTokenizer()]);

  const chunks = splitAtSilence(audio);
  const segments = [];
  for (let i = 0; i < chunks.length; i++) {
    post({ type: 'update', phase: 'transcribing', progress: i / chunks.length, segments, duration, device });
    const { start, end } = chunks[i];
    if (rms(audio, start, end) < SILENCE_RMS) continue;

    const offset = start / SAMPLE_RATE;
    const chunkDur = (end - start) / SAMPLE_RATE;
    const out = await asr(audio.subarray(start, end), {
      language: 'japanese',
      task: 'transcribe',
      return_timestamps: true,
    });
    for (const c of out.chunks ?? [{ timestamp: [0, chunkDur], text: out.text }]) {
      const text = c.text.trim();
      if (!text) continue;
      const [s, e] = c.timestamp;
      segments.push({
        start: offset + Math.min(s ?? 0, chunkDur),
        end: offset + Math.min(e ?? chunkDur, chunkDur),
        text,
      });
    }
  }

  post({ type: 'update', phase: 'furigana', progress: 1, segments, duration, device });
  for (const seg of segments) seg.ruby = tokensToRuby(tokenizer.tokenize(seg.text));
  return { segments, duration, text: segments.map((s) => s.text).join(''), device };
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'transcribe') return;
  try {
    post({ type: 'done', result: await transcribe(data.audio, data.model) });
  } catch (e) {
    post({ type: 'error', message: e?.message || String(e) });
  }
};
