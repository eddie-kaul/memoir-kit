#!/usr/bin/env node
// Recover ORPHANED recordings. For every real audio file in R2 that has no D1
// entry, the Worker re-transcribes it (Whisper) and inserts a transcript entry,
// so it reappears in /review, /api/export, the memoir and backups.
//
// This is ADDITIVE ONLY — it never deletes or overwrites anything, in R2 or D1.
// It is idempotent: already-linked audio is skipped automatically.
//
//   ADMIN_KEY=...  BASE_URL=https://parent-journal.<you>.workers.dev  npm run relink -- --dry   # preview
//   ...                                                               npm run relink             # recover (all users)
//   ...                                                               npm run relink -- dad      # recover one user
//   ...                                                               npm run relink -- dad --dry

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
const user = args.find((a) => !a.startsWith('--'));
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY;
if (!BASE_URL) { console.error('Set BASE_URL'); process.exit(1); }
if (!ADMIN_KEY) { console.error('Set ADMIN_KEY'); process.exit(1); }

let q = `admin=${encodeURIComponent(ADMIN_KEY)}`;
if (user) q += `&user=${encodeURIComponent(user)}`;
if (dry) q += '&dry=1';

console.log(dry ? 'Previewing re-link (no writes)…' : 'Re-linking orphaned recordings…');
const res = await fetch(`${BASE_URL}/api/admin/relink?${q}`, { method: 'POST' });
const data = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`Relink failed (${res.status}):`, data.error || JSON.stringify(data)); process.exit(1); }

if (!data.actions.length) { console.log('\n✓ Nothing to do — no orphaned recordings.\n'); process.exit(0); }

for (const a of data.actions) {
  const tag = a.status === 'relinked' ? '✓ relinked' : a.status === 'would-relink' ? '· would relink' : `! ${a.status}`;
  console.log(`\n${tag}: ${a.key}`);
  if (a.question) console.log(`  question: ${a.question}`);
  if (a.transcript != null) console.log(`  transcript: ${a.transcript || '(not transcribed)'}`);
  if (a.reason) console.log(`  reason: ${a.reason}`);
  if (a.error) console.log(`  error: ${a.error}`);
  if (a.transcribe_error) console.log(`  transcribe warning: ${a.transcribe_error}`);
}
console.log(
  dry
    ? `\n${data.would_relink} recording(s) would be recovered. Re-run without --dry to apply.\n`
    : `\n✓ ${data.relinked} recording(s) recovered.\n`
);
