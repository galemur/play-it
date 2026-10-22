# Play It

A local web app for Japanese voice recordings. Upload an MP3 or WAV file, get it
transcribed, then play it back. The transcript highlights and scrolls along with
the audio. The layout is designed for phones.

## Transcription

By default, transcription runs **fully offline**. Whisper runs inside Node with
[Transformers.js](https://huggingface.co/docs/transformers.js) (ONNX Runtime).
There's no API key, no Python, no ffmpeg and no native build step.

- Default model: `onnx-community/whisper-large-v3-turbo`, 8-bit quantized
  (about 1 GB, downloaded once on first start to `~/.cache/play-it/models`).
- Language is fixed to Japanese. Output has segment-level timestamps.
- Measured on an 8-core CPU: about 2–3× faster than real time
  (63 s of speech in 28 s).
- Long recordings are split at quiet points into chunks of 30 s or less, so
  words aren't cut in half. Progress and partial text show while it runs.

A cloud transcriber (any OpenAI-compatible Whisper API) is also included. Set
`TRANSCRIBER=openai` to use it; see `.env.example`.

## Run it entirely on your phone (no computer)

The app can also transcribe **inside the phone's browser**: Whisper and the
furigana dictionary run on the phone, and nothing is uploaded anywhere. After
the first use it works fully offline, and you can install it to the home screen
like an app.

| Preset | Model | One-time download | Accuracy (CER, Japanese test) | Runs on |
|---|---|---|---|---|
| Accurate | whisper-large-v3-turbo q4 | ~760 MB | 5.0% | Phone GPU (WebGPU), CPU fallback |
| Fast | whisper-small q8 | ~250 MB | 8.4% | Phone CPU (multi-threaded WASM) |

For comparison, the computer server (turbo q8) scores 3.7%. CER is the
character error rate on 15 JSUT sentences; lower is better. The app picks
Accurate when the phone supports WebGPU (recent Android phones in Chrome do)
and Fast otherwise. You can switch on the upload screen.

Browsers only allow this on **HTTPS or localhost**, so the app has to be served
one of these ways:

**A. Free static hosting (recommended)**

```bash
npm run build          # creates dist/ (~45 MB, no server code)
```

Upload the contents of `dist/` to any HTTPS static host, for example GitHub
Pages, Netlify Drop or Cloudflare Pages. A sub-folder URL is fine. Then:

1. On the phone, open the URL in Chrome.
2. Menu ⋮ → **Add to Home screen / Install app**.
3. Do the first transcription on Wi-Fi; that downloads the model.
4. From then on it works offline, including in airplane mode.

**B. Serve it from the phone itself (Termux)**

1. Install [Termux](https://f-droid.org/packages/com.termux/) and run:
   ```bash
   pkg install nodejs
   ```
2. Copy `dist/` to the phone.
3. In Termux, run:
   ```bash
   npx http-server dist -p 8080
   ```
4. Open http://localhost:8080 in Chrome. After that first visit, the app is
   cached, so it opens even when Termux isn't running.

**Testing against the computer server:** `http://<computer-ip>:3000` isn't
HTTPS, so the "This phone" option is disabled there. Connect the phone over USB
and run:

```bash
adb reverse tcp:3000 tcp:3000
```

Then open http://localhost:3000 on the phone.

Notes:

- The phone's screen is kept awake while transcribing. Android pauses pages
  whose screen is off, which would stall the job.
- The kuromoji dictionary is served as `.dat.gz` files and decompressed in the
  browser. If a host serves them with a `Content-Encoding: gzip` header,
  furigana fails to load. Most static hosts don't do this.

## Setup

Requires Node.js 22 or later.

```bash
npm install
cp .env.example .env   # optional; the defaults work as-is
npm start
```

Open http://localhost:3000. To use it from your phone, connect the phone to the
same Wi-Fi network and open `http://<your-computer-ip>:3000`.

The first start downloads the model in the background. The progress screen shows
the download percentage if you upload a file before it finishes.

## Features

- Pick a file or drag and drop it: MP3, WAV, M4A/AAC, OGG/Opus, FLAC or WebM. Formats other
  than MP3/WAV are decoded by the browser; for the computer server they're converted to a
  16 kHz WAV before uploading.
- **Furigana**: hiragana readings above kanji (e.g. 授業 with じゅぎょう above it).
  Okurigana is left uncovered (買わ shows か over 買 only). Turn them off with the
  Furigana switch; the setting is remembered.
- **Text** switch shows or hides the transcript. It's hidden by default, for listening
  practice; the setting is remembered. Sentence controls and repeat still work while
  it's hidden.
- Player docked at the bottom:

  | Button | Action |
  |---|---|
  | 1× | Playback speed (0.75 / 1 / 1.25 / 1.5) |
  | ⏮ / ⏭ | Previous / next sentence |
  | 🔂 | Repeat the current sentence (toggle). Any seek moves the loop to the sentence you land on. |

- The current sentence is highlighted and scrolled into view. Auto-scroll pauses
  for 3 s while you scroll by hand.
- Tap any sentence to play from there
- Headset and lock-screen previous/next buttons skip by sentence
- Desktop keys: Space = play/pause, ← / → = previous/next sentence, R = repeat
- Copy the full transcript
- **Track info**: title, artist, album, track number and cover art are read from the
  file's ID3 tags (MP3, and WAV files that carry ID3; Shift_JIS-encoded tags are
  handled). They also show on the lock screen. Other formats show the file name.
- **Recent files**: each transcribed file is saved in the browser (IndexedDB) together
  with its audio, and listed under *Recent* on the start screen. Tap one to play it
  again straight away, with no file picking or transcribing; tap × to remove it. Browsers
  never reveal a file's original path, which is why the audio itself is stored. If storage
  is full, only the transcript is kept, and tapping the entry asks for the file again.
  Choosing a file that's already in the list also opens the saved transcript.

## Furigana

Furigana are generated on the server with
[kuromoji](https://github.com/takuyaa/kuromoji.js), a Japanese word splitter
using the IPADIC dictionary, after transcription. This works with any
transcriber. Each word's reading is matched to its kanji, and words that sit
directly next to each other are merged (上院 + 議員 becomes 上院議員 /
じょういんぎいん) so long readings spread across the compound. Readings come from
the dictionary, so rare names may be wrong. Common corrections can be added to
`READING_OVERRIDES` in `lib/furigana.js`.

## Project layout

```
server.js               Express server, upload handling, in-memory job queue
transcribers/local.js   Offline Whisper (Transformers.js)
transcribers/openai.js  Cloud Whisper (OpenAI-compatible API)
lib/audio.js            MP3/WAV decoding to 16 kHz mono, silence-based chunking
lib/furigana.js         Kanji readings (kuromoji) aligned for ruby display
public/                 Mobile-first frontend (no build step)
  metadata.js           ID3 tag reader (title, artist, album, cover)
  history.js            Recent files: transcripts + audio in IndexedDB
  device/               On-device engine: Web Worker running Whisper + kuromoji in the browser
  shared/               Chunking and furigana alignment shared by server and browser
  sw.js                 Service worker: offline cache + cross-origin isolation headers
vendor.js               Browser libraries served from node_modules / copied into dist/
scripts/build-static.js Builds dist/ for static hosting
```

To add a transcriber, create a module in `transcribers/` that exports
`name`, `description`, `maxUploadBytes`, `loadModel()` and
`transcribe(file, onUpdate)`, then register it in `PROVIDERS` in `server.js`.

## Notes

- Audio is played from the file in your browser. The server keeps uploads in
  memory only for the length of the job.
- Jobs run one at a time, because the model uses all CPU cores.
- The project folder is on a network share without symlink support, so
  `.npmrc` sets `bin-links=false`.
