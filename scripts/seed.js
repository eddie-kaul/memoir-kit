#!/usr/bin/env node
// Load a user + question set into the deployed Worker (D1) and pre-generate the
// question audio (R2). Run from the repo root.
//
//   ADMIN_KEY=...  BASE_URL=https://parent-journal.<you>.workers.dev  npm run seed -- dad
//
// Requires Node 18+ (global fetch). The user/questions come from questions/<name>.json.

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Pull BASE_URL / ADMIN_KEY from .dev.vars if not already in the environment.
const devVars = join(root, '.dev.vars');
if (existsSync(devVars)) {
  for (const line of readFileSync(devVars, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const name = process.argv[2] || 'dad';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!BASE_URL) {
  console.error('Set BASE_URL, e.g. BASE_URL=https://parent-journal.<you>.workers.dev');
  process.exit(1);
}
if (!ADMIN_KEY) {
  console.error('Set ADMIN_KEY (the same secret you set with `wrangler secret put ADMIN_KEY`).');
  process.exit(1);
}

const file = join(root, 'questions', `${name}.json`);
let config;
try {
  config = JSON.parse(await readFile(file, 'utf8'));
} catch (e) {
  console.error(`Could not read ${file}: ${e.message}`);
  process.exit(1);
}

if (config.user?.token?.includes('CHANGE')) {
  console.error(`\n⚠  Set a real secret token in ${name}.json (user.token) before seeding.\n`);
  process.exit(1);
}

console.log(`Seeding "${name}" → ${BASE_URL} (${config.questions.length} questions, generating audio)…`);

const res = await fetch(`${BASE_URL}/api/admin/seed`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
  body: JSON.stringify(config),
});

const out = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Seed failed (${res.status}):`, out.error || JSON.stringify(out));
  process.exit(1);
}

console.log('\n✓ Done.');
console.log(`  questions:    ${out.questions}`);
console.log(`  voice audio:  ${out.audio_mode || out.audio_generated}`);
console.log(`  max follow-ups: ${out.max_followups}`);
console.log(`\n  Send this link to ${config.user.display_name}:`);
console.log(`  ${BASE_URL}/d/${config.user.token}\n`);
