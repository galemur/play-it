// Cloud transcription via any OpenAI-compatible Whisper endpoint (OpenAI, Groq, Azure, ...).
// Reads OPENAI_API_KEY and OPENAI_BASE_URL from the environment.
import OpenAI, { toFile } from 'openai';

const MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';

export const name = 'openai';
export const description = `${MODEL} @ ${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}`;
// The OpenAI transcription endpoint rejects files larger than 25 MB.
export const maxUploadBytes = 25 * 1024 * 1024;

let client;

export function loadModel() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set.');
  client ??= new OpenAI();
  return Promise.resolve();
}

export async function transcribe({ buffer, filename, mimetype }, onUpdate) {
  await loadModel();
  onUpdate({ phase: 'transcribing', progress: 0 });
  try {
    const result = await client.audio.transcriptions.create({
      file: await toFile(buffer, filename, { type: mimetype }),
      model: MODEL,
      language: 'ja',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });
    const segments = (result.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
    return { segments, duration: result.duration, text: result.text };
  } catch (e) {
    throw new Error(e?.error?.message || e.message);
  }
}
