// D1 + R2 helpers. Everything is keyed by user_id; R2 keys are prefixed by
// user_id so multiple people (Dad, Mum) never collide.

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/* ------------------------------------------------------------------ users */

export async function getUserByToken(env, token) {
  return env.DB.prepare('SELECT * FROM users WHERE token = ?').bind(token).first();
}

export async function getUserById(env, id) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

export async function listUsers(env) {
  const { results } = await env.DB.prepare('SELECT * FROM users').all();
  return results || [];
}

export async function upsertUser(env, u) {
  await env.DB.prepare(
    `INSERT INTO users (id, display_name, token, language_primary, language_secondary, voice, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       token = excluded.token,
       language_primary = excluded.language_primary,
       language_secondary = excluded.language_secondary,
       voice = excluded.voice`
  )
    .bind(
      u.id,
      u.display_name,
      u.token,
      u.language_primary || 'en',
      u.language_secondary || null,
      u.voice || 'onyx',
      now()
    )
    .run();

  // Optional background text for the interviewer. Older databases predate the
  // `about` column, so add it on first use (additive; never drops anything).
  if (u.about !== undefined) {
    const set = () =>
      env.DB.prepare('UPDATE users SET about = ? WHERE id = ?').bind(u.about || null, u.id).run();
    try {
      await set();
    } catch (e) {
      if (!/no such column/i.test(String(e && e.message))) throw e;
      await env.DB.prepare('ALTER TABLE users ADD COLUMN about TEXT').run();
      await set();
    }
  }
}

/* -------------------------------------------------------------- questions */

// Load/refresh a user's question set (used by seeding). APPEND-ONLY and NON-
// DESTRUCTIVE BY DESIGN — see "Data safety" in the README. Nothing here ever
// deletes a recorded answer, an audio file, or a question row:
//   - Questions are upserted by (user_id, order_index) so existing rows keep
//     their id, and recorded answers (which reference that id) always survive a
//     reseed. Cached question audio is kept when the wording is unchanged and
//     cleared (regenerated) when it changes.
//   - Trailing questions removed from a new, shorter set are ARCHIVED, never
//     deleted. Archived questions are hidden from the interview flow and the
//     topic browser, but their rows, transcripts, and audio remain intact and
//     keep appearing in the memoir, /review, /api/export, and backups.
// DO NOT reintroduce any DELETE here. Recordings are sacred.
export async function replaceQuestions(env, userId, questions) {
  const upsert = env.DB.prepare(
    `INSERT INTO questions (id, user_id, theme, order_index, seed_text, audio_key, archived)
     VALUES (?, ?, ?, ?, ?, NULL, 0)
     ON CONFLICT(user_id, order_index) DO UPDATE SET
       theme = excluded.theme,
       seed_text = excluded.seed_text,
       archived = 0,
       audio_key = CASE WHEN questions.seed_text = excluded.seed_text
                        THEN questions.audio_key ELSE NULL END`
  );
  const stmts = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    stmts.push(upsert.bind(uid(), userId, q.theme, i, q.text));
  }
  const n = questions.length;
  // Hide (do NOT delete) any questions beyond the new length. Their answers and
  // audio are preserved and still export.
  stmts.push(
    env.DB.prepare('UPDATE questions SET archived = 1 WHERE user_id = ? AND order_index >= ?').bind(userId, n)
  );
  await env.DB.batch(stmts);
  return questions.length;
}

export async function setQuestionAudio(env, questionId, audioKey) {
  await env.DB.prepare('UPDATE questions SET audio_key = ? WHERE id = ?')
    .bind(audioKey, questionId)
    .run();
}

// Active questions for the interview flow (archived/hidden ones excluded).
export async function getQuestionsForUser(env, userId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM questions WHERE user_id = ? AND archived = 0 ORDER BY order_index ASC'
  )
    .bind(userId)
    .all();
  return results || [];
}

export async function getQuestionById(env, id) {
  return env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
}

export async function getNextQuestion(env, userId, orderIndex) {
  return env.DB.prepare(
    'SELECT * FROM questions WHERE user_id = ? AND order_index > ? AND archived = 0 ORDER BY order_index ASC LIMIT 1'
  )
    .bind(userId, orderIndex)
    .first();
}

export async function getPrevQuestion(env, userId, orderIndex) {
  return env.DB.prepare(
    'SELECT * FROM questions WHERE user_id = ? AND order_index < ? AND archived = 0 ORDER BY order_index DESC LIMIT 1'
  )
    .bind(userId, orderIndex)
    .first();
}

// True if a question already has at least one recorded answer (not addendum).
export async function hasAnswer(env, userId, questionId) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM entries WHERE user_id = ? AND question_id = ? AND role = 'answer' AND kind = 'answer'"
  )
    .bind(userId, questionId)
    .first();
  return !!(r && r.n > 0);
}

export async function countQuestions(env, userId) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM questions WHERE user_id = ? AND archived = 0')
    .bind(userId)
    .first();
  return r ? r.n : 0;
}

/* --------------------------------------------------------------- sessions */

// Get the active session, creating one (pointed at the first question) if none.
export async function getOrCreateActiveSession(env, userId) {
  let s = await env.DB.prepare(
    "SELECT * FROM sessions WHERE user_id = ? AND status = 'active' ORDER BY last_active_at DESC LIMIT 1"
  )
    .bind(userId)
    .first();
  if (s) return s;

  const first = await env.DB.prepare(
    'SELECT * FROM questions WHERE user_id = ? AND archived = 0 ORDER BY order_index ASC LIMIT 1'
  )
    .bind(userId)
    .first();

  const id = uid();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO sessions
       (id, user_id, current_question_id, resume_question_id, follow_up_index,
        current_prompt_text, current_prompt_key, current_is_follow_up,
        status, started_at, last_active_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, 0, 'active', ?, ?)`
  )
    .bind(
      id,
      userId,
      first ? first.id : null,
      first ? first.id : null,
      first ? first.seed_text : null,
      first ? first.audio_key : null,
      t,
      t
    )
    .run();
  return env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
}

export async function getSession(env, sessionId) {
  return env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first();
}

export async function updateSession(env, sessionId, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  sets.push('last_active_at = ?');
  vals.push(now());
  vals.push(sessionId);
  await env.DB.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...vals)
    .run();
}

/* ---------------------------------------------------------------- entries */

export async function addEntry(env, e) {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO entries (id, user_id, session_id, question_id, role, kind, text, audio_key, is_follow_up, follow_up_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      e.user_id,
      e.session_id,
      e.question_id,
      e.role,
      e.kind || 'answer',
      e.text,
      e.audio_key || null,
      e.is_follow_up ? 1 : 0,
      e.follow_up_index || 0,
      e.created_at || now()  // recovery/relink preserves the original R2 upload time
    )
    .run();
  return id;
}

// Update only the transcript text of an entry (used by the re-transcribe /
// cleanup tool). Never deletes the row or its audio — transcripts are corrected
// in place, the recording is untouched.
export async function updateEntryText(env, entryId, text) {
  await env.DB.prepare('UPDATE entries SET text = ? WHERE id = ?').bind(text, entryId).run();
}

// Answers (with audio) for a user, optionally only those created on/after `since`
// (ISO string). Used by the re-transcribe tool to find clips to re-check.
export async function getAnswersWithAudio(env, userId, since) {
  const sql =
    `SELECT id, created_at, audio_key, text FROM entries
      WHERE user_id = ? AND role = 'answer' AND audio_key IS NOT NULL` +
    (since ? ' AND created_at >= ?' : '') +
    ' ORDER BY created_at ASC';
  const stmt = since ? env.DB.prepare(sql).bind(userId, since) : env.DB.prepare(sql).bind(userId);
  const { results } = await stmt.all();
  return results || [];
}

// Conversation history for the current question, oldest first (fed to Claude).
export async function getEntriesForQuestion(env, sessionId, questionId) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM entries WHERE session_id = ? AND question_id = ? ORDER BY created_at ASC`
  )
    .bind(sessionId, questionId)
    .all();
  return results || [];
}

// In-flow answers (and follow-up questions) for a user, joined to their
// question, for the memoir export. Excludes free-form addenda.
export async function getTranscript(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT e.role, e.text, e.is_follow_up, e.created_at, e.audio_key,
            q.theme, q.order_index, q.seed_text
       FROM entries e
       JOIN questions q ON q.id = e.question_id
      WHERE e.user_id = ? AND e.kind = 'answer'
      ORDER BY q.order_index ASC, e.created_at ASC`
  )
    .bind(userId)
    .all();
  return results || [];
}

// Free-form "add a memory" recordings, for the exporter to sort.
export async function getAddenda(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT id, text, audio_key, created_at FROM entries
      WHERE user_id = ? AND kind = 'addendum'
      ORDER BY created_at ASC`
  )
    .bind(userId)
    .all();
  return results || [];
}

// Questions for the topic browser, each flagged answered if it has >=1 answer.
export async function getQuestionsWithAnswered(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT q.id, q.theme, q.order_index, q.seed_text,
            (SELECT COUNT(*) FROM entries e
              WHERE e.question_id = q.id AND e.role = 'answer' AND e.kind = 'answer') AS answers
       FROM questions q
      WHERE q.user_id = ? AND q.archived = 0
      ORDER BY q.order_index ASC`
  )
    .bind(userId)
    .all();
  return (results || []).map((r) => ({
    id: r.id,
    theme: r.theme,
    order_index: r.order_index,
    seed_text: r.seed_text,
    answered: r.answers > 0,
  }));
}

// Find a question by its position (used by the orphan-recovery / relink tool,
// which reads the order_index out of an audio key like
// `audio/<user>/<session>/<order>-fu<n>-<uuid>.<ext>`).
export async function getQuestionByOrder(env, userId, orderIndex) {
  return env.DB.prepare('SELECT * FROM questions WHERE user_id = ? AND order_index = ?')
    .bind(userId, orderIndex)
    .first();
}

/* -------------------------------------------------------------------- R2
 *
 * DATA SAFETY — raw answer audio (audio/<user>/...) is APPEND-ONLY and SACRED.
 * These helpers only ever PUT or GET. There is deliberately NO delete helper,
 * and none may be added: a parent's recorded voice is irreplaceable. If audio
 * ever needs to be hidden, hide it in D1 — never remove the R2 object.
 * See the "Data safety" section of the README. */

export async function putAudio(env, key, body, contentType) {
  await env.AUDIO.put(key, body, { httpMetadata: { contentType } });
  return key;
}

export async function getAudioObject(env, key) {
  return env.AUDIO.get(key);
}

// List every R2 object under a prefix (paginated). Read-only; used by the audit
// and relink tools to enumerate the TRUE bucket state, independent of D1.
export async function listAudioObjects(env, prefix) {
  const objects = [];
  let cursor;
  do {
    const r = await env.AUDIO.list({ prefix, cursor, limit: 1000 });
    // R2 returns `uploaded` as a Date; normalise to an ISO string so it can be
    // used directly in D1 bindings (and JSON) without a type error.
    for (const o of r.objects) {
      objects.push({
        key: o.key,
        size: o.size,
        uploaded: o.uploaded instanceof Date ? o.uploaded.toISOString() : o.uploaded,
      });
    }
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return objects;
}

export { uid, now };
