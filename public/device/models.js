// On-device model presets (browser). Sizes are the one-time download, cached afterwards.
export const DEVICE_MODELS = {
  accurate: {
    label: 'Accurate',
    detail: 'Whisper large-v3-turbo · ~760 MB · best with WebGPU',
    id: 'onnx-community/whisper-large-v3-turbo',
    dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' },
    preferWebGPU: true,
  },
  fast: {
    label: 'Fast',
    detail: 'Whisper small · ~250 MB · less accurate',
    id: 'onnx-community/whisper-small',
    // q8 weights use integer ops WebGPU doesn't accelerate, so this preset stays on WASM.
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    preferWebGPU: false,
  },
};

/** Identifier for caching transcripts per model/precision. */
export const modelTag = (key) => {
  const m = DEVICE_MODELS[key];
  return `device:${m.id}:${m.dtype.encoder_model}/${m.dtype.decoder_model_merged}`;
};
