#!/usr/bin/env node
// Compile a person's recorded answers into a Word (.docx) memoir — no Google.
// Free "add a memory" recordings are filed under the most relevant question by
// Claude (if ANTHROPIC_API_KEY is set), else collected in "Additional memories".
//
//   BASE_URL=https://parent-journal.<you>.workers.dev  npm run export -- dad
//
// Output: ./memoir/<Name>'s Story - <date>.docx  (gitignored)

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Pull keys from .dev.vars if not already in the environment.
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

// 1) Pull transcript + addenda + full question list.
const res = await fetch(`${BASE_URL}/api/export?token=${encodeURIComponent(token)}`);
if (!res.ok) { console.error(`Export fetch failed (${res.status})`); process.exit(1); }
const data = await res.json();
const rows = data.entries || [];
const addenda = data.addenda || [];
if (!rows.length && !addenda.length) { console.error('Nothing recorded yet — nothing to export.'); process.exit(1); }

const qres = await fetch(`${BASE_URL}/api/questions?token=${encodeURIComponent(token)}`);
const allQuestions = qres.ok ? (await qres.json()).questions || [] : [];

// 2) Ask Claude to file each addendum under the best-matching question.
async function sortAddenda() {
  const out = { byOrder: {}, general: [] };
  if (!addenda.length) return out;
  let mapping = {};
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const qList = allQuestions.map((q) => `#${q.order_index}: ${q.seed_text}`).join('\n');
      const aList = addenda.map((a, i) => `[${i}]: ${a.text || '(no transcript)'}`).join('\n');
      const msg = await anthropic.messages.create({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: 'You file extra spoken memories under the most relevant interview question. Reply with ONLY a JSON object.',
        messages: [{ role: 'user', content:
          `Questions:\n${qList}\n\nExtra memories:\n${aList}\n\n` +
          'For each memory, pick the best-matching question number, or null. Reply: {"map":[{"i":0,"q":12},{"i":1,"q":null}]}' }],
      });
      let t = (msg.content.find((b) => b.type === 'text') || {}).text || '';
      t = t.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const m = t.match(/\{[\s\S]*\}/);
      for (const e of (JSON.parse(m ? m[0] : t).map || [])) mapping[e.i] = e.q ?? null;
    } catch (e) {
      console.warn('Auto-sort unavailable (', e.message, ') — extras go to "Additional memories".');
    }
  }
  const answered = new Set(rows.map((r) => r.order_index));
  addenda.forEach((a, i) => {
    const txt = a.text || '[recording saved — not transcribed]';
    const oi = mapping[i];
    if (oi != null && answered.has(oi)) (out.byOrder[oi] = out.byOrder[oi] || []).push(txt);
    else out.general.push(txt);
  });
  return out;
}
const sorted = await sortAddenda();

// 3) Build the document.
const title = `${data.user.name}'s Story`;
const dateStr = new Date(data.exported_at || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const children = [
  new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
  new Paragraph({ children: [new TextRun({ text: `Recorded conversations · exported ${dateStr}`, italics: true, color: '666666' })] }),
  new Paragraph({ text: '' }),
];

// Group answers by question (already ordered by order_index, then time).
const groups = [];
const byOrder = {};
for (const r of rows) {
  if (!byOrder[r.order_index]) { byOrder[r.order_index] = { theme: r.theme, order_index: r.order_index, seed_text: r.seed_text, rows: [] }; groups.push(byOrder[r.order_index]); }
  byOrder[r.order_index].rows.push(r);
}

let lastTheme = null;
for (const g of groups) {
  if (g.theme !== lastTheme) { children.push(new Paragraph({ text: g.theme, heading: HeadingLevel.HEADING_1 })); lastTheme = g.theme; }
  children.push(new Paragraph({ children: [new TextRun({ text: g.seed_text, bold: true })] }));
  for (const r of g.rows) {
    if (r.role === 'question' && r.is_follow_up) children.push(new Paragraph({ children: [new TextRun({ text: r.text, bold: true })] }));
    else if (r.role === 'answer') children.push(new Paragraph({ text: r.text || '[recording saved — not transcribed]' }));
  }
  for (const extra of sorted.byOrder[g.order_index] || []) children.push(new Paragraph({ children: [new TextRun({ text: 'Added later: ' + extra, italics: true })] }));
  children.push(new Paragraph({ text: '' }));
}

if (sorted.general.length) {
  children.push(new Paragraph({ text: 'Additional memories', heading: HeadingLevel.HEADING_1 }));
  for (const extra of sorted.general) children.push(new Paragraph({ children: [new TextRun({ text: extra, italics: true })] }));
}

// 4) Write the file.
const doc = new Document({ sections: [{ children }] });
const buffer = await Packer.toBuffer(doc);
const outDir = join(root, 'memoir');
await mkdir(outDir, { recursive: true });
const outPath = join(outDir, `${title} - ${dateStr}.docx`);
await writeFile(outPath, buffer);

console.log('\n✓ Memoir written to:');
console.log('  ' + outPath + '\n');
