-- Parent Journal schema (Cloudflare D1 / SQLite).
-- Safe to re-run: tables are created only if absent. Per-user data is replaced
-- by the seed endpoint, not by this file.

CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,           -- e.g. "dad"
  display_name       TEXT NOT NULL,
  token              TEXT NOT NULL UNIQUE,        -- secret link token
  language_primary   TEXT NOT NULL DEFAULT 'en',
  language_secondary TEXT,                        -- e.g. "hi" (Hindi)
  voice              TEXT NOT NULL DEFAULT 'onyx', -- OpenAI TTS voice
  created_at         TEXT NOT NULL,
  about              TEXT                          -- optional background for the interviewer
);
-- Existing databases get `about` lazily via storage.upsertUser (ALTER TABLE ADD COLUMN).

CREATE TABLE IF NOT EXISTS questions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  theme       TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  seed_text   TEXT NOT NULL,
  audio_key   TEXT,                               -- cached TTS in R2 (nullable)
  archived    INTEGER NOT NULL DEFAULT 0,         -- hidden from the flow, never deleted
  UNIQUE (user_id, order_index)
);
-- DATA SAFETY: questions trimmed from a reseed are ARCHIVED (archived = 1),
-- never deleted, so their recorded answers and audio are preserved. Existing
-- databases get this column via:
--   ALTER TABLE questions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_questions_user ON questions(user_id, order_index);

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  current_question_id TEXT REFERENCES questions(id),  -- what's being shown right now
  resume_question_id  TEXT REFERENCES questions(id),  -- linear bookmark to resume from
  follow_up_index     INTEGER NOT NULL DEFAULT 0, -- follow-ups asked for current question
  -- The prompt currently waiting to be answered (seed question or a follow-up).
  -- Stored so the speaker can close the tab mid-question and resume exactly here.
  current_prompt_text TEXT,
  current_prompt_key  TEXT,                        -- R2 key of the prompt's audio
  current_is_follow_up INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'active', -- active | done
  started_at          TEXT NOT NULL,
  last_active_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, status);

CREATE TABLE IF NOT EXISTS entries (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  question_id     TEXT NOT NULL REFERENCES questions(id),
  role            TEXT NOT NULL,                  -- 'question' | 'answer'
  kind            TEXT NOT NULL DEFAULT 'answer', -- 'answer' (in-flow) | 'addendum' (free memory)
  text            TEXT NOT NULL,
  audio_key       TEXT,                           -- R2 key (answers: raw audio)
  is_follow_up    INTEGER NOT NULL DEFAULT 0,
  follow_up_index INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_question ON entries(session_id, question_id, created_at);
CREATE INDEX IF NOT EXISTS idx_entries_user ON entries(user_id, created_at);
