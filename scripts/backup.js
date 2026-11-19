#!/usr/bin/env node
// Download a full local backup of a person's memoir to ./backup/<user>/ :
//   - every audio recording (raw .webm/.mp4), named by question
//   - manifest.json (question, transcript, file, timestamp)
//   - transcript.md (human-readable)
//   - <Name>'s Story.docx (the memoir document)
//
//   BASE_URL=https://parent-journal.<you>.workers.dev  npm run backup -- dad
//
// Safe to re-run; it refreshes the folder. Put it on a schedule with launchd if
// you want it nightly (see README).

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// keys from .dev.vars if not in env
const devVars = join(root, '.dev.vars');
if (existsSync(devVars)) {
  for (const line of readFileSync(devVars, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const name = process.argv[2] || 'dad';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
if (!BASE_URL) { console.error('Set BASE_URL'); process.exit(1); }

const cfg = JSON.parse(await readFile(join(root, 'questions', `${name}.json`), 'utf8'));
const token = cfg.user.token;

const res = await fetch(`${BASE_URL}/api/export?token=${encodeURIComponent(token)}`);
if (!res.ok) { console.error(`Export fetch failed (${res.status})`); process.exit(1); }
const data = await res.json();
const rows = data.entries || [];
const addenda = data.addenda || [];
const answers = rows.filter((e) => e.role === 'answer');
if (!answers.length && !addenda.length) { console.error('Nothing recorded yet — nothing to back up.'); process.exit(1); }

const outDir = join(root, 'backup', name);
const audioDir = join(outDir, 'audio');
await mkdir(audioDir, { recursive: true });

const slug = (s) => String(s || '').replace(/[^A-Za-z0-9 &-]/g, '').trim().slice(0, 40);
const pad = (n) => String(n).padStart(2, '0');

// 1) download audio
const manifest = [];
const seen = {};
let downloaded = 0;
async function pull(key, baseName) {
  const ext = (key.split('.').pop() || 'webm').toLowerCase();
  const r = await fetch(`${BASE_URL}/api/audio/${key}`);
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  const file = `${baseName}.${ext}`;
  await writeFile(join(audioDir, file), buf);
  downloaded++;
  return { file, bytes: buf.length };
}

for (const e of answers) {
  if (!e.audio_key) continue;
  const qn = pad((e.order_index ?? 0) + 1);
  let base = `Q${qn} - ${slug(e.theme)}`;
  if (e.is_follow_up) base += ` (follow-up)`;
  seen[base] = (seen[base] || 0) + 1;
  if (seen[base] > 1) base += ` (${seen[base]})`;
  const f = await pull(e.audio_key, base);
  manifest.push({
    file: f ? `audio/${f.file}` : null,
    bytes: f ? f.bytes : 0,
    question_number: (e.order_index ?? 0) + 1,
    theme: e.theme,
    question: e.seed_text,
    is_follow_up: !!e.is_follow_up,
    transcript: (e.text || '').trim(),
    created_at: e.created_at,
  });
}
let extraN = 0;
for (const a of addenda) {
  if (!a.audio_key) continue;
  extraN++;
  const f = await pull(a.audio_key, `Extra memory ${pad(extraN)}`);
  manifest.push({ file: f ? `audio/${f.file}` : null, bytes: f ? f.bytes : 0, extra: true, transcript: (a.text || '').trim(), created_at: a.created_at });
}

// 2) manifest.json + transcript.md
await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ user: data.user, exported_at: data.exported_at, items: manifest }, null, 2));

let md = `# ${data.user.name}'s Story\n\n`;
let lastTheme = null, lastQ = null;
for (const e of answers) {
  if (e.theme !== lastTheme) { md += `\n## ${e.theme}\n`; lastTheme = e.theme; }
  if (e.order_index !== lastQ) { md += `\n**${e.seed_text}**\n\n`; lastQ = e.order_index; }
  else if (e.is_follow_up) md += `\n*${e.seed_text}*\n\n`;
  md += `${(e.text || '_(recording saved — not transcribed)_').trim()}\n`;
}
if (addenda.length) { md += `\n## Additional memories\n\n`; for (const a of addenda) md += `${(a.text || '_(recording saved)_').trim()}\n\n`; }
await writeFile(join(outDir, 'transcript.md'), md);

// 3) the .docx memoir (auto-sort addenda if a Claude key is present)
async function sortAddenda() {
  const out = { byOrder: {}, general: [] };
  if (!addenda.length) return out;
  let mapping = {};
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const qres = await fetch(`${BASE_URL}/api/questions?token=${encodeURIComponent(token)}`);
      const qs = qres.ok ? (await qres.json()).questions || [] : [];
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await anthropic.messages.create({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6', max_tokens: 1200,
        system: 'You file extra spoken memories under the most relevant interview question. Reply with ONLY a JSON object.',
        messages: [{ role: 'user', content: `Questions:\n${qs.map((q) => `#${q.order_index}: ${q.seed_text}`).join('\n')}\n\nExtra memories:\n${addenda.map((a, i) => `[${i}]: ${a.text || '(none)'}`).join('\n')}\n\nReply: {"map":[{"i":0,"q":12}]}` }],
      });
      let t = (msg.content.find((b) => b.type === 'text') || {}).text || '';
      t = t.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const m = t.match(/\{[\s\S]*\}/);
      for (const e of (JSON.parse(m ? m[0] : t).map || [])) mapping[e.i] = e.q ?? null;
    } catch (e) { console.warn('addenda auto-sort skipped:', e.message); }
  }
  const answered = new Set(answers.map((r) => r.order_index));
  addenda.forEach((a, i) => {
    const txt = a.text || '[recording saved — not transcribed]';
    const oi = mapping[i];
    if (oi != null && answered.has(oi)) (out.byOrder[oi] = out.byOrder[oi] || []).push(txt);
    else out.general.push(txt);
  });
  return out;
}
const sorted = await sortAddenda();

const dateStr = new Date(data.exported_at || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const title = `${data.user.name}'s Story`;
const children = [
  new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
  new Paragraph({ children: [new TextRun({ text: `Recorded conversations · backed up ${dateStr}`, italics: true, color: '666666' })] }),
  new Paragraph({ text: '' }),
];
const groups = [], byOrder = {};
for (const r of answers) {
  if (!byOrder[r.order_index]) { byOrder[r.order_index] = { theme: r.theme, order_index: r.order_index, seed_text: r.seed_text, rows: [] }; groups.push(byOrder[r.order_index]); }
  byOrder[r.order_index].rows.push(r);
}
let lt = null;
for (const g of groups) {
  if (g.theme !== lt) { children.push(new Paragraph({ text: g.theme, heading: HeadingLevel.HEADING_1 })); lt = g.theme; }
  children.push(new Paragraph({ children: [new TextRun({ text: g.seed_text, bold: true })] }));
  for (const r of g.rows) {
    if (r.is_follow_up) children.push(new Paragraph({ children: [new TextRun({ text: r.seed_text, bold: true })] }));
    children.push(new Paragraph({ text: (r.text || '[recording saved — not transcribed]').trim() }));
  }
  for (const x of sorted.byOrder[g.order_index] || []) children.push(new Paragraph({ children: [new TextRun({ text: 'Added later: ' + x, italics: true })] }));
  children.push(new Paragraph({ text: '' }));
}
if (sorted.general.length) {
  children.push(new Paragraph({ text: 'Additional memories', heading: HeadingLevel.HEADING_1 }));
  for (const x of sorted.general) children.push(new Paragraph({ children: [new TextRun({ text: x, italics: true })] }));
}
const buffer = await Packer.toBuffer(new Document({ sections: [{ children }] }));
await writeFile(join(outDir, `${title}.docx`), buffer);

console.log(`\n✓ Backup complete → ${outDir}`);
console.log(`  audio files: ${downloaded}`);
console.log(`  manifest.json, transcript.md, ${title}.docx written\n`);
