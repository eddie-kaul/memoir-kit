// Parent Journal — front-end. Deliberately small and forgiving.
// One screen, one big button, audio prompts, autosave, resume — plus an
// optional "Add a memory" recorder and a gentle two-level topic browser.

(() => {
  'use strict';

  // ---- token from /d/<token>  (also accept ?token= as a fallback) ----------
  const parts = location.pathname.split('/').filter(Boolean);
  const pathToken = parts[0] === 'd' && parts[1] ? parts[1] : null;
  const queryToken = new URLSearchParams(location.search).get('token');
  const TOKEN = pathToken || queryToken;

  // ---- elements -------------------------------------------------------------
  const el = (id) => document.getElementById(id);
  const screens = {
    loading: el('loading-screen'),
    start: el('start-screen'),
    main: el('main-screen'),
    topics: el('topics-screen'),
    questions: el('questions-screen'),
    memory: el('memory-screen'),
    done: el('done-screen'),
    error: el('error-screen'),
  };
  const player = el('player');

  let prompt = null; // { text, audioUrl, isFollowUp }
  let activeStream = null;
  let QUESTIONS = []; // for the browser
  let homeScreen = 'main'; // where "Back" returns to

  // ---- screen helpers -------------------------------------------------------
  function show(name) {
    Object.values(screens).forEach((s) => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
  }
  const setStatus = (t) => (el('status').textContent = t || '');
  const memStatus = (t) => (el('memory-status').textContent = t || '');

  function showError(msg) {
    el('error-msg').textContent = msg || '';
    show('error');
  }

  // ---- audio playback (with speech-synthesis fallback) ----------------------
  function speakFallback(text) {
    try {
      if (!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.9;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (_) {}
  }

  async function playPrompt() {
    if (!prompt) return;
    if (prompt.audioUrl) {
      try {
        player.src = prompt.audioUrl;
        await player.play();
        return;
      } catch (_) {}
    }
    speakFallback(prompt.text);
  }

  // Record button reads "record more" when this question already has an answer.
  function setRecordLabel() {
    el('record-btn').textContent =
      prompt && prompt.answered ? 'Record more to your previous answer' : 'Tap to answer';
  }

  // ---- render the current question prompt -----------------------------------
  function renderPrompt(state) {
    if (state.done) {
      show('done');
      return;
    }
    prompt = state.prompt;
    el('question-text').textContent = prompt.text;
    const p = state.progress;
    el('progress').textContent = p ? `Question ${p.current} of ${p.total}` : '';
    setRecordLabel();
    el('record-btn').classList.remove('recording');
    el('indicator').classList.add('hidden');
    setStatus('');
    show('main');
  }

  // ---- Previous / Next (move without recording) -----------------------------
  async function navigate(dir) {
    if (recording) return;
    setStatus(dir === 'prev' ? 'Going back…' : 'Moving on…');
    try {
      const res = await fetch('/api/' + dir, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN }),
      });
      if (!res.ok) throw new Error('nav failed');
      const next = await res.json();
      if (next.done) {
        show('done');
        return;
      }
      renderPrompt(next);
      await playPrompt();
    } catch (_) {
      setStatus('Sorry, I could not move just now. Please try again.');
    }
  }

  // ---- recording (shared by the answer flow and the memory flow) ------------
  let recorder = null;
  let chunks = [];
  let recording = false;
  let mimeType = '';
  let recCtx = null;
  let autosaveTimer = null;

  function pickMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', ''];
    for (const c of candidates) {
      if (c === '' || (window.MediaRecorder && MediaRecorder.isTypeSupported(c))) return c;
    }
    return '';
  }

  // Always acquire a FRESH mic stream — reusing one can hand back an 'ended'
  // track (after the device released the mic, e.g. once the TTS played), which
  // records silence/empty files. We release it after each recording.
  function getFreshStream() {
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
  function stopStream() {
    if (activeStream) {
      activeStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      activeStream = null;
    }
  }

  function blobNow() {
    return new Blob(chunks, { type: mimeType || 'audio/webm' });
  }

  async function startRec(ctx) {
    // Stop the spoken question immediately so it doesn't bleed into the mic and
    // so its "ended" event can't interrupt/stop the recorder.
    try { player.pause(); player.currentTime = 0; } catch (_) {}
    let s;
    try {
      s = await getFreshStream();
    } catch (_) {
      ctx.setStatus('I could not reach the microphone. Please allow it, then tap again.');
      return;
    }
    activeStream = s;
    recCtx = ctx;
    mimeType = pickMime();
    chunks = [];
    recorder = mimeType ? new MediaRecorder(s, { mimeType }) : new MediaRecorder(s);
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
        if (ctx.autosave) autosave();
      }
    };
    // Build the blob, release the mic, then hand off for upload.
    recorder.onstop = () => { const b = blobNow(); stopStream(); ctx.onStop(b); };
    // No timeslice: the whole recording is delivered as one dataavailable right
    // before onstop — reliable across browsers (timeslice could deliver the last
    // chunk after onstop, producing an empty blob).
    recorder.start();
    // Periodic autosave flush for answers (belt-and-braces against a dropped tab).
    if (ctx.autosave) {
      autosaveTimer = setInterval(() => {
        try { recorder.requestData(); } catch (_) {}
      }, 8000);
    }
    recording = true;
    ctx.btn.textContent = 'Tap when finished';
    ctx.btn.classList.add('recording');
    ctx.indicator.classList.remove('hidden');
    ctx.setStatus('');
  }

  function stopRec() {
    if (recorder && recording) {
      recording = false;
      if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; }
      recCtx.indicator.classList.add('hidden');
      recCtx.btn.classList.remove('recording');
      recCtx.setStatus(recCtx.savingLabel || 'Saving…');
      try { recorder.stop(); } catch (_) {}
    }
  }

  // Periodic autosave of the in-progress answer (belt-and-braces).
  function autosave() {
    if (!chunks.length) return;
    const fd = new FormData();
    fd.append('token', TOKEN);
    fd.append('audio', blobNow(), 'autosave');
    fetch('/api/autosave', { method: 'POST', body: fd }).catch(() => {});
  }

  const answerCtx = {
    btn: el('record-btn'),
    indicator: el('indicator'),
    setStatus,
    autosave: true,
    savingLabel: 'Saving your answer…',
    onStop: uploadAnswer,
  };
  const memoryCtx = {
    btn: el('memory-record-btn'),
    indicator: el('memory-indicator'),
    setStatus: memStatus,
    autosave: false,
    savingLabel: 'Saving…',
    onStop: uploadExtra,
  };

  async function uploadAnswer(blob) {
    if (!blob || blob.size === 0) {
      setStatus('I didn’t catch any sound — please tap the button and try again.');
      setRecordLabel();
      return;
    }
    const fd = new FormData();
    fd.append('token', TOKEN);
    fd.append('audio', blob, 'answer');
    try {
      const res = await fetch('/api/answer', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('save failed');
      const next = await res.json();
      setStatus(next.ack || 'Got that, thank you.');
      setTimeout(async () => {
        if (next.done) {
          show('done');
          return;
        }
        renderPrompt(next);
        await playPrompt();
      }, 900);
    } catch (_) {
      setStatus('That didn’t save properly — please tap and record your answer again.');
      setRecordLabel();
    }
  }

  async function uploadExtra(blob) {
    if (!blob || blob.size === 0) {
      memStatus('I didn’t catch any sound — please tap and try again.');
      el('memory-record-btn').textContent = 'Tap to record';
      return;
    }
    const fd = new FormData();
    fd.append('token', TOKEN);
    fd.append('audio', blob, 'memory');
    try {
      const res = await fetch('/api/extra', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('save failed');
      const out = await res.json();
      memStatus(out.ack || 'Saved — thank you.');
      el('memory-record-btn').textContent = 'Record another';
    } catch (_) {
      memStatus('I saved your recording but had trouble. You can try again.');
      el('memory-record-btn').textContent = 'Tap to record';
    }
  }

  // ---- topic browser --------------------------------------------------------
  async function openBrowse() {
    show('topics');
    el('topics-list').innerHTML = '<p class="status">Loading…</p>';
    try {
      const res = await fetch(`/api/questions?token=${encodeURIComponent(TOKEN)}`);
      const data = await res.json();
      QUESTIONS = data.questions || [];
      renderTopics();
    } catch (_) {
      el('topics-list').innerHTML = '<p class="status">Could not load the topics just now.</p>';
    }
  }

  function renderTopics() {
    const order = [];
    const map = {};
    for (const q of QUESTIONS) {
      if (!map[q.theme]) {
        map[q.theme] = { theme: q.theme, total: 0, answered: 0 };
        order.push(map[q.theme]);
      }
      map[q.theme].total++;
      if (q.answered) map[q.theme].answered++;
    }
    const list = el('topics-list');
    list.innerHTML = '';
    for (const t of order) {
      const b = document.createElement('button');
      b.className = 'list-btn' + (t.answered === t.total ? ' answered' : '');
      b.innerHTML = `${t.theme}<span class="sub">${t.answered} of ${t.total} answered</span>`;
      b.addEventListener('click', () => openTopic(t.theme));
      list.appendChild(b);
    }
  }

  function openTopic(theme) {
    el('questions-title').textContent = theme;
    const list = el('questions-list');
    list.innerHTML = '';
    for (const q of QUESTIONS.filter((x) => x.theme === theme)) {
      const b = document.createElement('button');
      b.className = 'list-btn' + (q.answered ? ' answered' : '');
      b.innerHTML = `${q.answered ? '<span class="tick">✓</span>' : ''}${q.seed_text}`;
      b.addEventListener('click', () => gotoQuestion(q.id));
      list.appendChild(b);
    }
    show('questions');
  }

  async function gotoQuestion(qid) {
    try {
      const res = await fetch('/api/goto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, questionId: qid }),
      });
      if (!res.ok) throw new Error('goto failed');
      const state = await res.json();
      renderPrompt(state);
      await playPrompt();
    } catch (_) {
      openTopic(el('questions-title').textContent); // stay put on failure
    }
  }

  function openMemory(from) {
    homeScreen = from;
    el('memory-record-btn').textContent = 'Tap to record';
    memStatus('');
    show('memory');
  }

  // ---- wiring ---------------------------------------------------------------
  el('record-btn').addEventListener('click', () => (recording ? stopRec() : startRec(answerCtx)));
  el('memory-record-btn').addEventListener('click', () => (recording ? stopRec() : startRec(memoryCtx)));
  el('replay-btn').addEventListener('click', playPrompt);
  el('prev-btn').addEventListener('click', () => navigate('prev'));
  el('next-btn').addEventListener('click', () => navigate('next'));
  el('retry-btn').addEventListener('click', () => location.reload());

  el('memory-btn').addEventListener('click', () => openMemory('main'));
  el('browse-btn').addEventListener('click', () => { homeScreen = 'main'; openBrowse(); });
  el('done-memory-btn').addEventListener('click', () => openMemory('done'));
  el('done-browse-btn').addEventListener('click', () => { homeScreen = 'done'; openBrowse(); });

  el('topics-back').addEventListener('click', () => show(homeScreen));
  el('questions-back').addEventListener('click', () => show('topics'));
  el('memory-back').addEventListener('click', () => show(homeScreen));

  el('start-btn').addEventListener('click', async () => {
    try { player.load(); } catch (_) {}
    setRecordLabel();
    show('main');
    await playPrompt();
    // Ask for mic permission early, then release it (we re-acquire per recording).
    try { const s = await getFreshStream(); s.getTracks().forEach((t) => t.stop()); } catch (_) {}
  });

  // ---- boot -----------------------------------------------------------------
  async function boot() {
    if (!TOKEN)
      return showError(
        'This link looks incomplete. Please use the link that was sent to you. ' +
          `(seen: ${location.pathname}${location.search} · build v2)`
      );
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      return showError('This phone’s browser cannot record audio. Try opening the link in Safari or Chrome.');
    }
    try {
      const res = await fetch(`/api/state?token=${encodeURIComponent(TOKEN)}`);
      if (!res.ok) throw new Error('state');
      const state = await res.json();
      el('greeting').textContent = `Hello${state.user && state.user.name ? ', ' + state.user.name : ''}`;
      if (state.done) return show('done');
      prompt = state.prompt;
      el('question-text').textContent = prompt ? prompt.text : '';
      el('progress').textContent = state.progress
        ? `Question ${state.progress.current} of ${state.progress.total}`
        : '';
      show('start');
    } catch (_) {
      showError('I could not load your questions just now. Please try again in a moment.');
    }
  }

  boot();
})();
