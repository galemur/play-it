import path from 'node:path';
import wavefile from 'wavefile';
import { MPEGDecoder } from 'mpg123-decoder';
import { SAMPLE_RATE } from '../public/shared/chunking.js';

// Chunking is shared with the in-browser (on-device) engine.
export { SAMPLE_RATE, splitAtSilence, rms } from '../public/shared/chunking.js';

/** Decode an uploaded MP3/WAV buffer into 16 kHz mono Float32 samples. */
export async function decodeToMono16k(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  const { channels, sampleRate } = ext === '.mp3' ? await decodeMp3(buffer) : decodeWav(buffer);
  if (!channels.length || !channels[0].length) throw new Error('Could not decode any audio from the file.');
  return resample(downmix(channels), sampleRate, SAMPLE_RATE);
}

function decodeWav(buffer) {
  const wav = new wavefile.WaveFile();
  try {
    wav.fromBuffer(buffer);
  } catch (e) {
    throw new Error(`Invalid WAV file: ${e.message}`);
  }
  wav.toBitDepth('32f');
  let samples = wav.getSamples(false, Float32Array);
  if (!Array.isArray(samples)) samples = [samples];
  return { channels: samples, sampleRate: wav.fmt.sampleRate };
}

async function decodeMp3(buffer) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const parts = [];
    let sampleRate = 0;
    // Feed the decoder in slices to keep the WASM heap small for long files.
    const SLICE = 512 * 1024;
    for (let i = 0; i < buffer.length; i += SLICE) {
      const out = decoder.decode(buffer.subarray(i, i + SLICE));
      if (out.samplesDecoded) {
        sampleRate = out.sampleRate;
        parts.push(out.channelData.map((c) => c.slice(0, out.samplesDecoded)));
      }
    }
    if (!parts.length) throw new Error('Invalid or empty MP3 file.');
    const numCh = parts[0].length;
    const channels = Array.from({ length: numCh }, (_, ch) => concat(parts.map((p) => p[ch] ?? p[0])));
    return { channels, sampleRate };
  } finally {
    decoder.free();
  }
}

function concat(arrays) {
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function downmix(channels) {
  if (channels.length === 1) return channels[0];
  const len = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(len);
  for (const c of channels) for (let i = 0; i < len; i++) out[i] += c[i];
  for (let i = 0; i < len; i++) out[i] /= channels.length;
  return out;
}

/** Resample by averaging each output sample's input span (cheap anti-aliasing for downsampling). */
function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  if (ratio < 1) {
    // Upsampling: linear interpolation.
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const frac = pos - j;
      out[i] = input[j] * (1 - frac) + (input[j + 1] ?? input[j]) * frac;
    }
    return out;
  }
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}
