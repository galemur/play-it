// Fully offline transcription with Whisper running in Node via Transformers.js (ONNX Runtime).
import os from 'node:os';
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';
import { decodeToMono16k, splitAtSilence, rms, SAMPLE_RATE } from '../lib/audio.js';

const MODEL = process.env.LOCAL_MODEL || 'onnx-community/whisper-large-v3-turbo';
const ENCODER_DTYPE = process.env.LOCAL_ENCODER_DTYPE || 'q8';
const DECODER_DTYPE = process.env.LOCAL_DECODER_DTYPE || 'q8';
// Below this level a chunk is treated as silence and skipped (Whisper hallucinates on silence).
const SILENCE_RMS = 0.002;

env.cacheDir = process.env.MODEL_CACHE_DIR || path.join(os.homedir(), '.cache', 'play-it', 'models');

export const name = 'local';
export const description = `${MODEL} (encoder ${ENCODER_DTYPE}, decoder ${DECODER_DTYPE})`;
export const maxUploadBytes = (Number(process.env.MAX_UPLOAD_MB) || 200) * 1024 * 1024;

// Model load state, shared by all jobs and surfaced in their progress reports.
const model = { status: 'idle', progress: 0, error: null, asr: null, promise: null };

export function loadModel() {
  if (model.promise) return model.promise;
  model.status = 'loading';
  const files = new Map(); // file -> { loaded, total }
  model.promise = pipeline('automatic-speech-recognition', MODEL, {
    device: 'cpu',
    dtype: { encoder_model: ENCODER_DTYPE, decoder_model_merged: DECODER_DTYPE },
    // fp32 encoders of large models store weights in a separate .onnx_data file.
    use_external_data_format: { encoder_model: ENCODER_DTYPE === 'fp32' },
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0, total = 0;
        for (const f of files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        model.progress = total ? loaded / total : 0;
      }
    },
  })
    .then((asr) => {
      model.asr = asr;
      model.status = 'ready';
      model.progress = 1;
      console.log(`Local model ready: ${description}`);
      return asr;
    })
    .catch((e) => {
      model.status = 'error';
      model.error = e.message;
      model.promise = null; // allow retry on next job
      throw e;
    });
  return model.promise;
}

/**
 * @param {{buffer: Buffer, filename: string}} file
 * @param {(update: {phase: string, progress?: number, segments?: object[], duration?: number}) => void} onUpdate
 */
export async function transcribe({ buffer, filename }, onUpdate) {
  onUpdate({ phase: 'decoding' });
  const audio = await decodeToMono16k(buffer, filename);
  const duration = audio.length / SAMPLE_RATE;

  if (model.status !== 'ready') {
    const timer = setInterval(() => onUpdate({ phase: 'loading-model', progress: model.progress }), 500);
    try {
      await loadModel();
    } finally {
      clearInterval(timer);
    }
  }

  const chunks = splitAtSilence(audio);
  const segments = [];
  for (let i = 0; i < chunks.length; i++) {
    onUpdate({ phase: 'transcribing', progress: i / chunks.length, segments, duration });
    const { start, end } = chunks[i];
    if (rms(audio, start, end) < SILENCE_RMS) continue;

    const offset = start / SAMPLE_RATE;
    const chunkDur = (end - start) / SAMPLE_RATE;
    const out = await model.asr(audio.subarray(start, end), {
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
  onUpdate({ phase: 'transcribing', progress: 1, segments, duration });
  return { segments, duration, text: segments.map((s) => s.text).join('') };
}
