// Kanji → furigana alignment, shared by the Node server (lib/furigana.js) and the
// in-browser engine (public/device/worker.js). Input is kuromoji tokens.

const KANJI = /[㐀-䶿一-鿿豈-﫿々〆ヵヶ]/;
const KANJI_RUN = /[㐀-䶿一-鿿豈-﫿々〆ヵヶ]+/g;

// IPADIC readings that differ from everyday usage.
const READING_OVERRIDES = { 日本: 'にほん' };

const toHiragana = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split one token into [text, reading?] parts, giving readings only to the kanji runs. */
function alignToken(surface, reading) {
  if (!KANJI.test(surface) || !reading || reading === '*') return [[surface]];
  const hira = toHiragana(reading);

  // Alternate kana/kanji runs; kana runs must match literally, kanji runs capture their reading.
  const runs = [];
  let last = 0;
  for (const m of surface.matchAll(KANJI_RUN)) {
    if (m.index > last) runs.push({ text: surface.slice(last, m.index), kanji: false });
    runs.push({ text: m[0], kanji: true });
    last = m.index + m[0].length;
  }
  if (last < surface.length) runs.push({ text: surface.slice(last), kanji: false });

  const re = new RegExp(`^${runs.map((r) => (r.kanji ? '(.+?)' : escapeRe(toHiragana(r.text)))).join('')}$`);
  const m = hira.match(re);
  if (!m) return [[surface, hira]]; // irregular reading (e.g. 今日): ruby over the whole word

  let g = 1;
  return runs.map((r) => (r.kanji ? [r.text, m[g++]] : [r.text]));
}

/**
 * Convert kuromoji tokens into ruby parts: [[text], [kanji, reading], ...].
 * Adjacent parts of the same kind are merged: plain text so the client renders fewer
 * nodes, and ruby (e.g. 上院 + 議員) so long readings can spread over the whole compound
 * instead of pushing neighbouring kanji apart.
 */
export function tokensToRuby(tokens) {
  const parts = [];
  for (const tok of tokens) {
    const reading = READING_OVERRIDES[tok.surface_form] ?? tok.reading;
    for (const p of alignToken(tok.surface_form, reading)) {
      const prev = parts.at(-1);
      if (prev && p.length === prev.length) {
        prev[0] += p[0];
        if (p.length === 2) prev[1] += p[1];
      } else parts.push(p);
    }
  }
  return parts;
}
