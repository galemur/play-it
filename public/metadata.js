// Reads title / artist / album / cover art from ID3 tags (MP3, and WAV files that carry ID3).
// Other formats (M4A, FLAC, OGG) return null and the file name is shown instead.

const latin1 = new TextDecoder('latin1');

// ID3v1 tags, and ID3v2 frames that claim to be Latin-1, usually hold text in whatever
// codepage the tagging software used: Shift_JIS, Big5, GBK, EUC-KR... Those byte ranges
// overlap (Big5 text is often valid Shift_JIS, decoding to half-width katakana), so each
// candidate is scored and the most plausible one wins, once for all fields of a file.
// Some byte strings are equally plausible in two encodings (EUC-KR Korean is also valid GBK
// Chinese). Like music players, break such ties with the device language.
const LOCALE_ENCODING = [
  [/^ja/i, 'shift_jis'],
  [/^zh-(tw|hk|mo|hant)/i, 'big5'],
  [/^zh/i, 'gbk'],
  [/^ko/i, 'euc-kr'],
];
const preferred = (globalThis.navigator?.languages ?? [])
  .map((lang) => LOCALE_ENCODING.find(([re]) => re.test(lang))?.[1])
  .filter(Boolean);
const LEGACY_ORDER = [...new Set(['utf-8', ...preferred, 'shift_jis', 'big5', 'gbk', 'euc-kr'])];

// The standard (HKSCS-based) Big5 decoder maps the kana of Microsoft's Big5 (CP950) to
// private-use code points, which display as nothing. Map them back to kana.
const BIG5_KANA = [
  [0xf6b5, 0xf707, 0x3041], // ぁ … ん
  [0xf708, 0xf75d, 0x30a1], // ァ … ヶ
  [0xf6b2, 0xf6b3, 0x309d], // ゝ ゞ
  [0xf6b1, 0xf6b1, 0x30fe], // ヾ
];
const fixBig5Kana = (text) =>
  text.replace(/[\uf6b1-\uf75d]/g, (ch) => {
    const c = ch.charCodeAt(0);
    const run = BIG5_KANA.find(([lo, hi]) => c >= lo && c <= hi);
    return run ? String.fromCharCode(run[2] + c - run[0]) : ch;
  });

const LEGACY_CANDIDATES = LEGACY_ORDER.flatMap((enc) => {
  try {
    const decoder = new TextDecoder(enc, { fatal: true });
    if (enc === 'big5') return [[enc, { decode: (b) => fixBig5Kana(decoder.decode(b)) }]];
    return [[enc, decoder]];
  } catch {
    return []; // not supported by this browser
  }
});

/** How much a decoded string looks like real text (higher is better). */
function plausibility(text) {
  let score = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) continue; // ASCII reads the same in every candidate
    if ((c >= 0x3040 && c <= 0x30ff) || c === 0x30fc) score += 3; // hiragana / katakana
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) score += 2; // kanji / hanzi
    else if (c >= 0xac00 && c <= 0xd7af) score += 2; // hangul
    else if (c >= 0x3000 && c <= 0x303f) score += 1; // CJK punctuation
    else if (c >= 0xff01 && c <= 0xff5e) score += 1; // full-width ASCII
    else if (c >= 0xc0 && c <= 0x17f) score += 1; // accented Latin letters
    else if (c >= 0xff61 && c <= 0xff9f) score -= 4; // half-width katakana: rare in real tags
    else if ((c >= 0x80 && c <= 0x9f) || (c >= 0xe000 && c <= 0xf8ff) || c === 0xfffd) score -= 5; // controls, private use
    else score -= 1;
  }
  return score;
}

// Each encoding stores its most frequent characters in a known byte range. Text in the right
// encoding lands there; text read with the wrong one lands in rare or extension ranges
// (e.g. kanji-only Shift_JIS read as GBK gives valid but obscure hanzi).
const between = (c, lo, hi) => c >= lo && c <= hi;
const REGION_SCORE = {
  shift_jis: (c) => (between(c, 0x889f, 0x9872) ? 1 : between(c, 0x989f, 0xeaa4) || c < 0x8800 ? 0 : -1), // JIS level 1 kanji
  big5: (c) => (between(c, 0xa440, 0xc67e) ? 1 : between(c, 0xc940, 0xf9d5) || c < 0xa440 ? 0 : -1), // frequent hanzi
  gbk: (c) => (between(c, 0xb0a1, 0xd7f9) ? 1 : between(c, 0xd8a1, 0xf7fe) ? 0 : between(c, 0xa4a1, 0xa5f6) ? -2 : c < 0xb0a1 && (c & 0xff) >= 0xa1 ? 0 : -1), // level 1 hanzi; kana rows / extension rare
  'euc-kr': (c) => (between(c, 0xb0a1, 0xc8fe) ? 1 : between(c, 0xcaa1, 0xfdfe) ? 0 : between(c, 0xaaa1, 0xabf6) ? -2 : 0), // common hangul; kana rows rare
};

/** Bonus for how many two-byte characters fall in the encoding's common range. */
function regionScore(enc, bytes) {
  const score = REGION_SCORE[enc];
  if (!score) return 0;
  let total = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80 || (enc === 'shift_jis' && between(b, 0xa1, 0xdf))) continue; // single-byte
    total += score((b << 8) | (bytes[i + 1] ?? 0));
    i++;
  }
  return total;
}

/** Pick the encoding that reads all of a file's legacy-encoded fields most plausibly. */
function pickLegacyDecoder(chunks) {
  if (!chunks.some((b) => b.some((x) => x > 0x7f))) return latin1; // plain ASCII
  let best = latin1;
  let bestScore = chunks.reduce((n, b) => n + plausibility(latin1.decode(b)), 0);
  for (const [enc, decoder] of LEGACY_CANDIDATES) {
    let score = 0;
    try {
      for (const b of chunks) score += plausibility(decoder.decode(b)) + regionScore(enc, b);
    } catch {
      continue; // invalid in this encoding
    }
    // Valid multi-byte UTF-8 practically never happens by accident.
    if (enc === 'utf-8') return decoder;
    if (score > bestScore) [best, bestScore] = [decoder, score]; // ties keep the earlier (device language first)
  }
  return best;
}

/** Text of a frame; Latin-1 (legacy) frames are returned as raw bytes, decoded later per file. */
function decodeText(enc, bytes) {
  if (enc === 0) return { legacy: bytes.subarray(0, terminator(bytes, 0, 0)) };
  if (enc === 1) return new TextDecoder('utf-16').decode(bytes); // BOM picks the byte order
  if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

const clean = (s) => s.replace(/\0+$/, '').split('\0')[0].trim();

/** Index of the string terminator at or after `from` (two zero bytes, aligned, for UTF-16). */
function terminator(bytes, from, enc) {
  const wide = enc === 1 || enc === 2;
  for (let i = from; i < bytes.length; i += wide ? 2 : 1) {
    if (bytes[i] === 0 && (!wide || bytes[i + 1] === 0)) return i;
  }
  return bytes.length;
}

const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const uint32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const unsync = (b) => {
  const out = [];
  for (let i = 0; i < b.length; i++) if (!(b[i] === 0 && b[i - 1] === 0xff)) out.push(b[i]);
  return new Uint8Array(out);
};

const FIELDS = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TPE2: 'albumArtist', TP2: 'albumArtist',
  TALB: 'album', TAL: 'album',
  TRCK: 'track', TRK: 'track',
  TDRC: 'year', TYER: 'year', TYE: 'year',
};

function parseId3v2(head, body) {
  const ver = head[3];
  if (ver < 2 || ver > 4) return null;
  let b = body;
  if (head[5] & 0x80 && ver < 4) b = unsync(b);
  let pos = 0;
  if (head[5] & 0x40 && ver >= 3) pos = ver === 3 ? uint32(b, 0) + 4 : syncsafe(b, 0);

  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  const meta = {};
  let pic = null;
  while (pos + hdrLen <= b.length) {
    const id = latin1.decode(b.subarray(pos, pos + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    const size = ver === 2 ? (b[pos + 3] << 16) | (b[pos + 4] << 8) | b[pos + 5] : ver === 3 ? uint32(b, pos + 4) : syncsafe(b, pos + 4);
    let data = b.subarray(pos + hdrLen, pos + hdrLen + size);
    if (ver === 4 && b[pos + 9] & 0x02) data = unsync(data);
    pos += hdrLen + size;
    if (!data.length) continue;

    const field = FIELDS[id];
    if (field && !meta[field]) {
      const text = decodeText(data[0], data.subarray(1));
      if (text.legacy) {
        if (text.legacy.length) meta[field] = text;
      } else if (clean(text)) meta[field] = clean(text);
    } else if ((id === 'APIC' || id === 'PIC') && !pic) {
      const enc = data[0];
      let i, mime;
      if (id === 'PIC') {
        mime = `image/${latin1.decode(data.subarray(1, 4)).toLowerCase().replace('jpg', 'jpeg')}`;
        i = 4;
      } else {
        const end = terminator(data, 1, 0);
        mime = latin1.decode(data.subarray(1, end)) || 'image/jpeg';
        if (!mime.includes('/')) mime = `image/${mime.toLowerCase().replace('jpg', 'jpeg')}`;
        i = end + 1;
      }
      i += 1; // picture type
      const descEnd = terminator(data, i, enc);
      i = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
      if (i < data.length) pic = new Blob([data.slice(i)], { type: mime });
    }
  }
  if (pic) meta.picture = pic;
  return meta;
}

function parseId3v1(b) {
  if (latin1.decode(b.subarray(0, 3)) !== 'TAG') return null;
  const field = (o, n) => {
    const bytes = b.subarray(o, o + n);
    const raw = bytes.subarray(0, terminator(bytes, 0, 0));
    return raw.some((x) => x !== 0x20) ? { legacy: raw } : undefined;
  };
  const meta = { title: field(3, 30), artist: field(33, 30), album: field(63, 30), year: field(93, 4) };
  if (b[125] === 0 && b[126]) meta.track = String(b[126]);
  return meta;
}

/** Tag fields of an audio file, or null when it has none we can read. */
export async function readMetadata(file) {
  try {
    let meta = null;
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head.length === 10 && latin1.decode(head.subarray(0, 3)) === 'ID3') {
      const size = syncsafe(head, 6);
      meta = parseId3v2(head, new Uint8Array(await file.slice(10, 10 + size).arrayBuffer()));
    }
    if (!meta?.title && file.size > 128) {
      const v1 = parseId3v1(new Uint8Array(await file.slice(-128).arrayBuffer()));
      if (v1) meta = { ...v1, ...Object.fromEntries(Object.entries(meta ?? {}).filter(([, v]) => v)) };
    }
    // Decode all legacy-encoded fields with the one encoding that fits them best together.
    const legacy = Object.entries(meta ?? {}).filter(([, v]) => v?.legacy);
    if (legacy.length) {
      const decoder = pickLegacyDecoder(legacy.map(([, v]) => v.legacy));
      for (const [k, v] of legacy) meta[k] = clean(decoder.decode(v.legacy));
    }
    for (const k of Object.keys(meta ?? {})) if (!meta[k]) delete meta[k];
    return meta && Object.keys(meta).length ? meta : null;
  } catch {
    return null;
  }
}
