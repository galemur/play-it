import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toRuby, loadTokenizer } from './lib/furigana.js';
import { VENDOR } from './vendor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRANSCRIBER = process.env.TRANSCRIBER || 'local';
const JOB_TTL_MS = 60 * 60 * 1000;

const PROVIDERS = { local: './transcribers/local.js', openai: './transcribers/openai.js' };
if (!PROVIDERS[TRANSCRIBER]) {
  console.error(`Unknown TRANSCRIBER "${TRANSCRIBER}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`);
  process.exit(1);
}
const transcriber = await import(PROVIDERS[TRANSCRIBER]);

const ALLOWED_EXT = new Set(['.mp3', '.wav']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: transcriber.maxUploadBytes },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error('Only .mp3 and .wav files are supported.'));
  },
});

// ---------- job queue (one transcription at a time; the model is CPU-bound) ----------
const jobs = new Map();
const queue = [];
let running = false;

function publicJob(job) {
  const { file, ...rest } = job;
  return { ...rest, position: job.status === 'queued' ? queue.indexOf(job) + 1 : 0 };
}

async function runQueue() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue[0];
    job.status = 'running';
    const t0 = Date.now();
    try {
      const result = await transcriber.transcribe(job.file, (u) => Object.assign(job, u));
      job.phase = 'furigana';
      for (const seg of result.segments) seg.ruby = await toRuby(seg.text);
      Object.assign(job, result, { status: 'done', progress: 1 });
      console.log(`Transcribed ${job.filename} (${result.duration?.toFixed(1)}s audio) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.error(`Transcription of ${job.filename} failed:`, e.message);
      Object.assign(job, { status: 'error', error: e.message });
    }
    job.file = null; // free the upload buffer
    job.finishedAt = Date.now();
    queue.shift();
  }
  running = false;
}

setInterval(() => {
  for (const [id, job] of jobs) if (job.finishedAt && Date.now() - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
}, 10 * 60 * 1000).unref();

// ---------- routes ----------
const app = express();
// Cross-origin isolation enables multi-threaded WASM for on-device transcription.
// "credentialless" still allows fetching models from the Hugging Face CDN.
app.use((_req, res, next) => {
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
for (const { url, dir, files } of VENDOR) {
  const serve = express.static(path.join(__dirname, dir));
  app.use(`/${url}`, files ? (req, res, next) => (files.includes(req.path.slice(1)) ? serve(req, res, next) : next()) : serve);
}

app.get('/api/config', (_req, res) => {
  res.json({
    transcriber: transcriber.name,
    model: transcriber.description,
    maxUploadBytes: transcriber.maxUploadBytes,
  });
});

app.post('/api/transcribe', (req, res) => {
  upload.single('audio')(req, res, (err) => {
    if (err) {
      const mb = Math.round(transcriber.maxUploadBytes / 1024 / 1024);
      const message = err.code === 'LIMIT_FILE_SIZE' ? `File is too large (max ${mb} MB).` : err.message;
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' });

    const job = {
      id: randomUUID(),
      filename: req.file.originalname,
      status: 'queued',
      phase: null,
      progress: 0,
      segments: [],
      file: { buffer: req.file.buffer, filename: req.file.originalname, mimetype: req.file.mimetype },
    };
    jobs.set(job.id, job);
    queue.push(job);
    runQueue();
    res.status(202).json({ jobId: job.id });
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found (the server may have restarted).' });
  res.json(publicJob(job));
});

app.listen(PORT, HOST, () => {
  console.log(`play-it running at http://localhost:${PORT}`);
  console.log(`Transcriber: ${transcriber.name} – ${transcriber.description}`);
  loadTokenizer().catch((e) => console.error(`Furigana dictionary failed to load: ${e.message}`));
  // Warm up the model in the background so the first upload doesn't wait for the download.
  Promise.resolve()
    .then(() => transcriber.loadModel())
    .catch((e) => console.error(`Model failed to load: ${e.message}`));
});
