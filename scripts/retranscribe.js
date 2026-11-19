#!/usr/bin/env node
// Clean up Whisper hallucinations in transcripts (subtitle boilerplate like
// "Thanks for watching", stray CJK) that appear on short / near-silent clips.
// Re-runs transcription with hallucination guarding and updates the text ONLY.
// The audio is never touched and nothing is deleted.
//
//   ADMIN_KEY=...  BASE_URL=...  npm run retranscribe -- dad --dry            # preview suspects
//   ADMIN_KEY=...  BASE_URL=...  npm run retranscribe -- dad                  # fix suspects
//   ADMIN_KEY=...  BASE_URL=...  npm run retranscribe -- dad --since 2026-07-04
//   ADMIN_KEY=...  BASE_URL=...  npm run retranscribe -- dad --all            # re-check everything

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const devVars = join(root, '.dev.vars');
if (existsSync(devVars)) {
  for (const line of readFileSync(devVars, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const all = args.includes('--all');
const sinceIdx = args.indexOf('--since');
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
const user = args.find((a) => !a.startsWith('--') && a !== since);
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY;
if (!BASE_URL) { console.error('Set BASE_URL'); process.exit(1); }
if (!ADMIN_KEY) { console.error('Set ADMIN_KEY'); process.exit(1); }

let q = `admin=${encodeURIComponent(ADMIN_KEY)}`;
if (user) q += `&user=${encodeURIComponent(user)}`;
if (since) q += `&since=${encodeURIComponent(since)}`;
if (all) q += '&all=1';
if (dry) q += '&dry=1';

console.log(`${dry ? 'Previewing' : 'Applying'} re-transcription (${all ? 'all clips' : 'suspects only'})…`);
const res = await fetch(`${BASE_URL}/api/admin/retranscribe?${q}`, { method: 'POST' });
const data = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`Failed (${res.status}):`, data.error || JSON.stringify(data)); process.exit(1); }

const touched = data.changes.filter((c) => c.status === 'updated' || c.status === 'would-update');
if (!touched.length) { console.log(`\n✓ Checked ${data.checked} — nothing needed fixing.\n`); process.exit(0); }

for (const c of touched) {
  console.log(`\n${c.status === 'updated' ? '✓ fixed' : '· would fix'}: ${c.id.slice(0, 8)}`);
  console.log(`  before: "${c.before}"`);
  console.log(`  after:  "${c.after || '(blank — clip had no clear speech)'}"`);
}
console.log(
  dry
    ? `\n${touched.length} transcript(s) would change. Re-run without --dry to apply.\n`
    : `\n✓ ${touched.length} transcript(s) fixed.\n`
);
