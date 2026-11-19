// Parent Journal — Cloudflare Worker.
// Serves the elderly-first SPA and the API that ties together R2 (audio),
// D1 (transcripts/state), OpenAI (Whisper + TTS), and Claude (the interviewer).

import * as store from './storage.js';
import { transcribe, transcribeDetailed, synthesize } from './openai.js';
import { decideNext, MAX_FOLLOWUPS } from './claude.js';
import { buildMemoirHTML } from './memoir.js';

export default {
  // Nightly (18:00 UTC): regenerate the memoir doc, back up audio & doc to the
  // second bucket, then run the data-safety audit so any orphaned recording is
  // caught the same night. Both share this one cron — no extra schedule.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNightly(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // ---- API -------------------------------------------------------------
      if (pathname.startsWith('/api/')) {
        if (pathname.startsWith('/api/audio/')) return serveAudio(request, env, pathname);
        if (pathname === '/api/state') return apiState(request, env, url);
        if (pathname === '/api/answer') return apiAnswer(request, env);
        if (pathname === '/api/autosave') return apiAutosave(request, env);
        if (pathname === '/api/questions') return apiQuestions(request, env, url);
        if (pathname === '/api/goto') return apiGoto(request, env);
        if (pathname === '/api/next') return apiNav(request, env, 'next');
        if (pathname === '/api/prev') return apiNav(request, env, 'prev');
        if (pathname === '/api/extra') return apiExtra(request, env);
        if (pathname === '/api/export') return apiExport(request, env, url);
        if (pathname === '/api/admin/seed') return apiSeed(request, env);
        if (pathname === '/api/admin/r2list') return apiR2List(request, env, url);
        if (pathname === '/api/admin/audit') return apiAudit(request, env, url);
        if (pathname === '/api/admin/relink') return apiRelink(request, env, url);
        if (pathname === '/api/admin/retranscribe') return apiRetranscribe(request, env, url);
        if (pathname === '/api/admin/import') return apiImport(request, env, url);
        if (pathname === '/api/admin/run-backup') return apiRunBackup(request, env, url);
        return json({ error: 'not found' }, 404);
      }

      // ---- Family review page (admin-gated): listen + read everything ------
      if (pathname === '/review') return apiReview(request, env, url);

      // ---- Memoir document (admin-gated): read/print the compiled story -----
      if (pathname === '/memoir') return apiMemoir(request, env, url);

      // ---- The link the parent taps: serve the SPA shell -------------------
      if (pathname.startsWith('/d/')) {
        return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
      }

      // ---- Static assets (/, /app.js, /styles.css, ...) -------------------
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      return json({ error: 'server error', detail: String(err && err.message || err) }, 500);
    }
  },
};

/* ------------------------------------------------------------------ helpers */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const audioUrl = (key) => (key ? `/api/audio/${key}` : null);
const extFor = (type = '') =>
  type.includes('mp4') ? 'mp4' : type.includes('mpeg') ? 'mp3' : type.includes('ogg') ? 'ogg' : 'webm';

function progressFor(question, total, done) {
  if (done) return { current: total, total };
  return { current: (question ? question.order_index : 0) + 1, total };
}

// Ensure a follow-up prompt has audio; synthesize + cache on the fly if missing.
// Audio failures must never block the flow — fall back to null (the app then
// uses the phone's built-in voice).
async function ensurePromptAudio(env, user, session) {
  if (session.current_prompt_key || !session.current_prompt_text) return session.current_prompt_key;
  try {
    const bytes = await synthesize(env, session.current_prompt_text, user.voice);
    const key = `tts/${user.id}/${session.id}-${store.uid()}.mp3`;
    await store.putAudio(env, key, bytes, 'audio/mpeg');
    await store.updateSession(env, session.id, { current_prompt_key: key });
    return key;
  } catch (e) {
    console.error('prompt audio gen failed', e && e.stack ? e.stack : e);
    return null;
  }
}

// Ensure a seed question has audio, cached on the question row (regenerated when
// its wording changed during a reseed, which clears audio_key). Never throws.
async function ensureQuestionAudio(env, user, question) {
  if (question.audio_key) return question.audio_key;
  try {
    const bytes = await synthesize(env, question.seed_text, user.voice);
    const key = `tts/${user.id}/q${question.order_index}-${store.uid()}.mp3`;
    await store.putAudio(env, key, bytes, 'audio/mpeg');
    await store.setQuestionAudio(env, question.id, key);
    return key;
  } catch (e) {
    console.error('question audio gen failed', e && e.stack ? e.stack : e);
    return null; // app falls back to the phone's built-in voice
  }
}

// Move the session to the next question. In linear mode the resume bookmark moves
// with the view; in a topic-browse detour the bookmark stays put and we walk
// forward (or return to the bookmark at the end). Shared by answering and skipping.
async function advanceFrom(env, user, session, question, isLinear, total, ack) {
  const next = await store.getNextQuestion(env, user.id, question.order_index);

  if (isLinear) {
    if (!next) {
      await store.updateSession(env, session.id, {
        status: 'done',
        current_question_id: null,
        resume_question_id: null,
        current_prompt_text: null,
        current_prompt_key: null,
        current_is_follow_up: 0,
      });
      return json({ done: true, ack: ack ?? 'Thank you — that was wonderful.', progress: { current: total, total } });
    }
    const nextKey = await ensureQuestionAudio(env, user, next);
    await store.updateSession(env, session.id, {
      current_question_id: next.id,
      resume_question_id: next.id,
      follow_up_index: 0,
      current_prompt_text: next.seed_text,
      current_prompt_key: nextKey,
      current_is_follow_up: 0,
    });
    return json({
      done: false,
      ack: ack ?? 'Got that, thank you.',
      prompt: { text: next.seed_text, audioUrl: audioUrl(nextKey), isFollowUp: false, answered: await store.hasAnswer(env, user.id, next.id) },
      progress: progressFor(next, total, false),
    });
  }

  // Topic-browse detour: keep the bookmark; walk forward, else return to bookmark.
  const target = next || (await store.getQuestionById(env, session.resume_question_id));
  if (!target) return json({ done: true, ack: ack ?? 'Thank you.', progress: { current: total, total } });
  const tKey = await ensureQuestionAudio(env, user, target);
  await store.updateSession(env, session.id, {
    current_question_id: target.id,
    follow_up_index: 0,
    current_prompt_text: target.seed_text,
    current_prompt_key: tKey,
    current_is_follow_up: 0,
  });
  return json({
    done: false,
    ack: ack ?? 'Got that, thank you.',
    prompt: { text: target.seed_text, audioUrl: audioUrl(tKey), isFollowUp: false, answered: await store.hasAnswer(env, user.id, target.id) },
    progress: progressFor(target, total, false),
  });
}

// Move to the previous question (Previous button). In linear mode the bookmark
// moves back too; in a detour only the view moves.
async function prevFrom(env, user, session, question, isLinear, total) {
  const prev = await store.getPrevQuestion(env, user.id, question.order_index);
  const target = prev || question; // already at the first — re-show it
  const key = await ensureQuestionAudio(env, user, target);
  const fields = {
    current_question_id: target.id,
    follow_up_index: 0,
    current_prompt_text: target.seed_text,
    current_prompt_key: key,
    current_is_follow_up: 0,
  };
  if (isLinear) fields.resume_question_id = target.id;
  await store.updateSession(env, session.id, fields);
  return json({
    done: false,
    prompt: { text: target.seed_text, audioUrl: audioUrl(key), isFollowUp: false, answered: await store.hasAnswer(env, user.id, target.id) },
    progress: progressFor(target, total, false),
  });
}

/* -------------------------------------------------------------- GET /api/audio */

async function serveAudio(request, env, pathname) {
  const key = decodeURIComponent(pathname.slice('/api/audio/'.length));
  const obj = await store.getAudioObject(env, key);
  if (!obj) return json({ error: 'audio not found' }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'public, max-age=86400');
  if (!headers.get('content-type')) headers.set('content-type', 'audio/mpeg');
  return new Response(obj.body, { headers });
}

/* -------------------------------------------------------------- GET /api/state */

async function apiState(request, env, url) {
  const token = url.searchParams.get('token');
  const user = token && (await store.getUserByToken(env, token));
  if (!user) return json({ error: 'unknown link' }, 404);

  const total = await store.countQuestions(env, user.id);
  const session = await store.getOrCreateActiveSession(env, user.id);

  if (session.status === 'done') {
    return json({ done: true, user: { name: user.display_name }, progress: { current: total, total } });
  }

  // Resume at the LINEAR bookmark — not wherever a topic-browse detour left off.
  const rid = session.resume_question_id || session.current_question_id;
  let question = rid ? await store.getQuestionById(env, rid) : null;
  if (!question) {
    const qs = await store.getQuestionsForUser(env, user.id);
    if (!qs.length) {
      return json({ done: true, user: { name: user.display_name }, progress: { current: total, total } });
    }
    question = qs[0];
  }

  // Snap the live view and the bookmark back to this linear question.
  await store.updateSession(env, session.id, {
    current_question_id: question.id,
    resume_question_id: question.id,
    follow_up_index: 0,
    current_prompt_text: question.seed_text,
    current_prompt_key: question.audio_key || null,
    current_is_follow_up: 0,
  });

  // Audio generation must never block loading — fall back to null (the app then
  // uses the phone's built-in voice).
  let key = null;
  try {
    key = await ensureQuestionAudio(env, user, question);
  } catch (e) {
    console.error('prompt audio generation failed', e && e.stack ? e.stack : e);
  }

  return json({
    done: false,
    user: { name: user.display_name },
    prompt: { text: question.seed_text, audioUrl: audioUrl(key), isFollowUp: false, answered: await store.hasAnswer(env, user.id, question.id) },
    progress: progressFor(question, total, false),
  });
}

/* ------------------------------------------------------------- POST /api/answer */

async function apiAnswer(request, env) {
  const form = await request.formData();
  const token = form.get('token');
  const file = form.get('audio');
  if (!token || !file || typeof file === 'string') {
    return json({ error: 'token and audio required' }, 400);
  }

  const user = await store.getUserByToken(env, token);
  if (!user) return json({ error: 'unknown link' }, 404);

  const session = await store.getOrCreateActiveSession(env, user.id);
  if (!session.current_question_id) return json({ done: true });
  const question = await store.getQuestionById(env, session.current_question_id);

  // 1) Persist the raw audio (this IS the durable save).
  const buf = await file.arrayBuffer();
  // Safety net: never store a blank answer or advance past it. The speaker
  // simply re-records. (Frontend also guards, but this is the last line.)
  if (!buf || buf.byteLength === 0) {
    return json({ error: 'empty audio', empty: true }, 400);
  }
  const ext = extFor(file.type);
  const audioKey =
    `audio/${user.id}/${session.id}/${question.order_index}-fu${session.follow_up_index}-${store.uid()}.${ext}`;
  await store.putAudio(env, audioKey, buf, file.type || 'audio/webm');

  // 2) Transcribe.
  let text = '';
  try {
    text = await transcribe(env, buf, file.type || 'audio/webm');
  } catch (e) {
    console.error('transcribe error', e);
    text = ''; // keep the audio even if transcription fails
  }

  // 3) Record the answer.
  await store.addEntry(env, {
    user_id: user.id,
    session_id: session.id,
    question_id: question.id,
    role: 'answer',
    text,
    audio_key: audioKey,
    is_follow_up: session.current_is_follow_up,
    follow_up_index: session.follow_up_index,
  });

  // 4) Ask Claude: follow up or move on? Never let a hiccup strand the speaker —
  //    on any failure we simply advance to the next question.
  const total = await store.countQuestions(env, user.id);
  // Linear if we're answering the bookmarked question; otherwise a topic detour.
  const isLinear = question.id === (session.resume_question_id || session.current_question_id);
  let decision = { action: 'advance', utterance: '', reason: '' };
  try {
    const history = await store.getEntriesForQuestion(env, session.id, question.id);
    decision = await decideNext(env, user, question, history, session.follow_up_index);
  } catch (e) {
    console.error('decideNext failed', e && e.stack ? e.stack : e);
  }

  if (decision.action === 'follow_up') {
    try {
      const nextIndex = session.follow_up_index + 1;
      const bytes = await synthesize(env, decision.utterance, user.voice);
      const key = `tts/${user.id}/${session.id}/fu-${store.uid()}.mp3`;
      await store.putAudio(env, key, bytes, 'audio/mpeg');

      await store.addEntry(env, {
        user_id: user.id,
        session_id: session.id,
        question_id: question.id,
        role: 'question',
        text: decision.utterance,
        is_follow_up: true,
        follow_up_index: nextIndex,
      });
      await store.updateSession(env, session.id, {
        follow_up_index: nextIndex,
        current_prompt_text: decision.utterance,
        current_prompt_key: key,
        current_is_follow_up: 1,
      });

      return json({
        done: false,
        ack: 'Thank you.',
        prompt: { text: decision.utterance, audioUrl: audioUrl(key), isFollowUp: true },
        progress: progressFor(question, total, false),
      });
    } catch (e) {
      console.error('follow-up synth/persist failed, advancing', e && e.stack ? e.stack : e);
      // fall through to advance
    }
  }

  // advance ---------------------------------------------------------------
  return advanceFrom(env, user, session, question, isLinear, total);
}

/* ----------------------------------------------------------- POST /api/autosave */
// Belt-and-braces: store the in-progress recording so a dropped call or closed
// tab never loses the audio. Not transcribed; the final /api/answer supersedes it.

async function apiAutosave(request, env) {
  const form = await request.formData();
  const token = form.get('token');
  const file = form.get('audio');
  if (!token || !file || typeof file === 'string') return json({ error: 'bad request' }, 400);

  const user = await store.getUserByToken(env, token);
  if (!user) return json({ error: 'unknown link' }, 404);
  const session = await store.getOrCreateActiveSession(env, user.id);

  const ext = extFor(file.type);
  const key = `audio/${user.id}/${session.id}/autosave-${session.follow_up_index}.${ext}`;
  await store.putAudio(env, key, await file.arrayBuffer(), file.type || 'audio/webm');
  return json({ ok: true });
}

/* ----------------------------------------------------------- GET /api/questions */
// Topic browser: every question with an "answered" flag.

async function apiQuestions(request, env, url) {
  const token = url.searchParams.get('token');
  const user = token && (await store.getUserByToken(env, token));
  if (!user) return json({ error: 'unknown link' }, 404);
  const questions = await store.getQuestionsWithAnswered(env, user.id);
  return json({ questions });
}

/* -------------------------------------------------------------- POST /api/goto */
// Jump the session to a chosen question (from the topic browser). Answers given
// after this append to that question — nothing is overwritten.

async function apiGoto(request, env) {
  const { token, questionId } = await request.json();
  const user = token && (await store.getUserByToken(env, token));
  if (!user) return json({ error: 'unknown link' }, 404);
  const q = await store.getQuestionById(env, questionId);
  if (!q || q.user_id !== user.id) return json({ error: 'question not found' }, 404);

  const session = await store.getOrCreateActiveSession(env, user.id);
  const key = await ensureQuestionAudio(env, user, q);
  await store.updateSession(env, session.id, {
    current_question_id: q.id,
    follow_up_index: 0,
    current_prompt_text: q.seed_text,
    current_prompt_key: key,
    current_is_follow_up: 0,
    status: 'active',
  });
  const total = await store.countQuestions(env, user.id);
  return json({
    done: false,
    prompt: { text: q.seed_text, audioUrl: audioUrl(key), isFollowUp: false, answered: await store.hasAnswer(env, user.id, q.id) },
    progress: progressFor(q, total, false),
  });
}

/* ------------------------------------------------------- POST /api/next & /prev */
// Manual navigation without recording. Next = same advance logic as answering;
// Previous = step back. Both respect the linear-bookmark vs topic-detour rule.

async function apiNav(request, env, dir) {
  const { token } = await request.json();
  const user = token && (await store.getUserByToken(env, token));
  if (!user) return json({ error: 'unknown link' }, 404);
  const session = await store.getOrCreateActiveSession(env, user.id);
  if (!session.current_question_id) return json({ done: true });
  const question = await store.getQuestionById(env, session.current_question_id);
  if (!question) return json({ error: 'question changed, please reload' }, 409);
  const total = await store.countQuestions(env, user.id);
  const isLinear = question.id === (session.resume_question_id || session.current_question_id);
  return dir === 'prev'
    ? prevFrom(env, user, session, question, isLinear, total)
    : advanceFrom(env, user, session, question, isLinear, total, '');
}

/* ------------------------------------------------------------- POST /api/extra */
// A free "add a memory" recording, not tied to the question flow. Stored as an
// addendum (Claude files it under the right question at export time).

async function apiExtra(request, env) {
  const form = await request.formData();
  const token = form.get('token');
  const file = form.get('audio');
  if (!token || !file || typeof file === 'string') return json({ error: 'token and audio required' }, 400);

  const user = await store.getUserByToken(env, token);
  if (!user) return json({ error: 'unknown link' }, 404);
  const session = await store.getOrCreateActiveSession(env, user.id);

  // FK needs a question; use whatever he's on, else the first question, as context.
  let ctxId = session.current_question_id;
  if (!ctxId) {
    const qs = await store.getQuestionsForUser(env, user.id);
    ctxId = qs[0] && qs[0].id;
  }
  if (!ctxId) return json({ error: 'no questions' }, 400);

  const buf = await file.arrayBuffer();
  if (!buf || buf.byteLength === 0) return json({ error: 'empty audio', empty: true }, 400);
  const ext = extFor(file.type);
  const audioKey = `audio/${user.id}/extra/${store.uid()}.${ext}`;
  await store.putAudio(env, audioKey, buf, file.type || 'audio/webm');

  let text = '';
  try {
    text = await transcribe(env, buf, file.type || 'audio/webm');
  } catch (e) {
    console.error('extra transcribe error', e);
  }

  await store.addEntry(env, {
    user_id: user.id,
    session_id: session.id,
    question_id: ctxId,
    role: 'answer',
    kind: 'addendum',
    text,
    audio_key: audioKey,
  });

  return json({ ok: true, ack: 'Saved — thank you.', transcript: text });
}

/* ------------------------------------------------------------- GET /api/export */

async function apiExport(request, env, url) {
  const token = url.searchParams.get('token');
  const user = token && (await store.getUserByToken(env, token));
  if (!user) return json({ error: 'unknown link' }, 404);
  const entries = await store.getTranscript(env, user.id);
  const addenda = await store.getAddenda(env, user.id);
  return json({
    user: { id: user.id, name: user.display_name },
    exported_at: store.now(),
    entries,
    addenda,
  });
}

/* ------------------------------------------------------------- nightly job */
// Back up, then audit. The audit report is written to R2 (audit/latest.json plus
// a dated copy) so a decoupling is durable and impossible to hide — readable via
// /api/admin/r2list or straight from the bucket — and an alert is logged.
async function runNightly(env) {
  const backup = await runBackup(env);
  let audit = null;
  try {
    audit = await runAudit(env);
    const body = JSON.stringify({ ...audit, backup }, null, 2);
    const day = new Date().toISOString().slice(0, 10);
    await env.AUDIO.put('audit/latest.json', body, { httpMetadata: { contentType: 'application/json' } });
    await env.AUDIO.put(`audit/${day}.json`, body, { httpMetadata: { contentType: 'application/json' } });
    if (audit.healthy) {
      console.log(`nightly audit OK — ${audit.users} user(s), no orphans.`);
    } else {
      console.error(
        `NIGHTLY AUDIT ALERT — ${audit.total_real_orphans} orphaned recording(s), ` +
        `${audit.total_dangling_refs} dangling ref(s). Recover with: npm run relink\n` +
        JSON.stringify(audit.reports)
      );
    }
    // Sustained-disuse signal: nudge to consider the WhatsApp voice adjunct.
    for (const r of audit.reports) {
      if (r.disused) {
        console.warn(
          `DISUSE — ${r.user}: no mobile-app activity for ${r.idle_days} days ` +
          `(since ${r.last_web_activity}). Consider activating the voice adjunct (voice/README.md).`
        );
      }
    }
  } catch (e) {
    console.error('nightly audit failed', e && e.stack ? e.stack : e);
  }
  return { backup, audit };
}

/* ------------------------------------------------------------- nightly backup */
// For every user: (re)generate the memoir HTML into primary R2, then copy any
// audio + the doc into the backup bucket. Audio is immutable so it's copied once
// (dedup via head); the doc is always refreshed. Shared by the cron and the
// admin trigger.
async function runBackup(env) {
  const users = await store.listUsers(env);
  let docs = 0, copied = 0, skipped = 0;
  for (const user of users) {
    try {
      const html = await buildMemoirHTML(env, user);
      await env.AUDIO.put(`docs/${user.id}/memoir.html`, html, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      });
      docs++;
    } catch (e) {
      console.error('memoir build failed for', user.id, e && e.stack ? e.stack : e);
    }
    for (const prefix of [`audio/${user.id}/`, `docs/${user.id}/`]) {
      let cursor;
      do {
        const list = await env.AUDIO.list({ prefix, cursor, limit: 1000 });
        for (const o of list.objects) {
          const isDoc = o.key.startsWith('docs/');
          if (!isDoc && (await env.AUDIO_BACKUP.head(o.key))) { skipped++; continue; }
          const src = await env.AUDIO.get(o.key);
          if (!src) continue;
          await env.AUDIO_BACKUP.put(o.key, src.body, { httpMetadata: src.httpMetadata });
          copied++;
        }
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
    }
  }
  return { users: users.length, docs, copied, skipped };
}

/* ------------------------------------------------------ POST /api/admin/run-backup */

async function apiRunBackup(request, env, url) {
  if (!env.ADMIN_KEY || url.searchParams.get('admin') !== env.ADMIN_KEY) {
    return json({ error: 'forbidden' }, 403);
  }
  const result = await runNightly(env);
  return json({ ok: true, ...result });
}

/* --------------------------------------------------------------- GET /memoir */
// Read/print the compiled memoir (admin-gated). Generated live from the latest data.
async function apiMemoir(request, env, url) {
  if (!env.ADMIN_KEY || url.searchParams.get('admin') !== env.ADMIN_KEY) {
    return new Response('Forbidden — add ?admin=YOUR_ADMIN_KEY', { status: 403, headers: { 'content-type': 'text/plain' } });
  }
  const token = url.searchParams.get('token');
  const user = token && (await store.getUserByToken(env, token));
  if (!user) return new Response('Unknown link.', { status: 404, headers: { 'content-type': 'text/plain' } });
  const html = await buildMemoirHTML(env, user);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/* ----------------------------------------------------- GET /api/admin/r2list */
// Recovery aid: list every object in the R2 bucket with its size (largest first),
// so we can find any audio that survived. Gated by ADMIN_KEY.

async function apiR2List(request, env, url) {
  if (!env.ADMIN_KEY || url.searchParams.get('admin') !== env.ADMIN_KEY) {
    return json({ error: 'forbidden' }, 403);
  }
  const objects = [];
  let cursor;
  let nonZero = 0;
  do {
    const r = await env.AUDIO.list({ cursor, limit: 1000 });
    for (const o of r.objects) {
      objects.push({ key: o.key, size: o.size, uploaded: o.uploaded });
      if (o.size > 0) nonZero++;
    }
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  objects.sort((a, b) => b.size - a.size);
  return json({ total: objects.length, nonZero, objects });
}

/* ------------------------------------------------- audit + recovery (read-safe)
 *
 * DATA SAFETY tooling. These exist so that decoupled (orphaned) recordings can
 * never again hide unnoticed. /api/admin/audit is strictly READ-ONLY. The
 * recovery path (/api/admin/relink) is purely ADDITIVE — it inserts D1 rows so
 * orphaned audio reappears in /review, /api/export, the memoir, and backups. It
 * never deletes or overwrites anything, in R2 or D1. */

// Classify a raw-audio R2 key by its shape:
//   audio/<user>/<session>/<order>-fu<n>-<uuid>.<ext>  -> a recorded answer
//   audio/<user>/<session>/autosave-<n>.<ext>          -> in-progress temp copy
//   audio/<user>/extra/<uuid>.<ext>                    -> a free "add a memory"
function classifyAudioKey(key) {
  if (/\/autosave-\d+\.[a-z0-9]+$/i.test(key)) return { kind: 'autosave' };
  if (/\/extra\//.test(key)) return { kind: 'extra' };
  const m = key.match(/\/(\d+)-fu(\d+)-[0-9a-fA-F-]+\.[a-z0-9]+$/i);
  if (m) return { kind: 'answer', order_index: Number(m[1]), follow_up_index: Number(m[2]) };
  return { kind: 'unknown' };
}

// Cross-check one user's R2 audio against D1. Returns the orphans (audio with no
// D1 entry) split into real recordings vs disposable temp files, plus any
// dangling D1 references (an entry whose audio object is missing from R2).
async function auditUser(env, user) {
  const prefix = `audio/${user.id}/`;
  const objects = await store.listAudioObjects(env, prefix);
  const { results } = await env.DB.prepare(
    'SELECT audio_key FROM entries WHERE user_id = ? AND audio_key IS NOT NULL'
  ).bind(user.id).all();
  const referenced = new Set((results || []).map((r) => r.audio_key));

  const realOrphans = [];
  let tempOrphans = 0;
  for (const o of objects) {
    if (referenced.has(o.key)) continue;
    const c = classifyAudioKey(o.key);
    if (c.kind === 'answer' || c.kind === 'extra') realOrphans.push({ ...o, ...c });
    else tempOrphans++; // autosave / unrecognised temp copies — not recovered
  }
  const r2keys = new Set(objects.map((o) => o.key));
  const dangling = [...referenced].filter((k) => k.startsWith(prefix) && !r2keys.has(k));

  // Disuse signal (read-only): days since the last WEB-interface activity. Voice
  // channel entries live under an anchor session with status='voice' and are
  // excluded, so this tracks the mobile app specifically.
  const act = await env.DB.prepare(
    "SELECT MAX(e.created_at) AS last FROM entries e JOIN sessions s ON s.id = e.session_id" +
    " WHERE e.user_id = ? AND s.status <> 'voice'"
  ).bind(user.id).first();
  const lastWeb = act && act.last ? act.last : null;
  const idleDays = lastWeb ? Math.floor((Date.now() - Date.parse(lastWeb)) / 86400000) : null;

  return {
    user: user.id,
    audio_objects: objects.length,
    referenced_in_d1: objects.filter((o) => referenced.has(o.key)).length,
    orphans_total: realOrphans.length + tempOrphans,
    real_orphans: realOrphans,
    temp_orphans: tempOrphans,
    dangling_refs: dangling,
    last_web_activity: lastWeb,
    idle_days: idleDays,
    disused: idleDays != null && idleDays >= DISUSE_DAYS,
  };
}

// Cross-check every user (or one, via `only`) and roll up the totals. Shared by
// the /api/admin/audit endpoint and the nightly cron.
async function runAudit(env, only) {
  const users = only ? [await store.getUserById(env, only)].filter(Boolean) : await store.listUsers(env);
  const reports = [];
  for (const u of users) reports.push(await auditUser(env, u));
  const totalReal = reports.reduce((a, r) => a + r.real_orphans.length, 0);
  const totalDangling = reports.reduce((a, r) => a + r.dangling_refs.length, 0);
  return {
    checked_at: store.now(),
    users: reports.length,
    total_real_orphans: totalReal,
    total_dangling_refs: totalDangling,
    healthy: totalReal === 0 && totalDangling === 0,
    disuse_threshold_days: DISUSE_DAYS,
    disused_users: reports.filter((r) => r.disused).map((r) => r.user),
    reports,
  };
}

/* ------------------------------------------------- GET /api/admin/audit (read-only) */
// Reports orphaned audio (recordings in R2 with no matching D1 entry) for every
// user, so loss can never hide. Optional ?user=<id> to scope to one person.
async function apiAudit(request, env, url) {
  if (!env.ADMIN_KEY || url.searchParams.get('admin') !== env.ADMIN_KEY) {
    return json({ error: 'forbidden' }, 403);
  }
  return json({ ok: true, ...(await runAudit(env, url.searchParams.get('user'))) });
}

/* ----------------------------------------- POST /api/admin/relink (additive only) */
// For each REAL orphaned recording, re-transcribe it (Whisper) and insert a D1
// entry so it reappears everywhere. Idempotent (already-linked audio is skipped
// by the audit). Pass ?dry=1 to preview without writing. Never deletes anything.
async function apiRelink(request, env, url) {
  if (!env.ADMIN_KEY || url.searchParams.get('admin') !== env.ADMIN_KEY) {
    return json({ error: 'forbidden' }, 403);
  }
  const dry = url.searchParams.get('dry') === '1';
  const only = url.searchParams.get('user');
  const users = only ? [await store.getUserById(env, only)].filter(Boolean) : await store.listUsers(env);

  const actions = [];
  for (const user of users) {
    const audit = await auditUser(env, user);
    if (!audit.real_orphans.length) continue;
    const session = await store.getOrCreateActiveSession(env, user.id);

    for (const o of audit.real_orphans) {
      const rec = { user: user.id, key: o.key, kind: o.kind, size: o.size, uploaded: o.uploaded };
      try {
        let questionId, isFollowUp = 0, followUpIndex = 0, entryKind = 'answer';

        if (o.kind === 'answer') {
          const q = await store.getQuestionByOrder(env, user.id, o.order_index);
          if (!q) { rec.status = 'skipped'; rec.reason = `no question at order_index ${o.order_index}`; actions.push(rec); continue; }
          questionId = q.id;
          isFollowUp = o.follow_up_index > 0 ? 1 : 0;
          followUpIndex = o.follow_up_index;
          rec.question = q.seed_text;
        } else { // 'extra' — a free memory; needs any question for the FK
          const qs = await store.getQuestionsForUser(env, user.id);
          if (!qs.length) { rec.status = 'skipped'; rec.reason = 'no questions for FK'; actions.push(rec); continue; }
          questionId = qs[0].id;
          entryKind = 'addendum';
        }

        if (dry) { rec.status = 'would-relink'; actions.push(rec); continue; }

        const obj = await store.getAudioObject(env, o.key);
        if (!obj) { rec.status = 'skipped'; rec.reason = 'audio not found in R2'; actions.push(rec); continue; }
        const buf = await obj.arrayBuffer();
        let text = '';
        try {
          text = await transcribe(env, buf, (obj.httpMetadata && obj.httpMetadata.contentType) || 'audio/webm');
        } catch (e) {
          rec.transcribe_error = String(e && e.message || e); // keep the audio even if transcription fails
        }

        await store.addEntry(env, {
          user_id: user.id,
          session_id: session.id,
          question_id: questionId,
          role: 'answer',
          kind: entryKind,
          text,
          audio_key: o.key,
          is_follow_up: isFollowUp,
          follow_up_index: followUpIndex,
          created_at: o.uploaded, // preserve when it was actually recorded
        });
        rec.status = 'relinked';
        rec.transcript = text;
      } catch (e) {
        rec.status = 'error';
        rec.error = String(e && e.message || e);
      }
      actions.push(rec);
    }
  }

  return json({
    ok: true,
    dry,
    relinked: actions.filter((a) => a.status === 'relinked').length,
    would_relink: actions.filter((a) => a.status === 'would-relink').length,
    actions,
  });
}

/* ------------------------------------------ POST /api/admin/retranscribe (text only)
 *
 * Cleanup for Whisper hallucinations (subtitle boilerplate like "Thanks for
 * watching", stray CJK) that can appear on short / near-silent clips. Re-runs
 * transcription with hallucination guarding and UPDATES the transcript text.
 * It never touches the audio and never deletes anything. By default it only
 * re-checks SUSPECT entries; pass ?all=1 to re-check every recording. ?dry=1
 * previews. Optional ?since=YYYY-MM-DD and ?user=<id>. */

// Subtitle / caption hallucinations Whisper emits on silence, and unexpected CJK
// (Hindi in Devanagari is legitimate and NOT matched here).
const HALLUCINATION_RE =
  /thank you (so much )?for watching|thanks for watching|please (do not forget to )?(like|subscribe)|like,? ?share|likes are a great help|don'?t forget to (like|subscribe)|subscri|see you (next|in the next)/i;
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
const isSuspect = (t) => HALLUCINATION_RE.test(t || '') || CJK_RE.test(t || '');

// Flag "sustained disuse of the mobile interface" after this many days with no
// web activity, so the signal to consider the WhatsApp voice adjunct surfaces
// on its own in the nightly audit. Read-only; changes nothing.
const DISUSE_DAYS = 14;

async function apiRetranscribe(request, env, url) {
  if (!env.ADMIN_KEY || url.searchParams.get('admin') !== env.ADMIN_KEY) {
    return json({ error: 'forbidden' }, 403);
  }
  const dry = url.searchParams.get('dry') === '1';
  const all = url.searchParams.get('all') === '1';
  const since = url.searchParams.get('since') || null;
  const only = url.searchParams.get('user');
  const users = only ? [await store.getUserById(env, only)].filter(Boolean) : await store.listUsers(env);

  const changes = [];
  for (const user of users) {
    const rows = await store.getAnswersWithAudio(env, user.id, since);
    for (const r of rows) {
      if (!all && !isSuspect(r.text)) continue;
      const rec = { user: user.id, id: r.id, key: r.audio_key, before: r.text };
      try {
        const obj = await store.getAudioObject(env, r.audio_key);
        if (!obj) { rec.status = 'skipped'; rec.reason = 'audio not found'; changes.push(rec); continue; }
        const buf = await obj.arrayBuffer();
        const { text, noSpeech } = await transcribeDetailed(env, buf, (obj.httpMetadata && obj.httpMetadata.contentType) || 'audio/webm');
        // If the re-run is still a hallucination, treat the clip as unclear/blank
        // rather than trusting the caption text.
        const after = isSuspect(text) ? '' : text;
        rec.after = after;
        rec.noSpeech = noSpeech;
        if (after === r.text) { rec.status = 'unchanged'; changes.push(rec); continue; }
        if (!dry) await store.updateEntryText(env, r.id, after);
        rec.status = dry ? 'would-update' : 'updated';
      } catch (e) {
        rec.status = 'error';
        rec.error = String(e && e.message || e);
      }
      changes.push(rec);
    }
  }

  const touched = changes.filter((c) => c.status === 'updated' || c.status === 'would-update');
  return json({ ok: true, dry, mode: all ? 'all' : 'suspects-only', checked: changes.length, changed: touched.length, changes });
}

/* ---------------------------------------- POST /api/admin/import (additive only)
 *
 * Import an EXTERNAL audio recording (one not captured through the app) into a
 * user's collection — e.g. an old family recording. Stores the audio in R2 and
 * inserts a D1 entry with a supplied transcript, so it shows up in /review,
 * /api/export, the memoir and backups. Additive only: never deletes or
 * overwrites. Defaults to a free-form addendum ("Additional memories"); pass
 * question_order to file it under a specific question instead.
 * Multipart form: audio (file), text (transcript), optional title.
 * Query: ?admin=KEY&user=<id>&question_order=<n>. */
async function apiImport(request, env, url) {
  if (!env.ADMIN_KEY || url.searchParams.get('admin') !== env.ADMIN_KEY) {
    return json({ error: 'forbidden' }, 403);
  }
  const form = await request.formData();
  const userId = url.searchParams.get('user') || form.get('user');
  const file = form.get('audio');
  const text = (form.get('text') || '').toString();
  const title = (form.get('title') || '').toString().trim();
  if (!userId || !file || typeof file === 'string') {
    return json({ error: 'user and audio required' }, 400);
  }
  const user = await store.getUserById(env, userId);
  if (!user) return json({ error: 'unknown user' }, 404);

  const buf = await file.arrayBuffer();
  if (!buf || buf.byteLength === 0) return json({ error: 'empty audio' }, 400);

  const session = await store.getOrCreateActiveSession(env, user.id);

  // File under a specific question if asked, else attach as a free-form addendum
  // (which still needs a question for the FK — use the first one as context).
  const qOrder = url.searchParams.get('question_order');
  let question = qOrder != null ? await store.getQuestionByOrder(env, user.id, Number(qOrder)) : null;
  if (!question) {
    const qs = await store.getQuestionsForUser(env, user.id);
    if (!qs.length) return json({ error: 'no questions for FK' }, 400);
    question = qs[0];
  }
  const kind = qOrder != null ? 'answer' : 'addendum';

  // Derive an extension from the filename or content type.
  const name = (file.name || '').toLowerCase();
  const ct = file.type || '';
  const ext =
    (name.match(/\.([a-z0-9]{2,4})$/) || [])[1] ||
    (ct.includes('mp4') || ct.includes('m4a') ? 'm4a' : ct.includes('mpeg') ? 'mp3' : ct.includes('ogg') ? 'ogg' : ct.includes('wav') ? 'wav' : 'm4a');

  const key = `audio/${user.id}/extra/${store.uid()}.${ext}`;
  await store.putAudio(env, key, buf, ct || 'audio/mp4');

  const body = title ? `${title}\n\n${text}` : text;
  const entryId = await store.addEntry(env, {
    user_id: user.id,
    session_id: session.id,
    question_id: question.id,
    role: 'answer',
    kind,
    text: body,
    audio_key: key,
  });

  return json({ ok: true, key, entry_id: entryId, kind, bytes: buf.byteLength });
}

/* --------------------------------------------------------------- GET /review */
// Family review page: every question, transcript, and an inline audio player,
// plus the free "add a memory" recordings. Gated by the ADMIN_KEY.
//   /review?token=<user token>&admin=<ADMIN_KEY>

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

async function apiReview(request, env, url) {
  if (!env.ADMIN_KEY || url.searchParams.get('admin') !== env.ADMIN_KEY) {
    return new Response('Forbidden — add ?admin=YOUR_ADMIN_KEY to the URL.', {
      status: 403,
      headers: { 'content-type': 'text/plain' },
    });
  }
  const token = url.searchParams.get('token');
  const user = token && (await store.getUserByToken(env, token));
  if (!user) return new Response('Unknown link.', { status: 404, headers: { 'content-type': 'text/plain' } });

  const entries = await store.getTranscript(env, user.id);
  const addenda = await store.getAddenda(env, user.id);

  const player = (key) =>
    key ? `<audio controls preload="none" src="/api/audio/${esc(key)}"></audio>` : '<em>(audio missing)</em>';

  let html = '';
  let lastTheme = null;
  let lastOrder = null;
  for (const r of entries) {
    if (r.theme !== lastTheme) {
      html += `<h2>${esc(r.theme)}</h2>`;
      lastTheme = r.theme;
    }
    if (r.order_index !== lastOrder) {
      html += `<h3>${esc(r.seed_text)}</h3>`;
      lastOrder = r.order_index;
    }
    if (r.role === 'question' && r.is_follow_up) {
      html += `<p class="fu"><strong>Follow-up:</strong> ${esc(r.text)}</p>`;
    } else if (r.role === 'answer') {
      html += `<div class="ans"><p>${esc(r.text) || '<em>(not transcribed)</em>'}</p>${player(r.audio_key)}</div>`;
    }
  }
  if (!entries.length) html += '<p><em>No answers recorded yet.</em></p>';

  if (addenda.length) {
    html += '<h2>Additional memories</h2>';
    for (const a of addenda) {
      html += `<div class="ans"><p>${esc(a.text) || '<em>(not transcribed)</em>'}</p>${player(a.audio_key)}</div>`;
    }
  }

  const page = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(user.display_name)} — recordings</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 760px; margin: 0 auto; padding: 20px; color: #1c1a17; background: #f7f4ee; }
  h1 { font-size: 1.6rem; } h2 { margin-top: 1.6em; border-bottom: 2px solid #b5651d; padding-bottom: 4px; color: #b5651d; }
  h3 { margin: 1.1em 0 0.3em; font-size: 1.1rem; }
  .ans { background: #fffdf9; border-radius: 10px; padding: 12px 14px; margin: 8px 0; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .ans p { margin: 0 0 8px; white-space: pre-wrap; }
  .fu { color: #5b554c; margin: 6px 0; }
  audio { width: 100%; }
</style></head><body>
<h1>${esc(user.display_name)} — recordings</h1>
${html}
</body></html>`;

  return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/* -------------------------------------------------------- POST /api/admin/seed */
// Loads a user + question set into D1 and pre-generates question audio into R2.
// Protected by the ADMIN_KEY secret. Called by scripts/seed.js.

async function apiSeed(request, env) {
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY || !env.ADMIN_KEY) {
    return json({ error: 'forbidden' }, 403);
  }
  const body = await request.json();
  const u = body.user || {};
  if (!u.id || !u.token || !u.display_name) {
    return json({ error: 'user.id, user.token, user.display_name required' }, 400);
  }
  if (!Array.isArray(body.questions) || body.questions.length === 0) {
    return json({ error: 'questions[] required' }, 400);
  }

  await store.upsertUser(env, u);
  const count = await store.replaceQuestions(env, u.id, body.questions); // non-destructive

  // Question audio is generated lazily the first time each question is reached
  // (see ensurePromptAudio) so seeding a large set never hits request limits.
  // Pass {"pregenerate": true} to warm it all up front instead.
  let audioCount = 0;
  if (body.pregenerate) {
    const rows = await store.getQuestionsForUser(env, u.id);
    for (const row of rows) {
      try {
        const bytes = await synthesize(env, row.seed_text, u.voice || 'onyx');
        const key = `tts/${u.id}/q${row.order_index}.mp3`;
        await store.putAudio(env, key, bytes, 'audio/mpeg');
        await store.setQuestionAudio(env, row.id, key);
        audioCount++;
      } catch (e) {
        console.error('seed TTS failed for', row.order_index, e);
      }
    }
  }

  return json({
    ok: true,
    user: u.id,
    questions: count,
    audio_generated: audioCount,
    audio_mode: body.pregenerate ? 'pregenerated' : 'lazy (on first listen)',
    max_followups: MAX_FOLLOWUPS,
    link: `/d/${u.token}`,
  });
}
