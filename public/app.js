import { DEVICE_MODELS, modelTag, deviceUnsupportedReason, hasWebGPU, transcribeOnDevice, alignOnDevice, furiganaOnDevice, decodeFile, encodeWav, getGpuFailure, clearGpuFailure } from './device/engine.js';
import { splitSentences } from './shared/align.js';
import { parseLrc, lrcToSegments, buildLrc, isTimedLrc } from './shared/lrc.js';
import { readMetadata } from './metadata.js';
import { listHistory, getEntry, saveEntry, deleteEntry, touchEntry } from './history.js';

(() => {
  const $ = (id) => document.getElementById(id);

  const uploadView = $('uploadView');
  const loadingView = $('loadingView');
  const resultView = $('resultView');
  const player = $('player');
  const fileInput = $('fileInput');
  const dropzone = $('dropzone');
  const fileInfo = $('fileInfo');
  const transcribeBtn = $('transcribeBtn');
  const errorEl = $('error');
  const newBtn = $('newBtn');
  const copyBtn = $('copyBtn');
  const furiToggle = $('furiToggle');
  const furiSwitch = $('furiSwitch');
  const textToggle = $('textToggle');
  const hint = $('hint');
  const textPickBtn = $('textPickBtn');
  const textInput = $('textInput');
  const textInfo = $('textInfo');
  const textHelp = $('textHelp');
  const lrcModes = $('lrcModes');
  const exportBtn = $('exportBtn');
  const transcriptEl = $('transcript');
  const cover = $('cover');
  const trackTitle = $('trackTitle');
  const trackArtist = $('trackArtist');
  const trackAlbum = $('trackAlbum');
  const recentView = $('recentView');
  const recentList = $('recentList');
  const recentSize = $('recentSize');
  const audio = $('audio');
  const seek = $('seek');
  const playBtn = $('playBtn');
  const playIcon = $('playIcon');
  const pauseIcon = $('pauseIcon');
  const prevBtn = $('prevBtn');
  const nextBtn = $('nextBtn');
  const repeatBtn = $('repeatBtn');
  const gapRow = $('gapRow');
  const gapOpts = $('gapOpts');
  const gapNow = $('gapNow');
  const rateBtn = $('rateBtn');
  const curTime = $('curTime');
  const durTime = $('durTime');
  const dzSub = $('dzSub');
  const phaseText = $('phaseText');
  const phaseSub = $('phaseSub');
  const bar = document.querySelector('.bar');
  const barFill = $('barFill');
  const preview = $('preview');
  const deviceModelsEl = $('deviceModels');
  const deviceNote = $('deviceNote');
  const serverNote = $('serverNote');
  const gpuNotice = $('gpuNotice');

  const RATES = [0.75, 1, 1.25, 1.5];
  // v2: transcripts now include furigana, so older cached entries are ignored.
  const CACHE_PREFIX = 'playit:v2:';
  const FURIGANA_PREF = 'playit:furigana';
  const TEXT_PREF = 'playit:transcript';
  const ENGINE_PREF = 'playit:engine';
  const MODEL_PREF = 'playit:device-model';
  // The whole file is decoded in memory on the phone; keep it to a few hours of audio.
  const DEVICE_MAX_BYTES = 300 * 1024 * 1024;

  let selectedFile = null;
  let audioUrl = null;
  let segments = [];
  let segEls = [];
  let activeIdx = -1;
  let loopIdx = -1; // index of the sentence being repeated, or -1 when repeat is off
  let gapTimer = null; // pending replay while pausing between repeats
  let gapCountdown = null; // interval updating the "next in …" readout during the pause
  let userScrolledAt = 0;
  let seeking = false;
  let server = null; // { model, maxUploadBytes } when a Play It server is reachable
  let coverUrl = null;
  let recentEntries = [];
  let recentUrls = [];
  let relinkEntry = null; // history entry whose audio couldn't be stored, waiting for the file

  // ---------- engine selection: this phone (in-browser Whisper) or the computer server ----------
  const engineInput = (v) => document.querySelector(`input[name="engine"][value="${v}"]`);
  const engine = () => document.querySelector('input[name="engine"]:checked')?.value;
  const deviceModel = () => document.querySelector('input[name="dmodel"]:checked')?.value ?? 'accurate';
  const maxBytes = () => (engine() === 'server' ? server.maxUploadBytes : DEVICE_MAX_BYTES);
  const modelName = () => (engine() === 'server' ? server.model : modelTag(deviceModel()));

  deviceModelsEl.replaceChildren(
    ...Object.entries(DEVICE_MODELS).map(([key, m]) => {
      const label = document.createElement('label');
      label.className = 'model-opt';
      label.innerHTML = `<input type="radio" name="dmodel" value="${key}" /><span><b></b><small></small></span>`;
      label.querySelector('b').textContent = m.label;
      label.querySelector('small').textContent = m.detail;
      return label;
    })
  );

  const setEngineEnabled = (value, enabled, note) => {
    const input = engineInput(value);
    input.disabled = !enabled;
    input.closest('label').classList.toggle('disabled', !enabled);
    (value === 'device' ? deviceNote : serverNote).textContent = note;
  };

  // Diagnostic switch: ?simulate-gpu-error fails the GPU with subgroups (as on Adreno), to test
  // the compatibility-mode retry;
  // ?simulate-gpu-error=all also fails the GPU compatibility mode, to test the CPU fallback.
  const simulateParam = new URLSearchParams(location.search).get('simulate-gpu-error');
  const simulateGpuError = simulateParam === null ? '' : simulateParam || 'subgroups';

  const updateEngineUI = () => {
    deviceModelsEl.hidden = engine() !== 'device';
    gpuNotice.hidden = engine() !== 'device' || !getGpuFailure(deviceModel());
    if (engine()) dzSub.textContent = `MP3 · WAV · M4A · OGG · FLAC… · up to ${Math.round(maxBytes() / 1024 / 1024)} MB`;
    if (selectedFile) selectFile(selectedFile); // re-check the size limit for the new engine
  };

  document.addEventListener('change', (e) => {
    if (e.target.name === 'engine') localStorage.setItem(ENGINE_PREF, e.target.value);
    else if (e.target.name === 'dmodel') localStorage.setItem(MODEL_PREF, e.target.value);
    else return;
    updateEngineUI();
  });

  (async () => {
    const reason = deviceUnsupportedReason();
    const [gpu, cfg] = await Promise.all([
      reason ? false : hasWebGPU(),
      fetch('api/config')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);

    if (reason) setEngineEnabled('device', false, `Unavailable: ${reason}`);
    else setEngineEnabled('device', true, gpu ? 'Private and offline · GPU accelerated (WebGPU)' : 'Private and offline · no WebGPU, runs on the CPU (slower)');
    const model = localStorage.getItem(MODEL_PREF) ?? (gpu ? 'accurate' : 'fast');
    document.querySelector(`input[name="dmodel"][value="${DEVICE_MODELS[model] ? model : 'accurate'}"]`).checked = true;

    if (cfg?.model) {
      server = cfg;
      setEngineEnabled('server', true, `Whisper on your computer · ${cfg.model.split(' ')[0].split('/').pop()}`);
    } else {
      setEngineEnabled('server', false, 'Not available here (no Play It server)');
    }

    const pref = localStorage.getItem(ENGINE_PREF);
    // Prefer the computer when reachable (bigger model, faster); otherwise this phone.
    const choice = [pref, 'server', 'device'].find((v) => v && engineInput(v) && !engineInput(v).disabled);
    if (choice) engineInput(choice).checked = true;
    else showError('No way to transcribe here: open the app over HTTPS (or localhost), or run the Play It server.');
    updateEngineUI();
  })();

  // ---------- helpers ----------
  const fmt = (t) => {
    if (!isFinite(t)) return '0:00';
    t = Math.max(0, Math.floor(t));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  };
  const fmtSize = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);
  // Include the model so switching models doesn't serve a stale cached transcript.
  const entryId = (f) => `${modelName()}:${f.name}:${f.size}:${f.lastModified}`;
  // Transcripts used to be cached in localStorage; they're moved to the history when found.
  const legacyKey = (f) => `${CACHE_PREFIX}${entryId(f)}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hasFurigana = (data) => data.segments?.every((s) => Array.isArray(s.ruby));

  const show = (view) => {
    for (const v of [uploadView, loadingView, resultView]) v.hidden = v !== view;
    recentView.hidden = view !== uploadView || !recentEntries.length;
  };
  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  };

  // ---------- file selection ----------
  // The browser decodes all of these; the server only MP3/WAV, so other formats are
  // converted to WAV in the browser before uploading.
  const AUDIO_EXT = /\.(mp3|wav|m4a|aac|mp4|ogg|oga|opus|flac|webm)$/i;
  const SERVER_EXT = /\.(mp3|wav)$/i;
  // Android pickers sometimes return names without an extension; trust the MIME type then.
  const isSupported = (f) => AUDIO_EXT.test(f.name) || f.type.startsWith('audio/');

  const rejectFile = (msg) => {
    selectedFile = null;
    transcribeBtn.disabled = true;
    fileInfo.hidden = true;
    showError(msg);
  };

  const selectFile = (f) => {
    showError('');
    if (!f) return;
    if (!isSupported(f)) return rejectFile('Please choose an audio file (MP3, WAV, M4A, AAC, OGG, Opus, FLAC or WebM).');
    // Converted uploads are 16 kHz mono WAV, so only check the original size for MP3/WAV.
    if (engine() && f.size > maxBytes() && (engine() === 'device' || SERVER_EXT.test(f.name))) {
      return rejectFile(`File is too large (max ${Math.round(maxBytes() / 1024 / 1024)} MB).`);
    }
    selectedFile = f;
    fileInfo.textContent = `${f.name} (${fmtSize(f.size)})`;
    fileInfo.hidden = false;
    updateTranscribeLabel();
  };

  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    const entry = relinkEntry;
    relinkEntry = null;
    if (f && entry && f.name === entry.name && f.size === entry.size) return openEntry({ ...entry, audio: f }, true);
    selectFile(f);
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
    })
  );
  dropzone.addEventListener('drop', (e) => selectFile(e.dataTransfer.files[0]));

  // ---------- optional user transcript ----------
  let userText = null; // the user's own transcript, timed against the audio instead of Whisper's text
  let userLrc = null; // parsed .lrc file: its timings can be used directly, with no transcription
  let userLrcRaw = '';
  const lrcMode = () => document.querySelector('input[name="lrcMode"]:checked')?.value ?? 'file';

  /** Japanese .txt files are often Shift_JIS or UTF-16 rather than UTF-8. */
  const readTextFile = async (f) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('shift_jis').decode(bytes);
    }
  };

  // Opening an .lrc with its own timings transcribes nothing, so no engine is needed (or shown).
  const usesLrcTimings = () => !!userLrc && lrcMode() === 'file';
  const updateTranscribeLabel = () => {
    transcribeBtn.textContent = usesLrcTimings() ? 'Open with these timings' : userText ? 'Transcribe & time my transcript' : 'Transcribe';
    $('enginePicker').hidden = usesLrcTimings();
    transcribeBtn.disabled = !selectedFile || (!engine() && !usesLrcTimings());
  };

  /** `lrc`: the parsed file when it's timed lyrics; `text` is then its lines, for re-timing. */
  const setUserText = (text, name, lrc = null, raw = '') => {
    userText = text;
    userLrc = lrc;
    userLrcRaw = raw;
    textInfo.hidden = !text;
    textPickBtn.hidden = !!text;
    textHelp.hidden = !text || !!lrc;
    lrcModes.hidden = !lrc;
    if (lrc) $('textInfoText').textContent = `${name} · ${lrcToSegments(lrc).length} timed lines`;
    else if (text) $('textInfoText').textContent = `${name} · ${splitSentences(text).length} sentences`;
    updateTranscribeLabel();
  };
  for (const r of document.querySelectorAll('input[name="lrcMode"]')) r.addEventListener('change', updateTranscribeLabel);

  textPickBtn.addEventListener('click', () => textInput.click());
  textInput.addEventListener('change', async () => {
    const f = textInput.files[0];
    textInput.value = '';
    if (!f) return;
    showError('');
    const text = await readTextFile(f).catch(() => null);
    if (text && (/\.lrc$/i.test(f.name) || isTimedLrc(text))) {
      const lrc = parseLrc(text);
      const lines = lrc.lines.map((l) => l.text).filter(Boolean);
      if (!lines.length) return showError(`"${f.name}" doesn't contain any lyrics lines.`);
      // Untimed .lrc (no [mm:ss] tags) is just text: time it like a .txt transcript.
      if (!lrc.lines.length) return setUserText(lines.join('\n'), f.name);
      return setUserText(lines.join('\n'), f.name, lrc, text);
    }
    if (!text || !splitSentences(text).length) return showError(`"${f.name}" doesn't contain any sentences.`);
    setUserText(text, f.name);
  });
  $('textRemove').addEventListener('click', () => setUserText(null));

  // Short, stable fingerprint of a transcript, so each text gets its own history entry.
  const hashText = (text) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  };

  /**
   * An earlier Whisper run of this audio: plain, or kept inside an aligned entry. Prefers the
   * current model, but any model's run is fine for timing (e.g. transcribed on the computer).
   */
  const findWhisperResult = async (plainId, file) => {
    // Imported .lrc entries carry the file's timings, not a transcription, so they never count.
    const whisper = (e) =>
      e?.data?.imported ? null
      : e?.data?.aligned ? (e.data.asr?.length ? { segments: e.data.asr, duration: e.data.duration } : null)
      : e?.data?.segments?.length ? e.data : null;
    const exact = whisper(await getEntry(plainId).catch(() => null));
    if (exact) return exact;
    const all = await listHistory().catch(() => []);
    const same = (e) => e.name === file.name && e.size === file.size;
    return whisper(all.find((e) => e.plainId === plainId)) ?? all.filter(same).map(whisper).find(Boolean) ?? null;
  };

  /** Duration of an audio file from its metadata (no full decode). */
  const audioDuration = (file) =>
    new Promise((resolve) => {
      const a = new Audio();
      const url = URL.createObjectURL(file);
      const done = (d) => {
        URL.revokeObjectURL(url);
        resolve(d);
      };
      a.onloadedmetadata = () => done(a.duration);
      a.onerror = () => done(NaN);
      setTimeout(() => done(NaN), 5000);
      a.src = url;
    });

  /** Use an imported .lrc file's own timings: no transcription, just furigana. */
  const openWithLrc = async (file, lrc, raw) => {
    const id = `lrc:${file.name}:${file.size}:${file.lastModified}:${hashText(raw)}`;
    const saved = await getEntry(id).catch(() => null);
    if (saved && hasFurigana(saved.data)) return openEntry({ ...saved, audio: file }, !saved.audio);
    show(loadingView);
    preview.replaceChildren();
    setProgress(PHASES.furigana, '', null);
    try {
      const duration = await audioDuration(file);
      const segs = await furiganaOnDevice(lrcToSegments(lrc, duration), showJobProgress);
      const data = { segments: segs, text: segs.map((x) => x.text).join('\n'), duration, imported: 'lrc' };
      // The .lrc file's [ti:]/[ar:]/[al:] fill in for audio without its own tags.
      const lrcMeta = { title: lrc.meta.ti, artist: lrc.meta.ar, album: lrc.meta.al };
      await addToHistory(id, file, data, {}, lrcMeta);
    } catch (e) {
      show(uploadView);
      showError(`Couldn't open the lyrics: ${e.message}`);
    }
  };

  // ---------- transcription ----------
  transcribeBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    const file = selectedFile;
    if (usesLrcTimings()) return openWithLrc(file, userLrc, userLrcRaw);
    if (!engine()) return;
    const text = userText;

    const plainId = entryId(file);
    const id = text ? `${plainId}:text:${hashText(text)}` : plainId;
    const saved = await getEntry(id).catch(() => null);
    if (saved && hasFurigana(saved.data)) return openEntry({ ...saved, audio: file }, !saved.audio);

    const cached = !text && localStorage.getItem(legacyKey(file));
    if (cached) {
      localStorage.removeItem(legacyKey(file));
      try {
        const data = JSON.parse(cached);
        if (hasFurigana(data)) return addToHistory(id, file, data);
      } catch {
        /* corrupt entry – fall through and re-transcribe */
      }
    }

    // With a transcript, an earlier Whisper run of the same audio makes timing it instant.
    const earlier = text ? await findWhisperResult(plainId, file) : null;

    show(loadingView);
    const onDevice = engine() === 'device';
    setProgress(earlier ? PHASES.aligning : onDevice ? 'Reading audio…' : 'Uploading…', '', null);
    preview.replaceChildren();
    // Phones throttle or suspend pages whose screen turns off, which would stall the job.
    const wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
    try {
      let data;
      if (earlier) data = await alignOnDevice(file, earlier.segments, text, earlier.duration, showJobProgress);
      else if (onDevice) data = await transcribeOnDevice(file, deviceModel(), showJobProgress, { simulateGpuError, transcript: text });
      else {
        data = await uploadAndWait(file);
        // The server only transcribes; the timing of the user's text happens here in the browser.
        if (text) data = await alignOnDevice(file, data.segments, text, data.duration, showJobProgress);
      }
      // Don't keep results from a server without furigana support (e.g. one started
      // before an update), or that transcript would stay furigana-less.
      if (hasFurigana(data)) await addToHistory(id, file, data, text ? { plainId } : {});
      else showResult(file, data, await readMetadata(file));
    } catch (e) {
      show(uploadView);
      showError(`Transcription failed: ${e.message}`);
    } finally {
      wakeLock?.release();
      updateEngineUI(); // a GPU failure during this run shows up on the upload screen
    }
  });

  $('gpuRetry').addEventListener('click', () => {
    clearGpuFailure(deviceModel());
    updateEngineUI();
  });
  $('gpuCopy').addEventListener('click', async (e) => {
    const details = { model: modelName(), userAgent: navigator.userAgent, ...getGpuFailure(deviceModel()) };
    e.target.textContent = (await copyText(JSON.stringify(details, null, 2))) ? 'Copied' : 'Copy failed';
    setTimeout(() => (e.target.textContent = 'Copy details'), 1500);
  });

  const PHASES = {
    queued: 'Waiting in queue…',
    decoding: 'Reading audio…',
    'loading-model': 'Preparing speech recognition model…',
    transcribing: 'Transcribing…',
    furigana: 'Adding furigana…',
    aligning: 'Timing your transcript to the audio…',
  };

  const setProgress = (title, sub, ratio) => {
    phaseText.textContent = title;
    phaseSub.textContent = sub;
    bar.classList.toggle('indeterminate', ratio == null);
    barFill.style.width = ratio == null ? '' : `${Math.round(ratio * 100)}%`;
  };

  const renderPreview = (segs) => {
    for (let i = preview.children.length; i < segs.length; i++) {
      const li = document.createElement('li');
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = fmt(segs[i].start);
      const tx = document.createElement('span');
      tx.textContent = segs[i].text;
      li.append(ts, tx);
      preview.append(li);
      preview.scrollTop = preview.scrollHeight;
    }
  };

  const uploadAndWait = async (file) => {
    if (!SERVER_EXT.test(file.name)) {
      setProgress('Converting audio…', '', null);
      file = encodeWav(await decodeFile(file), file.name);
      if (file.size > server.maxUploadBytes) {
        throw new Error(`Recording is too long for the server (max ${Math.round(server.maxUploadBytes / 1024 / 1024)} MB as WAV).`);
      }
      setProgress('Uploading…', '', null);
    }
    const body = new FormData();
    body.append('audio', file);
    const res = await fetch('api/transcribe', { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);

    let failures = 0;
    for (;;) {
      await sleep(1000);
      let job;
      try {
        const r = await fetch(`api/jobs/${data.jobId}`);
        job = await r.json();
        if (!r.ok) throw new Error(job.error || `Server error (${r.status})`);
        failures = 0;
      } catch (e) {
        // Phones drop connections when the screen locks; tolerate a few misses.
        if (++failures >= 10) throw e;
        continue;
      }
      if (job.status === 'done') return job;
      if (job.status === 'error') throw new Error(job.error);
      showJobProgress(job.status === 'queued' ? { ...job, phase: 'queued' } : job);
    }
  };

  /** Progress display shared by the server (polled job) and on-device (worker updates) engines. */
  const showJobProgress = (job) => {
    const { phase } = job;
    const where = job.device ? ` · ${job.device === 'webgpu' ? 'GPU' : 'CPU'}` : '';
    let sub = '';
    let ratio = null;
    if (phase === 'queued') sub = `Position ${job.position}`;
    else if (phase === 'loading-model') {
      ratio = job.progress || null;
      sub = ratio >= 1 ? `Loading the model into memory…${where}` : `Downloading the model (first run only)${ratio ? ` – ${Math.round(ratio * 100)}%` : ''}`;
    } else if (phase === 'transcribing') {
      ratio = job.progress;
      const done = job.segments?.at(-1)?.end ?? 0;
      sub = job.duration ? `${fmt(done)} / ${fmt(job.duration)}${where}` : '';
    }
    if (job.notice) sub = sub ? `${job.notice} · ${sub}` : job.notice;
    setProgress(PHASES[phase] || 'Processing…', sub, ratio);
    if (job.segments) renderPreview(job.segments);
  };

  /** Render a sentence as ruby (kanji with hiragana above) when furigana data is available. */
  const renderSentence = (el, seg) => {
    if (!seg.ruby) {
      el.textContent = seg.text;
      return;
    }
    for (const [base, reading] of seg.ruby) {
      if (!reading) {
        el.append(base);
        continue;
      }
      const ruby = document.createElement('ruby');
      const rt = document.createElement('rt');
      rt.textContent = reading;
      ruby.append(base, rt);
      el.append(ruby);
    }
  };

  // ---------- history of transcribed files ----------
  const addToHistory = async (id, file, data, extra = {}, fallbackMeta = null) => {
    const { segments: segs, text, duration } = data;
    const fileMeta = await readMetadata(file);
    const fallback = Object.fromEntries(Object.entries(fallbackMeta ?? {}).filter(([, v]) => v));
    const meta = fileMeta || Object.keys(fallback).length ? { ...fallback, ...fileMeta } : null;
    const now = Date.now();
    const entry = {
      id,
      name: file.name,
      size: file.size,
      model: modelName(),
      meta,
      // Aligned entries keep Whisper's own segments, so the text can be re-timed without re-transcribing.
      data: {
        segments: segs,
        text,
        duration,
        ...(data.aligned && { aligned: true, asr: data.asr, matched: data.matched }),
        ...(data.imported && { imported: data.imported }),
      },
      audio: file,
      addedAt: now,
      playedAt: now,
      ...extra,
    };
    await saveEntry(entry).catch((e) => console.warn('Could not save to history:', e));
    showResult(file, data, meta);
  };

  /** Play a history entry. `storeAudio` re-saves the file when the entry didn't have it. */
  const openEntry = (entry, storeAudio = false) => {
    showResult(entry.audio, entry.data, entry.meta);
    const fields = { playedAt: Date.now() };
    if (storeAudio) fields.audio = entry.audio;
    touchEntry(entry.id, fields).catch(() => touchEntry(entry.id, { playedAt: fields.playedAt }).catch(() => {}));
  };

  const entryDuration = (e) => e.data.duration || e.data.segments?.at(-1)?.end || 0;
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  const renderRecent = async () => {
    recentEntries = await listHistory().catch(() => []);
    recentUrls.forEach(URL.revokeObjectURL);
    recentUrls = [];
    recentList.replaceChildren(
      ...recentEntries.map((e) => {
        const li = document.createElement('li');
        li.className = 'recent-item';
        const open = document.createElement('button');
        open.className = 'recent-open';
        open.dataset.id = e.id;
        const art = document.createElement(e.meta?.picture ? 'img' : 'span');
        art.className = 'recent-art';
        if (e.meta?.picture) {
          art.src = URL.createObjectURL(e.meta.picture);
          art.alt = '';
          recentUrls.push(art.src);
        } else {
          art.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z"/></svg>';
        }
        const text = document.createElement('span');
        text.className = 'recent-text';
        const title = document.createElement('b');
        title.textContent = e.meta?.title || e.name;
        const sub = document.createElement('small');
        const parts = [e.meta?.artist, fmt(entryDuration(e)), e.data.aligned && 'your transcript', e.data.imported === 'lrc' && 'from .lrc', fmtDate(e.playedAt)];
        if (!e.audio) parts.push('tap to choose the file');
        sub.textContent = parts.filter(Boolean).join(' · ');
        text.append(title, sub);
        open.append(art, text);
        const del = document.createElement('button');
        del.className = 'recent-del';
        del.dataset.del = e.id;
        del.setAttribute('aria-label', `Remove ${title.textContent}`);
        del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z"/></svg>';
        li.append(open, del);
        return li;
      })
    );
    const bytes = recentEntries.reduce((n, e) => n + (e.audio?.size ?? 0), 0);
    recentSize.textContent = bytes ? `· ${fmtSize(bytes)} stored` : '';
    recentView.hidden = uploadView.hidden || !recentEntries.length;
  };

  recentList.addEventListener('click', async (ev) => {
    const delId = ev.target.closest('[data-del]')?.dataset.del;
    if (delId) {
      const e = recentEntries.find((x) => x.id === delId);
      if (!confirm(`Remove "${e?.meta?.title || e?.name}"? Its transcript will be deleted.`)) return;
      await deleteEntry(delId).catch(() => {});
      return renderRecent();
    }
    const id = ev.target.closest('.recent-open')?.dataset.id;
    const entry = recentEntries.find((x) => x.id === id);
    if (!entry) return;
    if (entry.audio) return openEntry(entry);
    // The audio didn't fit in storage: ask for the file, then play it with the saved transcript.
    relinkEntry = entry;
    fileInput.click();
  });

  renderRecent();

  const showTrackInfo = (file, meta) => {
    trackTitle.textContent = meta?.title || file.name;
    trackTitle.title = file.name;
    trackArtist.textContent = meta?.artist || meta?.albumArtist || '';
    trackArtist.hidden = !trackArtist.textContent;
    trackAlbum.textContent = [meta?.album, meta?.track && `#${meta.track}`, meta?.year].filter(Boolean).join(' · ');
    trackAlbum.hidden = !trackAlbum.textContent;
    if (coverUrl) URL.revokeObjectURL(coverUrl);
    coverUrl = meta?.picture ? URL.createObjectURL(meta.picture) : null;
    cover.hidden = !coverUrl;
    if (coverUrl) cover.src = coverUrl;
    else cover.removeAttribute('src');

    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: trackTitle.textContent,
        artist: trackArtist.textContent,
        album: meta?.album || '',
        artwork: coverUrl ? [{ src: coverUrl, type: meta.picture.type }] : [],
      });
    }
  };

  const DEFAULT_HINT = hint.textContent;
  let current = null; // the file being played, for exporting its transcript

  const showResult = (file, data, meta) => {
    const approx = data.aligned ? (data.segments ?? []).filter((s) => s.approx).length : 0;
    hint.textContent = data.aligned
      ? `Your transcript, timed to the audio${approx ? ` · ${approx} approximate (≈)` : ''}. Tap a sentence to play it.`
      : data.imported === 'lrc'
        ? 'Timings from your .lrc file. Tap a sentence to play it.'
        : DEFAULT_HINT;
    current = { file, meta, duration: data.duration };
    segments = data.segments?.length
      ? data.segments
      : [{ start: 0, end: data.duration || Infinity, text: data.text || '' }];

    transcriptEl.replaceChildren();
    segEls = segments.map((s, i) => {
      const li = document.createElement('li');
      li.className = 'seg';
      li.dataset.idx = i;
      const ts = document.createElement('span');
      ts.className = s.approx ? 'ts approx' : 'ts';
      // ≈: the sentence couldn't be matched to the speech well, so its time is estimated.
      ts.textContent = (s.approx ? '≈' : '') + fmt(s.start);
      if (s.approx) ts.title = 'Approximate: this sentence could not be matched well to the audio';
      const tx = document.createElement('span');
      tx.className = 'tx';
      renderSentence(tx, s);
      li.append(ts, tx);
      transcriptEl.append(li);
      return li;
    });
    if (!segments.some((s) => s.text)) {
      transcriptEl.innerHTML = '<li class="muted" lang="en">No speech was detected in this recording.</li>';
      segEls = [];
    }

    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(file);
    audio.src = audioUrl;
    audio.playbackRate = 1;
    rateBtn.textContent = '1×';
    activeIdx = -1;
    setRepeat(false);

    showTrackInfo(file, meta);
    show(resultView);
    player.hidden = false;
    newBtn.hidden = false;
    document.body.classList.add('has-player');
    window.scrollTo({ top: 0 });
  };

  // ---------- transcript toggle (hidden by default, for listening practice) ----------
  const applyText = () => {
    const on = textToggle.checked;
    transcriptEl.hidden = hint.hidden = furiSwitch.hidden = !on;
    // Bring the current sentence into view when the text is shown again.
    if (on && segEls[activeIdx]) segEls[activeIdx].scrollIntoView({ block: 'center' });
  };
  textToggle.checked = localStorage.getItem(TEXT_PREF) === 'on';
  applyText();
  textToggle.addEventListener('change', () => {
    localStorage.setItem(TEXT_PREF, textToggle.checked ? 'on' : 'off');
    applyText();
  });

  // ---------- furigana toggle ----------
  const applyFurigana = () => transcriptEl.classList.toggle('no-furigana', !furiToggle.checked);
  furiToggle.checked = localStorage.getItem(FURIGANA_PREF) !== 'off';
  applyFurigana();
  furiToggle.addEventListener('change', () => {
    localStorage.setItem(FURIGANA_PREF, furiToggle.checked ? 'on' : 'off');
    applyFurigana();
  });

  // ---------- sentence lookup ----------
  const findSegment = (t) => {
    // Binary search for the last segment whose start <= t.
    let lo = 0, hi = segments.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  };

  // Where a sentence stops for looping: a little after its end, but never into the next one.
  const loopEnd = (i) => {
    const next = segments[i + 1]?.start ?? audio.duration;
    return Math.min(segments[i].end + 0.2, isFinite(next) ? next : Infinity);
  };

  // ---------- seeking & sentence navigation ----------
  /** All user-initiated seeks go through here so repeat mode follows the new position. */
  const seekTo = (t) => {
    cancelGap();
    audio.currentTime = Math.max(0, Math.min(t, audio.duration || t));
    userScrolledAt = 0;
    if (loopIdx >= 0) setLoopIdx(Math.max(0, findSegment(audio.currentTime)));
    updateActive();
  };

  const goToSentence = (i) => {
    if (!segments.length) return;
    i = Math.max(0, Math.min(segments.length - 1, i));
    seekTo(segments[i].start + 0.01);
    if (audio.paused) audio.play();
  };

  const prevSentence = () => goToSentence(findSegment(audio.currentTime) - 1);
  const nextSentence = () => {
    const i = findSegment(audio.currentTime) + 1;
    if (i < segments.length) goToSentence(i);
  };

  const setLoopIdx = (i) => {
    if (segEls[loopIdx]) segEls[loopIdx].classList.remove('repeating');
    loopIdx = i;
    if (segEls[loopIdx]) segEls[loopIdx].classList.add('repeating');
    updateGapNow();
  };

  // ---------- pause between repeats ----------
  // The pause scales with the sentence (time to say it back), but never drops below 1 s.
  const GAP_FACTORS = [0.5, 1, 1.5, 2];
  // Fractions rather than "0.5×" so this doesn't read like the playback-speed button.
  const GAP_LABELS = { 0.5: '½', 1: '1', 1.5: '1½', 2: '2' };
  const GAP_PREF = 'playit:repeat-gap';
  const MIN_GAP_SEC = 1;
  let gapFactor = GAP_FACTORS.includes(+localStorage.getItem(GAP_PREF)) ? +localStorage.getItem(GAP_PREF) : 1;

  const renderGapOpts = () => {
    gapOpts.replaceChildren(
      ...GAP_FACTORS.map((f) => {
        const b = document.createElement('button');
        b.className = 'gap-opt';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(f === gapFactor));
        b.textContent = GAP_LABELS[f];
        b.setAttribute('aria-label', `${GAP_LABELS[f]} × sentence length`);
        b.addEventListener('click', () => {
          gapFactor = f;
          localStorage.setItem(GAP_PREF, String(f));
          renderGapOpts();
        });
        return b;
      })
    );
    updateGapNow();
  };

  /** Pause before the repeated sentence plays again, in seconds. */
  const gapSeconds = () => {
    if (loopIdx < 0 || !segments[loopIdx]) return MIN_GAP_SEC;
    // Based on how long the sentence actually takes to hear, so slower playback pauses longer.
    const heard = (loopEnd(loopIdx) - segments[loopIdx].start) / audio.playbackRate;
    return Math.max(MIN_GAP_SEC, heard * gapFactor);
  };
  const updateGapNow = () => (gapNow.textContent = loopIdx >= 0 ? `${gapSeconds().toFixed(1)} s` : '');
  renderGapOpts();

  // The player grows while the pause row is shown; keep the transcript clear of it.
  new ResizeObserver(() => document.documentElement.style.setProperty('--player-h', `${player.offsetHeight}px`)).observe(player);

  const inGap = () => gapTimer !== null;

  const cancelGap = () => {
    if (!inGap()) return;
    clearTimeout(gapTimer);
    gapTimer = null;
    clearInterval(gapCountdown);
    updateGapNow();
    for (const el of transcriptEl.querySelectorAll('.seg.gap')) el.classList.remove('gap');
    syncPlayIcon();
  };

  /** End of one repeat: rewind, wait a pause proportional to the sentence, then replay. */
  const startGap = () => {
    const seg = segments[loopIdx];
    audio.pause();
    audio.currentTime = seg.start + 0.01;
    const gap = gapSeconds();
    const el = segEls[loopIdx];
    if (el) {
      el.style.setProperty('--gap', `${gap}s`);
      el.classList.remove('gap');
      void el.offsetWidth; // restart the fill animation
      el.classList.add('gap');
    }
    // Count down in the pause row too: it stays visible when the transcript text is hidden.
    const until = Date.now() + gap * 1000;
    const tickDown = () => (gapNow.textContent = `next in ${Math.max(0, (until - Date.now()) / 1000).toFixed(1)} s`);
    tickDown();
    gapCountdown = setInterval(tickDown, 100);
    gapTimer = setTimeout(() => {
      gapTimer = null;
      clearInterval(gapCountdown);
      updateGapNow();
      el?.classList.remove('gap');
      audio.play();
    }, gap * 1000);
    syncPlayIcon();
  };

  const setRepeat = (on) => {
    cancelGap();
    repeatBtn.setAttribute('aria-pressed', String(on));
    gapRow.hidden = !on;
    if (!on) return setLoopIdx(-1);
    const i = Math.max(0, findSegment(audio.currentTime));
    setLoopIdx(i);
    // Start the sentence from the top so the repeat is heard right away.
    audio.currentTime = segments[i].start + 0.01;
    if (audio.paused) audio.play();
  };

  const enforceLoop = () => {
    if (loopIdx < 0 || !segments[loopIdx] || inGap()) return;
    if (audio.currentTime >= loopEnd(loopIdx)) startGap();
    else if (audio.currentTime < segments[loopIdx].start - 0.5) audio.currentTime = segments[loopIdx].start + 0.01;
  };

  transcriptEl.addEventListener('click', (e) => {
    const li = e.target.closest('.seg');
    if (li) goToSentence(+li.dataset.idx);
  });

  // Pause auto-follow for a few seconds while the user is scrolling manually.
  const markUserScroll = () => (userScrolledAt = Date.now());
  window.addEventListener('touchmove', markUserScroll, { passive: true });
  window.addEventListener('wheel', markUserScroll, { passive: true });

  const updateActive = () => {
    if (!segEls.length) return;
    const idx = findSegment(audio.currentTime);
    if (idx === activeIdx) return;
    segEls.forEach((el, i) => {
      el.classList.toggle('active', i === idx);
      el.classList.toggle('past', i < idx);
    });
    activeIdx = idx;
    if (idx >= 0 && Date.now() - userScrolledAt > 3000) {
      segEls[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // ---------- player ----------
  const syncPlayIcon = () => {
    // During the pause between repeats the audio element is paused, but playback is still "on".
    const playing = !audio.paused || inGap();
    // SVG elements have no .hidden property, so toggle the attribute directly.
    playIcon.toggleAttribute('hidden', playing);
    pauseIcon.toggleAttribute('hidden', !playing);
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };

  audio.addEventListener('loadedmetadata', () => {
    seek.max = audio.duration;
    durTime.textContent = fmt(audio.duration);
  });
  audio.addEventListener('timeupdate', () => {
    enforceLoop();
    if (!seeking) seek.value = audio.currentTime;
    curTime.textContent = fmt(audio.currentTime);
    updateActive();
  });
  audio.addEventListener('play', syncPlayIcon);
  audio.addEventListener('pause', syncPlayIcon);
  audio.addEventListener('ended', () => {
    // The last sentence's loop end can be past the end of the file.
    if (loopIdx >= 0 && !inGap()) startGap();
    syncPlayIcon();
  });

  // timeupdate fires only ~4x/sec; use rAF while playing for snappier highlighting and looping.
  const tick = () => {
    if (!audio.paused) {
      enforceLoop();
      updateActive();
      requestAnimationFrame(tick);
    }
  };
  audio.addEventListener('play', () => requestAnimationFrame(tick));

  const togglePlay = () => {
    if (inGap()) cancelGap(); // pausing during the pause between repeats stops the repeat cycle here
    else if (audio.paused) audio.play();
    else audio.pause();
  };
  playBtn.addEventListener('click', togglePlay);
  prevBtn.addEventListener('click', prevSentence);
  nextBtn.addEventListener('click', nextSentence);
  repeatBtn.addEventListener('click', () => setRepeat(loopIdx < 0));
  rateBtn.addEventListener('click', () => {
    const next = RATES[(RATES.indexOf(audio.playbackRate) + 1) % RATES.length] ?? 1;
    audio.playbackRate = next;
    rateBtn.textContent = `${next}×`;
    updateGapNow();
  });

  seek.addEventListener('input', () => {
    seeking = true;
    curTime.textContent = fmt(+seek.value);
  });
  seek.addEventListener('change', () => {
    seeking = false;
    seekTo(+seek.value);
  });

  // Lock-screen / headset buttons on phones jump by sentence.
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('previoustrack', prevSentence);
    navigator.mediaSession.setActionHandler('nexttrack', nextSentence);
  }

  // Keyboard shortcuts for desktop: space = play/pause, ←/→ = sentence, R = repeat.
  document.addEventListener('keydown', (e) => {
    if (player.hidden || e.target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') togglePlay();
    else if (e.key === 'ArrowLeft') prevSentence();
    else if (e.key === 'ArrowRight') nextSentence();
    else if (e.key === 'r' || e.key === 'R') setRepeat(loopIdx < 0);
    else return;
    e.preventDefault();
  });

  // ---------- reset / copy ----------
  newBtn.addEventListener('click', () => {
    audio.pause();
    setUserText(null); // a transcript belongs to one recording
    setRepeat(false);
    player.hidden = true;
    newBtn.hidden = true;
    document.body.classList.remove('has-player');
    fileInput.value = '';
    selectedFile = null;
    fileInfo.hidden = true;
    transcribeBtn.disabled = true;
    showError('');
    show(uploadView);
    renderRecent();
  });

  /** Copy text to the clipboard; returns whether it worked. */
  const copyText = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      // Plain http over the LAN (e.g. from a phone) has no Clipboard API.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  };

  // ---------- export as .lrc (synced lyrics) ----------
  exportBtn.addEventListener('click', async () => {
    if (!current || !segments.length) return;
    const base = current.file.name.replace(/\.[^.]+$/, '');
    const lrc = buildLrc(segments, {
      title: current.meta?.title || base,
      artist: current.meta?.artist,
      album: current.meta?.album,
      duration: Number.isFinite(audio.duration) ? audio.duration : current.duration,
    });
    // Same base name as the audio, so music players pick the lyrics up automatically.
    const file = new File([lrc], `${base}.lrc`, { type: 'text/plain' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        // On phones this opens the share sheet: save to Files, or send to a music app.
        await navigator.share({ files: [file], title: file.name });
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return; // the user closed the share sheet
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    exportBtn.textContent = 'Saved';
    setTimeout(() => (exportBtn.textContent = 'Export'), 1500);
  });

  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(segments.map((s) => s.text).join('\n'));
    copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
  });

  // ---------- offline support ----------
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').then(() => {
      // Static hosts can't send the isolation headers multi-threaded WASM needs; the service
      // worker adds them, but only to pages it serves. On the first visit, reload once.
      if (window.crossOriginIsolated || sessionStorage.getItem('playit:coi-reload')) return;
      navigator.serviceWorker.ready.then(() => {
        sessionStorage.setItem('playit:coi-reload', '1');
        location.reload();
      });
    });
  }
})();
