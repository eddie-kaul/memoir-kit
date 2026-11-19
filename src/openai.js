// OpenAI helpers: Whisper (speech -> text) and TTS (text -> speech).
// Raw fetch keeps the Worker bundle small and handles the multipart upload /
// binary download cleanly.

const OPENAI_BASE = 'https://api.openai.com/v1';

// Warmth + clarity matter most for an elderly listener. gpt-4o-mini-tts honours
// an `instructions` field; tts-1/tts-1-hd ignore it harmlessly.
const TTS_INSTRUCTIONS =
  'Speak warmly and gently, like a caring grandchild. Slow, clear, and patient, ' +
  'with natural pauses. Reassuring tone.';

/**
 * Transcribe recorded audio. Language is auto-detected so the speaker can answer
 * in English or another language (e.g. Hindi) freely.
 * @returns {Promise<string>} transcript text
 */
export async function transcribe(env, audioArrayBuffer, contentType = 'audio/webm') {
  const ext = contentType.includes('mp4') ? 'mp4' : contentType.includes('mpeg') ? 'mp3' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audioArrayBuffer], { type: contentType }), `answer.${ext}`);
  form.append('model', env.OPENAI_STT_MODEL || 'whisper-1');
  form.append('response_format', 'json');
  // No `language` param -> Whisper auto-detects (handles English + Hindi).

  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Whisper failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return (data.text || '').trim();
}

/**
 * Transcribe with hallucination guarding, for the re-transcribe / cleanup tool.
 * Whisper tends to emit training-data captions ("Thanks for watching", subtitle
 * boilerplate, stray CJK) on short or near-silent clips. We ask for
 * verbose_json + temperature 0 and use per-segment no_speech_prob to decide
 * whether the clip actually contains speech.
 * @returns {Promise<{text: string, noSpeech: boolean}>}
 */
export async function transcribeDetailed(env, audioArrayBuffer, contentType = 'audio/webm') {
  const ext = contentType.includes('mp4') ? 'mp4' : contentType.includes('mpeg') ? 'mp3' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audioArrayBuffer], { type: contentType }), `answer.${ext}`);
  form.append('model', env.OPENAI_STT_MODEL || 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  // No `language` param -> auto-detect (English + Hindi both handled).

  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper failed (${res.status}): ${await res.text()}`);
  const data = await res.json();

  const segs = Array.isArray(data.segments) ? data.segments : [];
  // Treat as silence if every segment is confidently "no speech", or if there
  // are no segments but text came back anyway (classic silence hallucination).
  const noSpeech = segs.length
    ? segs.every((s) => (s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -0.5)
    : !!(data.text || '').trim();

  return { text: noSpeech ? '' : (data.text || '').trim(), noSpeech };
}

/**
 * Synthesize speech for a question or follow-up.
 * @returns {Promise<ArrayBuffer>} MP3 bytes
 */
export async function synthesize(env, text, voice = 'onyx') {
  const body = {
    model: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
    voice,
    input: text,
    response_format: 'mp3',
  };
  // Only the gpt-4o-mini-tts family supports steering instructions.
  if ((env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts').includes('mini-tts')) {
    body.instructions = TTS_INSTRUCTIONS;
  }

  const res = await fetch(`${OPENAI_BASE}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`TTS failed (${res.status}): ${await res.text()}`);
  }
  return res.arrayBuffer();
}
