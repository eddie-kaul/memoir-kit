// The interviewer. After each answer, Claude decides whether to ask ONE gentle
// follow-up or move on to the next question. This is what turns a questionnaire
// into a conversation that draws out the full story.

import Anthropic from '@anthropic-ai/sdk';

export const MAX_FOLLOWUPS = 2; // per seed question — keep it from feeling like an interrogation

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['follow_up', 'advance'],
      description: 'follow_up to ask one more gentle question; advance to move on.',
    },
    utterance: {
      type: 'string',
      description:
        'If follow_up: the single warm follow-up question to speak aloud. If advance: empty string.',
    },
    reason: {
      type: 'string',
      description: 'One short phrase explaining the choice (not spoken to the user).',
    },
  },
  required: ['action', 'utterance', 'reason'],
  additionalProperties: false,
};

const JSON_INSTRUCTION =
  '\n\nReply with ONLY a JSON object and nothing else — no prose, no markdown fences. ' +
  'Exactly this shape:\n' +
  '{"action": "follow_up" | "advance", "utterance": "the follow-up question, or empty if advancing", "reason": "short phrase"}';

function systemPrompt(user) {
  const primary = languageName(user.language_primary || 'en');
  const langNote = user.language_secondary
    ? `${user.display_name} may answer in ${primary} or ${languageName(user.language_secondary)}, ` +
      `sometimes mixing both. That is completely fine — understand either, and always ` +
      `ask your questions in simple, clear ${primary}.`
    : `Ask your questions in simple, clear ${primary}.`;

  // Optional family-written background (questions/<id>.json → user.about), so
  // follow-ups can use the right names and places. Never quoted back as fact.
  const about = user.about
    ? `\n\nBackground the family shared about ${user.display_name} (use it only to understand ` +
      `names and places they mention; never state it as fact or bring up anything they haven't):\n` +
      String(user.about).slice(0, 2000)
    : '';

  return `You are a warm, patient interviewer helping ${user.display_name}, who is in their later years, ` +
    `record the story of their life for their family. You are kind, unhurried, and genuinely curious.

${langNote}${about}

Your job: after each answer, decide whether to gently pull one more thread, or to move on.

RULES — follow these exactly:
- Ask only ONE question at a time. Never stack two questions together.
- When you ask a follow-up, refer to ${user.display_name}'s own words and feelings. Be specific, not generic.
- Keep every question short and easy to hear aloud — one or two plain sentences. No jargon.
- A good follow-up draws out a name, a place, a feeling, a small scene, or the rest of an unfinished story.
- You may ask at most ${MAX_FOLLOWUPS} follow-ups for any one topic. After that, always 'advance'.
- If the answer already feels full and complete, 'advance' — don't pad.
- If the answer is very short, empty, confused, or the person sounds tired, be kind: either ask ONE simple,
  encouraging follow-up, or 'advance' gracefully. Never push or repeat the same question twice.
- Never invent facts. Only build on what was actually said.

Respond ONLY with the structured object: action, utterance, reason.`;
}

function languageName(code) {
  const map = {
    en: 'English', hi: 'Hindi', pa: 'Punjabi', ta: 'Tamil', ur: 'Urdu', ml: 'Malayalam',
    bn: 'Bengali', gu: 'Gujarati', mr: 'Marathi', te: 'Telugu', kn: 'Kannada',
    zh: 'Chinese', yue: 'Cantonese', ms: 'Malay', id: 'Indonesian', tl: 'Tagalog',
    vi: 'Vietnamese', th: 'Thai', ja: 'Japanese', ko: 'Korean', ar: 'Arabic',
    de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
    pl: 'Polish', el: 'Greek', he: 'Hebrew', ru: 'Russian', tr: 'Turkish',
  };
  return map[code] || code;
}

function buildContext(question, entries, followUpIndex) {
  const lines = [];
  lines.push(`Theme: ${question.theme}`);
  lines.push(`Opening question asked: "${question.seed_text}"`);
  lines.push(`Follow-ups already asked on this topic: ${followUpIndex} (max ${MAX_FOLLOWUPS}).`);
  lines.push('');
  lines.push('Conversation so far on this topic:');
  for (const e of entries) {
    const who = e.role === 'question' ? 'You' : question_speaker(question);
    lines.push(`${who}: ${e.text}`);
  }
  lines.push('');
  lines.push(
    followUpIndex >= MAX_FOLLOWUPS
      ? 'You have reached the follow-up limit for this topic. You must advance.'
      : 'Decide: ask one more gentle follow-up, or advance to the next topic.'
  );
  return lines.join('\n');
}

function question_speaker() {
  return 'Them';
}

/**
 * Decide the next move after an answer.
 * @returns {Promise<{action:'follow_up'|'advance', utterance:string, reason:string}>}
 */
export async function decideNext(env, user, question, entries, followUpIndex) {
  // Hard cap: don't even spend a call once we're at the limit.
  if (followUpIndex >= MAX_FOLLOWUPS) {
    return { action: 'advance', utterance: '', reason: 'follow-up limit reached' };
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const msg = await client.messages.create({
    model: env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    max_tokens: 400,
    system: systemPrompt(user) + JSON_INSTRUCTION,
    messages: [{ role: 'user', content: buildContext(question, entries, followUpIndex) }],
  });

  let text = (msg.content.find((b) => b.type === 'text') || {}).text || '';
  // Be forgiving: strip code fences, then pull the first {...} block.
  text = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  let parsed;
  try {
    parsed = JSON.parse(match ? match[0] : text);
  } catch {
    // If anything goes wrong, fail safe by moving on rather than getting stuck.
    return { action: 'advance', utterance: '', reason: 'parse fallback' };
  }
  if (parsed.action === 'follow_up' && parsed.utterance && parsed.utterance.trim()) {
    return { action: 'follow_up', utterance: parsed.utterance.trim(), reason: parsed.reason || '' };
  }
  return { action: 'advance', utterance: '', reason: parsed.reason || 'advance' };
}
