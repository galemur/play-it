// Reads title / artist / album / cover art from ID3 tags (MP3, and WAV files that carry ID3).
// Other formats (M4A, FLAC, OGG) return null and the file name is shown instead.

const latin1 = new TextDecoder('latin1');
// Many Japanese MP3s store Shift_JIS bytes in frames that claim to be Latin-1.
const sjis = (() => {
  try {
    return new TextDecoder('shift_jis', { fatal: true });
  } catch {
    return null;
  }
})();

function decodeLegacy(bytes) {
  if (sjis && bytes.some((b) => b > 0x7f)) {
    try {
      return sjis.decode(bytes);
    } catch {
      /* not Shift_JIS – fall back to Latin-1 */
    }
  }
  return latin1.decode(bytes);
}

function decodeText(enc, bytes) {
  if (enc === 0) return decodeLegacy(bytes);
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
      const text = clean(decodeText(data[0], data.subarray(1)));
      if (text) meta[field] = text;
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
  const field = (o, n) => clean(decodeLegacy(b.subarray(o, o + n)));
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
    for (const k of Object.keys(meta ?? {})) if (!meta[k]) delete meta[k];
    return meta && Object.keys(meta).length ? meta : null;
  } catch {
    return null;
  }
}
