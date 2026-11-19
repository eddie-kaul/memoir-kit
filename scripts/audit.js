#!/usr/bin/env node
// Read-only data-safety audit. Cross-checks the R2 audio bucket against D1 and
// reports any ORPHANED recordings — audio that exists in R2 but has no matching
// transcript entry (and so is invisible to /review, /api/export, the memoir and
// backups). Also reports dangling references (a D1 entry whose audio is missing).
//
//   ADMIN_KEY=...  BASE_URL=https://parent-journal.<you>.workers.dev  npm run audit
//   ...                                                               npm run audit -- dad
//
// This NEVER writes anything. To recover orphans, run `npm run relink`.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

const user = process.argv[2];
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY;
if (!BASE_URL) { console.error('Set BASE_URL'); process.exit(1); }
if (!ADMIN_KEY) { console.error('Set ADMIN_KEY'); process.exit(1); }

const q = `admin=${encodeURIComponent(ADMIN_KEY)}` + (user ? `&user=${encodeURIComponent(user)}` : '');
const res = await fetch(`${BASE_URL}/api/admin/audit?${q}`);
const data = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`Audit failed (${res.status}):`, data.error || JSON.stringify(data)); process.exit(1); }

console.log(`\nData-safety audit · ${data.checked_at}`);
console.log(`Users checked: ${data.users}`);
for (const r of data.reports) {
  console.log(`\n── ${r.user} ──`);
  console.log(`  audio objects in R2:     ${r.audio_objects}`);
  console.log(`  referenced in D1:        ${r.referenced_in_d1}`);
  console.log(`  disposable temp orphans: ${r.temp_orphans} (autosave copies — ignored)`);
  if (r.idle_days != null) {
    const tag = r.disused ? `  ⚠ DISUSED (>= ${data.disuse_threshold_days}d) — consider the voice adjunct` : '';
    console.log(`  last mobile-app activity: ${r.last_web_activity} (${r.idle_days} day(s) ago)${tag}`);
  } else {
    console.log('  last mobile-app activity: none recorded');
  }
  console.log(`  REAL orphaned recordings: ${r.real_orphans.length}`);
  for (const o of r.real_orphans) {
    console.log(`    • ${o.key}  (${o.size} bytes, ${o.uploaded})`);
  }
  if (r.dangling_refs.length) {
    console.log(`  ⚠ dangling D1 refs (audio missing from R2): ${r.dangling_refs.length}`);
    for (const k of r.dangling_refs) console.log(`    • ${k}`);
  }
}
console.log(
  data.healthy
    ? '\n✓ Healthy — every recording is linked, nothing stranded.\n'
    : `\n⚠ ${data.total_real_orphans} real orphan(s), ${data.total_dangling_refs} dangling ref(s). Recover with:  npm run relink\n`
);
