import { DEVICE_MODELS, modelTag, deviceUnsupportedReason, hasWebGPU, transcribeOnDevice, decodeFile, encodeWav } from './device/engine.js';
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

  const updateEngineUI = () => {
    deviceModelsEl.hidden = engine() !== 'device';
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
    transcribeBtn.disabled = !engine();
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

  // ---------- transcription ----------
  transcribeBtn.addEventListener('click', async () => {
    if (!selectedFile || !engine()) return;
    const file = selectedFile;

    const id = entryId(file);
    const saved = await getEntry(id).catch(() => null);
    if (saved && hasFurigana(saved.data)) return openEntry({ ...saved, audio: file }, !saved.audio);

    const cached = localStorage.getItem(legacyKey(file));
    if (cached) {
      localStorage.removeItem(legacyKey(file));
      try {
        const data = JSON.parse(cached);
        if (hasFurigana(data)) return addToHistory(id, file, data);
      } catch {
        /* corrupt entry – fall through and re-transcribe */
      }
    }

    show(loadingView);
    const onDevice = engine() === 'device';
    setProgress(onDevice ? 'Reading audio…' : 'Uploading…', '', null);
    preview.replaceChildren();
    // Phones throttle or suspend pages whose screen turns off, which would stall the job.
    const wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
    try {
      const data = onDevice
        ? await transcribeOnDevice(file, deviceModel(), showJobProgress)
        : await uploadAndWait(file);
      // Don't keep results from a server without furigana support (e.g. one started
      // before an update), or that transcript would stay furigana-less.
      if (hasFurigana(data)) await addToHistory(id, file, data);
      else showResult(file, data, await readMetadata(file));
    } catch (e) {
      show(uploadView);
      showError(`Transcription failed: ${e.message}`);
    } finally {
      wakeLock?.release();
    }
  });

  const PHASES = {
    queued: 'Waiting in queue…',
    decoding: 'Reading audio…',
    'loading-model': 'Preparing speech recognition model…',
    transcribing: 'Transcribing…',
    furigana: 'Adding furigana…',
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
  const addToHistory = async (id, file, data) => {
    const { segments: segs, text, duration } = data;
    const meta = await readMetadata(file);
    const now = Date.now();
    const entry = {
      id,
      name: file.name,
      size: file.size,
      model: modelName(),
      meta,
      data: { segments: segs, text, duration },
      audio: file,
      addedAt: now,
      playedAt: now,
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
        const parts = [e.meta?.artist, fmt(entryDuration(e)), fmtDate(e.playedAt)];
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

  const showResult = (file, data, meta) => {
    segments = data.segments?.length
      ? data.segments
      : [{ start: 0, end: data.duration || Infinity, text: data.text || '' }];

    transcriptEl.replaceChildren();
    segEls = segments.map((s, i) => {
      const li = document.createElement('li');
      li.className = 'seg';
      li.dataset.idx = i;
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = fmt(s.start);
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
  };

  const setRepeat = (on) => {
    repeatBtn.setAttribute('aria-pressed', String(on));
    if (!on) return setLoopIdx(-1);
    const i = Math.max(0, findSegment(audio.currentTime));
    setLoopIdx(i);
    // Start the sentence from the top so the repeat is heard right away.
    audio.currentTime = segments[i].start + 0.01;
    if (audio.paused) audio.play();
  };

  const enforceLoop = () => {
    if (loopIdx < 0 || !segments[loopIdx]) return;
    if (audio.currentTime >= loopEnd(loopIdx) || audio.currentTime < segments[loopIdx].start - 0.5) {
      audio.currentTime = segments[loopIdx].start + 0.01;
    }
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
    const playing = !audio.paused;
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
    if (loopIdx >= 0) {
      audio.currentTime = segments[loopIdx].start + 0.01;
      audio.play();
    }
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

  const togglePlay = () => (audio.paused ? audio.play() : audio.pause());
  playBtn.addEventListener('click', togglePlay);
  prevBtn.addEventListener('click', prevSentence);
  nextBtn.addEventListener('click', nextSentence);
  repeatBtn.addEventListener('click', () => setRepeat(loopIdx < 0));
  rateBtn.addEventListener('click', () => {
    const next = RATES[(RATES.indexOf(audio.playbackRate) + 1) % RATES.length] ?? 1;
    audio.playbackRate = next;
    rateBtn.textContent = `${next}×`;
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

  copyBtn.addEventListener('click', async () => {
    const text = segments.map((s) => s.text).join('\n');
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Plain http over the LAN (e.g. from a phone) has no Clipboard API.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('copy failed');
      }
      copyBtn.textContent = 'Copied';
    } catch {
      copyBtn.textContent = 'Copy failed';
    }
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
