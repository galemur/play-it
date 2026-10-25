// LRC ("synced lyrics") import/export.
//
// LRC only stores when each line starts. To keep sentence ends (needed for repeat mode) we
// follow the common convention of a blank timed line marking where the previous line stops.

const TIME_TAG = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[([a-z#]+):(.*)\]$/i;
const WORD_TAG = /<\d+:\d{1,2}(?:[.:]\d{1,3})?>/g; // "enhanced LRC" per-word times

const toSeconds = (m, s, frac = '') => +m * 60 + +s + (frac ? +frac / 10 ** frac.length : 0);

/**
 * Parse LRC text.
 * @returns {{ lines: {time: number, text: string}[], meta: Record<string, string> }}
 */
export function parseLrc(text) {
  const meta = {};
  const lines = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(META_TAG);
    if (m && !/^\d+$/.test(m[1])) {
      meta[m[1].toLowerCase()] = m[2].trim();
      continue;
    }
    const times = [...line.matchAll(TIME_TAG)];
    if (!times.length) continue;
    const words = line.replace(TIME_TAG, '').replace(WORD_TAG, '').trim();
    // A line may carry several times (e.g. a repeated chorus): one entry per time.
    for (const t of times) lines.push({ time: toSeconds(t[1], t[2], t[3]), text: words });
  }
  // [offset:+500] means "show lyrics 0.5 s earlier".
  const offset = (Number(meta.offset) || 0) / 1000;
  for (const l of lines) l.time = Math.max(0, l.time - offset);
  lines.sort((a, b) => a.time - b.time);
  return { lines, meta };
}

/** True if the text looks like LRC (has at least one timed line). */
export const isTimedLrc = (text) => parseLrc(text).lines.some((l) => l.text);

/**
 * Turn parsed LRC lines into player segments. Blank lines end the previous segment;
 * otherwise a segment lasts until the next one starts (the last until `duration`).
 */
export function lrcToSegments({ lines }, duration) {
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const { time, text } = lines[i];
    if (!text) continue;
    const next = lines[i + 1];
    const end = next ? next.time : Number.isFinite(duration) ? Math.max(duration, time) : time + 5;
    segments.push({ start: time, end, text });
  }
  return segments;
}

const stamp = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}]`;
};

/** Build LRC text from player segments, with a blank timed line wherever a sentence ends early. */
export function buildLrc(segments, { title, artist, album, duration } = {}) {
  const clean = (v) => String(v).replace(/[\r\n\]]/g, ' ').trim();
  const out = [];
  if (title) out.push(`[ti:${clean(title)}]`);
  if (artist) out.push(`[ar:${clean(artist)}]`);
  if (album) out.push(`[al:${clean(album)}]`);
  if (duration) out.push(`[length:${stamp(duration).slice(1, 6)}]`);
  out.push('[re:Play It]');
  segments.forEach((seg, i) => {
    out.push(`${stamp(seg.start)}${seg.text.replace(/\s*\n\s*/g, ' ')}`);
    const next = segments[i + 1];
    // Mark the end only when there's a real pause before the next line (or at the very end).
    if (!next || next.start - seg.end > 0.3) out.push(stamp(seg.end));
  });
  return out.join('\n') + '\n';
}
