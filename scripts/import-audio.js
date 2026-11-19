#!/usr/bin/env node
// Import an EXTERNAL audio recording (one not captured through the app) into a
// person's collection — e.g. an old family recording. Uploads the audio to R2
// and stores a supplied transcript in D1 so it appears in /review, /api/export,
// the memoir and backups. Additive only: never deletes or overwrites.
//
//   ADMIN_KEY=...  BASE_URL=...  npm run import-audio -- dad \
//     --audio "./path/to/recording.m4a" \
//     --text  "./path/to/transcript.txt" \
//     --title "A family conversation — a story from his youth"
//
//   # File it under a specific question instead of Additional memories:
//   ... --question-order 12
//
// Audio should be a web-playable format (m4a/mp3/ogg/wav/webm). Convert first
// with ffmpeg if needed, e.g.:
//   ffmpeg -i in.qta -map 0:a:0 -c:a copy -movflags +faststart out.m4a

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

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
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const user = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true) || args.find((a) => !a.startsWith('--'));
const audioPath = flag('--audio');
const textPath = flag('--text');
const title = flag('--title') || '';
const qOrder = flag('--question-order');

const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY;
if (!BASE_URL) { console.error('Set BASE_URL'); process.exit(1); }
if (!ADMIN_KEY) { console.error('Set ADMIN_KEY'); process.exit(1); }
if (!user) { console.error('Pass a user id, e.g. import-audio -- dad --audio ... --text ...'); process.exit(1); }
if (!audioPath) { console.error('Pass --audio <path>'); process.exit(1); }

const bytes = await readFile(audioPath);
const text = textPath ? await readFile(textPath, 'utf8') : '';
const ext = (basename(audioPath).match(/\.([a-z0-9]{2,4})$/i) || [])[1]?.toLowerCase() || 'm4a';
const ctByExt = { m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm' };

const form = new FormData();
form.append('audio', new Blob([bytes], { type: ctByExt[ext] || 'audio/mp4' }), basename(audioPath));
form.append('text', text);
if (title) form.append('title', title);

let q = `admin=${encodeURIComponent(ADMIN_KEY)}&user=${encodeURIComponent(user)}`;
if (qOrder != null) q += `&question_order=${encodeURIComponent(qOrder)}`;

console.log(`Importing "${basename(audioPath)}" (${(bytes.length / 1e6).toFixed(1)} MB) for ${user}…`);
const res = await fetch(`${BASE_URL}/api/admin/import?${q}`, { method: 'POST', body: form });
const data = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`Import failed (${res.status}):`, data.error || JSON.stringify(data)); process.exit(1); }

console.log(`\n✓ Imported as ${data.kind}.`);
console.log(`  R2 key:   ${data.key}`);
console.log(`  entry id: ${data.entry_id}`);
console.log(`  size:     ${(data.bytes / 1e6).toFixed(1)} MB`);
console.log('\n  It now appears in /review, the memoir, /api/export and backups.\n');
