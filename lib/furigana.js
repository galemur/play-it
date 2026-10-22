// Server-side furigana: kuromoji (Node build) supplies tokens and readings; the alignment
// itself lives in public/shared/ruby.js so the on-device engine produces identical output.
import path from 'node:path';
import { createRequire } from 'node:module';
import { tokensToRuby } from '../public/shared/ruby.js';

const require = createRequire(import.meta.url);
const kuromoji = require('kuromoji');
const DIC_PATH = path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict');

let tokenizerPromise;
export function loadTokenizer() {
  tokenizerPromise ??= new Promise((resolve, reject) =>
    kuromoji.builder({ dicPath: DIC_PATH }).build((err, t) => (err ? reject(err) : resolve(t)))
  );
  return tokenizerPromise;
}

/** Convert text into ruby parts: [[text], [kanji, reading], ...]. */
export async function toRuby(text) {
  const tokenizer = await loadTokenizer();
  return tokensToRuby(tokenizer.tokenize(text));
}
