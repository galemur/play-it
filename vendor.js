// Third-party files the browser needs for on-device transcription. Used by server.js (served
// live from node_modules) and scripts/build-static.js (copied into dist/ for static hosting).
export const VENDOR = [
  { url: 'vendor/transformers', dir: 'node_modules/@huggingface/transformers/dist', files: ['transformers.min.js'] },
  {
    url: 'vendor/ort',
    dir: 'node_modules/onnxruntime-web/dist',
    files: ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'],
  },
  { url: 'vendor/kuromoji', dir: 'node_modules/kuromoji/build', files: ['kuromoji.js'] },
  { url: 'vendor/kuromoji-dict', dir: 'node_modules/kuromoji/dict', files: null }, // whole directory
];
