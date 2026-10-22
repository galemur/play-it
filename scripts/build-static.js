// Builds dist/: a server-free copy of the app for static HTTPS hosting (GitHub Pages,
// Netlify, Cloudflare Pages, ...). Transcription then runs entirely on the phone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDOR } from '../vendor.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// Clear the previous build but keep dist/.git, so dist/ can be its own repo for GitHub Pages.
fs.mkdirSync(dist, { recursive: true });
for (const entry of fs.readdirSync(dist)) {
  if (entry !== '.git') fs.rmSync(path.join(dist, entry), { recursive: true, force: true });
}
fs.cpSync(path.join(root, 'public'), dist, { recursive: true });

for (const { url, dir, files } of VENDOR) {
  const from = path.join(root, dir);
  const to = path.join(dist, url);
  fs.mkdirSync(to, { recursive: true });
  for (const f of files ?? fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
}
// Stop GitHub Pages' Jekyll from skipping or rewriting files.
fs.writeFileSync(path.join(dist, '.nojekyll'), '');

let bytes = 0;
const walk = (d, top) =>
  fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    if (top && e.name === '.git') return;
    if (e.isDirectory()) walk(path.join(d, e.name));
    else bytes += fs.statSync(path.join(d, e.name)).size;
  });
walk(dist, true);
console.log(`Built ${path.relative(root, dist)}/ (${(bytes / 1024 / 1024).toFixed(1)} MB). Upload its contents to any HTTPS static host.`);
