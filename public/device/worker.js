// On-device transcription: Whisper (Transformers.js) + furigana (kuromoji), all in the browser.
// Runs as a module worker so model inference never blocks the UI thread.
import { pipeline, env } from '../vendor/transformers/transformers.min.js';
import { splitAtSilence, rms, SAMPLE_RATE } from '../shared/chunking.js';
import { tokensToRuby } from '../shared/ruby.js';
import { alignTranscript, splitSentences, snapToSpeech } from '../shared/align.js';
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

let current = null; // { key, mode, device, asr }

async function getAdapter() {
  try {
    return await navigator.gpu?.requestAdapter();
  } catch {
    return null;
  }
}

/** GPU details sent along with a WebGPU failure, to help diagnose driver-specific bugs. */
async function gpuInfo() {
  const a = await getAdapter();
  if (!a) return null;
  const { vendor, architecture, device, description, subgroupMinSize, subgroupMaxSize } = a.info ?? {};
  const l = a.limits;
  return {
    vendor, architecture, device, description, subgroupMinSize, subgroupMaxSize,
    features: ['shader-f16', 'subgroups'].filter((f) => a.features.has(f)),
    maxComputeWorkgroupStorageSize: l.maxComputeWorkgroupStorageSize,
    maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup,
    maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
    maxBufferSize: l.maxBufferSize,
  };
}

// GPU "compatibility mode": a WebGPU device with every feature and limit of the adapter
// except subgroups. ONNX Runtime's 4-bit MatMul kernel (MatMulNBitsWideTile) then uses its
// plain reduction instead of subgroupShuffle, which Qualcomm Adreno drivers fail to compile
// ("No cached or pending pipeline for deferred dispatch").
let compatDevice = null;
async function getCompatDevice() {
  if (compatDevice) return compatDevice;
  const adapter = await getAdapter();
  const requiredFeatures = [...adapter.features].filter((f) => !f.includes('subgroup'));
  const requiredLimits = {};
  for (const name in adapter.limits) {
    if (!name.toLowerCase().includes('subgroup') && typeof adapter.limits[name] === 'number') {
      requiredLimits[name] = adapter.limits[name];
    }
  }
  const device = await adapter.requestDevice({ requiredFeatures, requiredLimits });
  device.lost.then(() => {
    if (compatDevice === device) compatDevice = null;
  });
  return (compatDevice = device);
}

/** Qualcomm GPUs start straight in compatibility mode (see getCompatDevice). */
async function preferCompatMode() {
  return (await getAdapter())?.info?.vendor === 'qualcomm';
}

const NEXT_MODE = { webgpu: 'webgpu-compat', 'webgpu-compat': 'wasm' };

async function loadModel(key, mode) {
  const model = DEVICE_MODELS[key];
  if (mode !== 'wasm' && !(model.preferWebGPU && (await getAdapter()))) mode = 'wasm';
  if (current?.key === key && current.mode === mode) return current;
  if (current) {
    try {
      await current.asr.dispose?.();
    } catch {
      /* a failed GPU session may not dispose cleanly; it's dropped either way */
    }
    current = null;
  }
  const device = mode === 'wasm' ? 'wasm' : 'webgpu';
  const files = new Map();
  try {
    const asr = await pipeline('automatic-speech-recognition', model.id, {
      device,
      dtype: model.dtype,
      // Transformers.js only fills in executionProviders when none are given.
      ...(mode === 'webgpu-compat' && { session_options: { executionProviders: [{ name: 'webgpu', device: await getCompatDevice() }] } }),
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
    current = { key, mode, device, asr };
    return current;
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { mode });
  }
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

/**
 * Time the user's own transcript using Whisper's segments, then tighten each sentence to
 * where speech actually starts/ends in the audio. Returns furigana-ready segments.
 */
async function alignToTranscript(asrSegments, transcript, audio, duration) {
  const sentences = splitSentences(transcript);
  if (!sentences.length) throw new Error('The transcript file has no sentences.');
  const tokenizer = await loadTokenizer();
  const tokenize = (t) => tokenizer.tokenize(t);
  const { segments, matched } = alignTranscript(asrSegments, sentences, tokenize, duration);
  const timed = audio ? snapToSpeech(segments, audio, SAMPLE_RATE) : segments;
  for (const seg of timed) seg.ruby = tokensToRuby(tokenize(seg.text));
  // Keep Whisper's own segments so the transcript can be re-aligned later without re-transcribing.
  const asr = asrSegments.map(({ start, end, text }) => ({ start, end, text }));
  return { segments: timed, asr, aligned: true, matched, duration, text: sentences.join('\n') };
}

async function transcribe(audio, key, { allowGPU = true, gpuCompat = false, simulateGpuError = '', transcript = null } = {}) {
  const duration = audio.length / SAMPLE_RATE;
  let notice = '';
  const update = (u) => post({ type: 'update', duration, notice, ...u });

  // GPU failures step down: GPU → GPU in compatibility mode → CPU (same, already cached model).
  const stepDown = async (e, failedMode) => {
    const next = NEXT_MODE[failedMode];
    post({ type: 'gpu-failed', model: key, mode: failedMode, message: e?.message || String(e), gpu: await gpuInfo() });
    notice = next === 'wasm' ? 'The GPU failed on this phone, continuing on the CPU (slower)' : 'Retrying on the GPU in compatibility mode';
    update({ phase: 'loading-model', progress: 1, device: next === 'wasm' ? 'wasm' : 'webgpu' });
    return next;
  };
  const load = async (mode) => {
    for (;;) {
      try {
        return await loadModel(key, mode);
      } catch (e) {
        if (e.mode === 'wasm') throw e;
        mode = await stepDown(e, e.mode);
      }
    }
  };

  update({ phase: 'loading-model', progress: 0 });
  const tokenizerP = loadTokenizer();
  const firstMode = !allowGPU ? 'wasm' : gpuCompat || (await preferCompatMode()) ? 'webgpu-compat' : 'webgpu';
  let state = await load(firstMode);
  const tokenizer = await tokenizerP;

  // ?simulate-gpu-error fails the subgroup GPU mode (like Adreno); =all fails both GPU modes.
  const run = async (chunk) => {
    if (state.mode === 'webgpu' && simulateGpuError) throw new Error('Simulated WebGPU failure');
    if (state.mode === 'webgpu-compat' && simulateGpuError === 'all') throw new Error('Simulated WebGPU failure (compatibility mode)');
    return state.asr(chunk, { language: 'japanese', task: 'transcribe', return_timestamps: true });
  };
  const runChunk = async (chunk) => {
    for (;;) {
      try {
        return await run(chunk);
      } catch (e) {
        if (state.mode === 'wasm') throw e;
        state = await load(await stepDown(e, state.mode));
      }
    }
  };

  const chunks = splitAtSilence(audio);
  const segments = [];
  for (let i = 0; i < chunks.length; i++) {
    update({ phase: 'transcribing', progress: i / chunks.length, segments, device: state.device });
    const { start, end } = chunks[i];
    if (rms(audio, start, end) < SILENCE_RMS) continue;

    const offset = start / SAMPLE_RATE;
    const chunkDur = (end - start) / SAMPLE_RATE;
    const chunk = audio.subarray(start, end);
    const out = await runChunk(chunk);
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

  if (transcript) {
    update({ phase: 'aligning', progress: 1, segments, device: state.device });
    return { ...(await alignToTranscript(segments, transcript, audio, duration)), device: state.device };
  }

  update({ phase: 'furigana', progress: 1, segments, device: state.device });
  for (const seg of segments) seg.ruby = tokensToRuby(tokenizer.tokenize(seg.text));
  return { segments, duration, text: segments.map((s) => s.text).join(''), device: state.device };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'transcribe') post({ type: 'done', result: await transcribe(data.audio, data.model, data.options) });
    else if (data.type === 'furigana') {
      // Timed lines from an imported .lrc file: only the furigana are needed.
      const tokenizer = await loadTokenizer();
      for (const seg of data.segments) seg.ruby = tokensToRuby(tokenizer.tokenize(seg.text));
      post({ type: 'done', result: { segments: data.segments } });
    } else if (data.type === 'align') {
      post({ type: 'update', phase: 'aligning', progress: null });
      post({ type: 'done', result: await alignToTranscript(data.asr, data.transcript, data.audio, data.duration) });
    }
  } catch (e) {
    post({ type: 'error', message: e?.message || String(e) });
  }
};
