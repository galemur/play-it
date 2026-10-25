// Time a user-supplied transcript against Whisper's timed segments.
//
// Both texts are reduced to reading characters (hiragana via kuromoji) so that writing
// differences — 1週間 vs 一週間, kanji vs kana, punctuation — don't break the match.
// Each Whisper segment's time span is spread over its characters, and every user sentence
// takes its start/end from the first/last of its characters that matched.

const PUNCT_END = '。！？!?';
const CLOSERS = '」』）)]】"’”';
const SENTENCE_RE = new RegExp(`[^${PUNCT_END}]+(?:[${PUNCT_END}]+[${CLOSERS}]*)?|[${PUNCT_END}]+[${CLOSERS}]*`, 'g');

/** Split transcript text into sentences: one per line, also split after 。！？. */
export function splitSentences(text) {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .flatMap((line) => line.match(SENTENCE_RE) ?? [])
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

const toHiragana = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/** Reading characters for a piece of text (letters/digits only, kana as hiragana). */
function readingChars(text, tokenize) {
  const out = [];
  for (const tok of tokenize(text)) {
    const r = tok.reading && tok.reading !== '*' ? tok.reading : tok.surface_form;
    for (const c of toHiragana(r.normalize('NFKC').toLowerCase())) if (/[\p{L}\p{N}ー]/u.test(c)) out.push(c);
  }
  return out;
}

const ANCHOR_LEN = 4;
const MAX_DP_CELLS = 4_000_000;

/** For each index of `a`, the index of the equal character in `b` it aligns to, or -1. */
function alignSequences(a, b) {
  const map = new Int32Array(a.length).fill(-1);

  // 1. Anchors: character n-grams occurring exactly once in each sequence.
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i + ANCHOR_LEN <= s.length; i++) {
      const g = s.slice(i, i + ANCHOR_LEN).join('');
      m.set(g, m.has(g) ? -1 : i); // -1 marks "not unique"
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  const pairs = [];
  for (const [g, i] of ga) {
    const j = gb.get(g);
    if (i >= 0 && j >= 0) pairs.push([i, j]);
  }
  pairs.sort((x, y) => x[0] - y[0]);

  // 2. Keep the longest chain of anchors that is increasing in both sequences.
  const tails = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let p = 0; p < pairs.length; p++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < pairs[p][1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[p] = tails[lo - 1];
    tails[lo] = p;
  }
  const chain = [];
  for (let p = tails.at(-1) ?? -1; p >= 0; p = prev[p]) chain.push(pairs[p]);
  chain.reverse();

  // 3. Exact edit-distance alignment in the gaps between anchors.
  const fillGap = (a0, a1, b0, b1) => {
    const la = a1 - a0, lb = b1 - b0;
    if (la <= 0 || lb <= 0 || la * lb > MAX_DP_CELLS) return; // too big: leave unmatched (interpolated later)
    const w = lb + 1;
    const dir = new Uint8Array((la + 1) * w); // 0 = diagonal, 1 = up (skip a), 2 = left (skip b)
    let row = new Uint32Array(w), next = new Uint32Array(w);
    for (let j = 0; j <= lb; j++) {
      row[j] = j;
      dir[j] = 2;
    }
    for (let i = 1; i <= la; i++) {
      next[0] = i;
      dir[i * w] = 1;
      for (let j = 1; j <= lb; j++) {
        const diag = row[j - 1] + (a[a0 + i - 1] === b[b0 + j - 1] ? 0 : 1);
        const up = row[j] + 1;
        const left = next[j - 1] + 1;
        if (diag <= up && diag <= left) {
          next[j] = diag;
          dir[i * w + j] = 0;
        } else if (up <= left) {
          next[j] = up;
          dir[i * w + j] = 1;
        } else {
          next[j] = left;
          dir[i * w + j] = 2;
        }
      }
      [row, next] = [next, row];
    }
    for (let i = la, j = lb; i > 0 && j > 0; ) {
      const d = dir[i * w + j];
      if (d === 0) {
        if (a[a0 + i - 1] === b[b0 + j - 1]) map[a0 + i - 1] = b0 + j - 1;
        i--;
        j--;
      } else if (d === 1) i--;
      else j--;
    }
  };

  let ai = 0, bj = 0;
  for (const [i, j] of chain) {
    if (i < ai || j < bj) continue; // overlaps the previous anchor
    fillGap(ai, i, bj, j);
    for (let k = 0; k < ANCHOR_LEN; k++) map[i + k] = j + k;
    ai = i + ANCHOR_LEN;
    bj = j + ANCHOR_LEN;
  }
  fillGap(ai, a.length, bj, b.length);
  return map;
}

/**
 * @param {{start: number, end: number, text: string}[]} asrSegments Whisper output
 * @param {string[]} sentences the user's sentences
 * @param {(text: string) => {surface_form: string, reading?: string}[]} tokenize kuromoji
 * @returns {{segments: {start: number, end: number, text: string, approx?: true}[], matched: number}}
 */
export function alignTranscript(asrSegments, sentences, tokenize, duration) {
  // Whisper side: reading characters, each with a time slice of its segment.
  const b = [], t0 = [], t1 = [];
  for (const seg of asrSegments) {
    const chars = readingChars(seg.text, tokenize);
    const span = Math.max(0, seg.end - seg.start);
    chars.forEach((c, k) => {
      b.push(c);
      t0.push(seg.start + (span * k) / chars.length);
      t1.push(seg.start + (span * (k + 1)) / chars.length);
    });
  }

  // User side: reading characters, remembering which sentence each belongs to.
  const a = [];
  const ranges = sentences.map((s) => {
    const from = a.length;
    a.push(...readingChars(s, tokenize));
    return [from, a.length];
  });

  const map = alignSequences(a, b);
  let matchedChars = 0;
  const out = sentences.map((text, i) => {
    const [from, to] = ranges[i];
    let first = -1, last = -1, hits = 0;
    for (let k = from; k < to; k++) {
      if (map[k] < 0) continue;
      if (first < 0) first = map[k];
      last = map[k];
      hits++;
    }
    matchedChars += hits;
    const confident = to > from && hits / (to - from) >= 0.5;
    return first < 0 ? { text, start: null, end: null, approx: true } : { text, start: t0[first], end: t1[last], approx: !confident };
  });

  // Sentences without any match: share the gap between their timed neighbours by length.
  const total = duration || asrSegments.at(-1)?.end || 0;
  for (let i = 0; i < out.length; ) {
    if (out[i].start !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j].start === null) j++;
    const from = i > 0 ? out[i - 1].end : 0;
    const to = j < out.length ? out[j].start : total;
    const weights = out.slice(i, j).map((s) => Math.max(1, s.text.length));
    const sum = weights.reduce((x, y) => x + y, 0);
    let t = from;
    for (let k = i; k < j; k++) {
      const d = ((to - from) * weights[k - i]) / sum;
      out[k].start = t;
      out[k].end = t + d;
      t += d;
    }
    i = j;
  }

  // Keep starts in order (the player looks sentences up by start time).
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].start) out[i].start = out[i - 1].start;
    if (out[i].end < out[i].start) out[i].end = out[i].start;
  }
  for (const s of out) if (!s.approx) delete s.approx;
  return { segments: out, matched: a.length ? matchedChars / a.length : 0 };
}

/**
 * Whisper starts each segment where the previous one ended, so starts include the pause
 * before the speech. Snap starts/ends to speech onset/offset found in the audio. Only moves
 * a boundary when there's a clear quiet stretch next to it, so music or noisy recordings
 * are left as they are.
 */
export function snapToSpeech(segments, audio, sampleRate = 16000) {
  const frame = Math.round(sampleRate * 0.02); // 20 ms
  const n = Math.floor(audio.length / frame);
  if (!n) return segments;
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) s += audio[i] * audio[i];
    rms[f] = Math.sqrt(s / frame);
  }
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(n * 0.1)];
  const loud = sorted[Math.floor(n * 0.9)];
  if (loud < floor * 4) return segments; // no real contrast between pauses and speech
  const thr = floor + (loud - floor) * 0.15;
  const QUIET = 8; // frames (160 ms) of quiet required next to a boundary
  const toF = (t) => Math.max(0, Math.min(n - 1, Math.round(t / 0.02)));
  // Speech, unlike breath or room-noise blips, stays loud: 4 of 6 frames (~100 ms) above threshold.
  const sustained = (f, dir) => {
    let c = 0;
    for (let k = 0; k < 6; k++) c += rms[Math.max(0, Math.min(n - 1, f + dir * k))] >= thr;
    return c >= 4;
  };

  // In order, so each onset search starts after the previous sentence's corrected end:
  // Whisper often ends a sentence early, and its audible tail must not count as this one's start.
  const out = [];
  let prevEnd = 0;
  segments.forEach((seg, i) => {
    let { start, end } = seg;
    const nextStart = segments[i + 1]?.start ?? Infinity;
    // Onset: first sustained speech after a quiet run, from just before the start up to 3 s in.
    // If speech is already running at the start, leave it (never jump to a pause mid-sentence).
    for (let f = toF(Math.max(prevEnd, start - 0.3)), quiet = 0, last = toF(Math.min(start + 3, end - 0.3)); f <= last; f++) {
      if (rms[f] < thr || !sustained(f, 1)) quiet++; // short blips (breath, noise) count as quiet
      else if (quiet >= QUIET) {
        start = Math.max(seg.start - 0.3, prevEnd, f * 0.02 - 0.05);
        break;
      } else if (f * 0.02 >= seg.start) break;
      else quiet = 0; // tail of the previous sentence
    }
    // Offset: the same, searching backwards from a little after the end (Whisper also ends
    // sentences early), but not far into the next sentence.
    for (let f = toF(Math.min(end + 0.8, nextStart + 0.3)), quiet = 0, first = toF(Math.max(start + 0.3, end - 3)); f >= first; f--) {
      if (rms[f] < thr || !sustained(f, -1)) quiet++;
      else if (quiet >= QUIET) {
        end = Math.min(seg.end + 0.8, (f + 1) * 0.02 + 0.1);
        break;
      } else if (f * 0.02 <= seg.end) break;
      else quiet = 0;
    }
    const snapped = end > start ? { ...seg, start, end } : seg;
    out.push(snapped);
    prevEnd = snapped.end;
  });
  return out;
}
