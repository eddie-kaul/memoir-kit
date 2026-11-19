#!/usr/bin/env node
// Memoir Kit setup helper. Each step is small, idempotent and safe to re-run, so
// Claude (or you) can drive setup one step at a time and resume after a break.
//
//   bash kit.sh status                 # where are we? (run this first, any time)
//   bash kit.sh login                  # opens the browser to sign in to Cloudflare
//   bash kit.sh init --name smith [--account <id>]
//   bash kit.sh resources              # storage buckets + database + tables
//   bash kit.sh deploy                 # publish the app, records its web address
//   bash kit.sh keys                   # opens a local page to paste the two AI keys
//   bash kit.sh check-questions mum    # validate questions/mum.json
//   bash kit.sh seed mum [--force]     # load questions, print the links
//   bash kit.sh links [mum]            # print the parent + family links again
//   bash kit.sh doctor [mum]           # end-to-end health check
//
// Local state: .memoir.json (names/ids, not secret) and .dev.vars (BASE_URL +
// ADMIN_KEY). The OpenAI/Anthropic keys are only ever stored in Cloudflare.

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(root, '.memoir.json');
const DEVVARS = join(root, '.dev.vars');
const WRANGLER_TOML = join(root, 'wrangler.toml');
const TEMPLATE = join(root, 'wrangler.template.toml');

const [cmd = 'status', ...rest] = process.argv.slice(2);
const flag = (n) => {
  const i = rest.indexOf(`--${n}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (n) => rest.includes(`--${n}`);
const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').match(/^--(name|account)$/));

/* ----------------------------------------------------------------- helpers */

const ok = (m) => console.log(`✓ ${m}`);
const info = (m) => console.log(`  ${m}`);
const warn = (m) => console.log(`! ${m}`);
function fail(code, m) {
  console.log(`✗ ${m}`);
  console.log(`STATUS: ${code}`);
  process.exit(1);
}

function loadState() {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
}
function saveState(s) {
  writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
}
function readVars() {
  const out = {};
  if (!existsSync(DEVVARS)) return out;
  for (const line of readFileSync(DEVVARS, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
function writeVar(name, value) {
  const lines = existsSync(DEVVARS) ? readFileSync(DEVVARS, 'utf8').split('\n') : [];
  const i = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  writeFileSync(DEVVARS, lines.filter(Boolean).join('\n') + '\n');
}

// Run wrangler without a TTY and capture output. Never pass secrets as args.
function wrangler(args, { input, inherit } = {}) {
  const st = loadState();
  const env = { ...process.env };
  if (st.accountId) env.CLOUDFLARE_ACCOUNT_ID = st.accountId;
  const r = spawnSync('npx', ['--no-install', 'wrangler', ...args], {
    cwd: root,
    env,
    input,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  return { code: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);

// 02:00 in the user's own time zone, expressed as a UTC cron.
function nightlyCron() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const offsetMin = -new Date().getTimezoneOffset();
  const utcHour = (((2 * 60 - offsetMin) / 60) % 24 + 24) % 24;
  return { cron: `0 ${Math.floor(utcHour)} * * *`, note: `02:00 ${tz}` };
}

function render(st) {
  const t = readFileSync(TEMPLATE, 'utf8');
  const { cron, note } = nightlyCron();
  const vals = {
    WORKER_NAME: st.workerName,
    ACCOUNT_ID: st.accountId,
    BUCKET: st.bucket,
    BACKUP_BUCKET: st.backupBucket,
    DB_NAME: st.dbName,
    DB_ID: st.dbId || '00000000-0000-0000-0000-000000000000',
    CRON: st.cron || cron,
    CRON_NOTE: st.cronNote || note,
  };
  writeFileSync(WRANGLER_TOML, t.replace(/\{\{(\w+)\}\}/g, (_, k) => vals[k] ?? ''));
}

function whoami() {
  const r = wrangler(['whoami']);
  const loggedIn = r.code === 0 && !/not authenticated|You are not logged in/i.test(r.out);
  const accounts = [];
  for (const m of r.out.matchAll(/│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│/g)) {
    if (!/account name/i.test(m[1])) accounts.push({ name: m[1], id: m[2] });
  }
  return { loggedIn, accounts };
}

function people() {
  const dir = join(root, 'questions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('.'))
    .map((f) => f.replace(/\.json$/, ''));
}

function loadPerson(id) {
  const file = join(root, 'questions', `${id}.json`);
  if (!existsSync(file)) fail('NO_QUESTIONS', `questions/${id}.json does not exist yet.`);
  return { file, cfg: JSON.parse(readFileSync(file, 'utf8')) };
}

function links(id) {
  const vars = readVars();
  const { cfg } = loadPerson(id);
  const base = vars.BASE_URL;
  if (!base || !cfg.user.token) return null;
  const t = encodeURIComponent(cfg.user.token);
  const a = encodeURIComponent(vars.ADMIN_KEY || '');
  return {
    parent: `${base}/d/${cfg.user.token}`,
    review: `${base}/review?token=${t}&admin=${a}`,
    memoir: `${base}/memoir?token=${t}&admin=${a}`,
  };
}

// Every account needs a free <name>.workers.dev address once before publishing.
// Register one automatically (family name first, then variations) using the
// Cloudflare sign-in wrangler already holds. Falls back to manual instructions.
async function ensureSubdomain(st) {
  const manual = () =>
    fail('NEED_SUBDOMAIN', `Cloudflare needs a free workers.dev address for this account. Open https://dash.cloudflare.com/${st.accountId}/workers/subdomain , choose a name (e.g. your surname), save, then run this step again.`);
  const t = wrangler(['auth', 'token', '--json']);
  let token;
  try {
    token = JSON.parse(t.out.slice(t.out.indexOf('{'), t.out.lastIndexOf('}') + 1)).token;
  } catch {}
  if (!token) return; // can't check – let deploy report it if needed
  const api = `https://api.cloudflare.com/client/v4/accounts/${st.accountId}/workers/subdomain`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const cur = await fetch(api, { headers }).then((r) => r.json()).catch(() => null);
  if (cur?.success && cur.result?.subdomain) return;
  const wanted = slugify(flag('subdomain') || st.family);
  const tries = [wanted, `${wanted}-family`, `${wanted}-stories`, `${wanted}-${randomBytes(2).toString('hex')}`];
  for (const name of tries) {
    if (!name || name.length < 3) continue;
    const r = await fetch(api, { method: 'PUT', headers, body: JSON.stringify({ subdomain: name }) })
      .then((x) => x.json())
      .catch(() => null);
    if (r?.success) {
      ok(`Reserved your web address: ${name}.workers.dev`);
      info('Brand-new addresses can take a few minutes to start working.');
      return;
    }
  }
  manual();
}

/* ---------------------------------------------------------------- commands */

const commands = {
  status() {
    const st = loadState();
    const vars = readVars();
    console.log('Memoir Kit – setup status\n');
    const [maj, min] = process.versions.node.split('.').map(Number);
    maj > 22 || (maj === 22 && min >= 12) ? ok(`Node ${process.versions.node}`) : warn(`Node ${process.versions.node} is too old – run setup via: bash kit.sh status`);
    const deps = existsSync(join(root, 'node_modules', 'wrangler'));
    deps ? ok('Dependencies installed') : warn('Dependencies not installed (run: npm install)');
    let who = { loggedIn: false, accounts: [] };
    if (deps) {
      who = whoami();
      who.loggedIn
        ? ok(`Signed in to Cloudflare (${who.accounts.map((a) => `${a.name} = ${a.id}`).join('; ') || 'account list unavailable'})`)
        : warn('Not signed in to Cloudflare (run: bash kit.sh login)');
    }
    st.workerName ? ok(`Named "${st.workerName}"`) : warn('Not initialised (run: bash kit.sh init --name <family>)');
    st.dbId ? ok('Storage + database created') : warn('Storage + database not created yet');
    vars.BASE_URL ? ok(`Live at ${vars.BASE_URL}`) : warn('Not deployed yet');
    st.keysSet ? ok('AI keys stored in Cloudflare') : warn('AI keys not set yet');
    const ps = people();
    ps.length ? ok(`Question files: ${ps.join(', ')}`) : warn('No question files yet (questions/<person>.json)');
    for (const p of ps) {
      const seeded = (st.seeded || {})[p];
      seeded ? ok(`${p}: loaded ${seeded.count} questions on ${seeded.at.slice(0, 10)}`) : warn(`${p}: questions not loaded yet`);
    }
    // Same order as the /setup wizard: the parent and their questions come first.
    const next = !deps ? 'INSTALL' : !ps.length ? 'QUESTIONS' : !who.loggedIn ? 'LOGIN' : !st.workerName ? 'INIT'
      : !st.dbId ? 'RESOURCES' : !vars.BASE_URL ? 'DEPLOY' : !st.keysSet ? 'KEYS'
      : ps.some((p) => !(st.seeded || {})[p]) ? 'SEED' : 'DONE';
    console.log(`\nNEXT: ${next}`);
  },

  login() {
    console.log('Opening your browser to sign in to Cloudflare. Approve the request, then come back here.');
    const r = wrangler(['login'], { inherit: true });
    if (r.code !== 0) fail('LOGIN_FAILED', 'Cloudflare sign-in did not complete. Try again.');
    ok('Signed in to Cloudflare.');
  },

  init() {
    const name = slugify(flag('name') || positional[0]);
    if (!name || name.length < 2) fail('NEED_NAME', 'Pass a short family name, e.g. --name smith');
    const who = whoami();
    if (!who.loggedIn) fail('LOGIN', 'Sign in to Cloudflare first: bash kit.sh login');
    let accountId = flag('account') || loadState().accountId;
    if (!accountId) {
      if (who.accounts.length === 1) accountId = who.accounts[0].id;
      else if (who.accounts.length > 1) {
        console.log('This login can see several Cloudflare accounts:');
        who.accounts.forEach((a) => info(`${a.name}  →  ${a.id}`));
        fail('PICK_ACCOUNT', 'Re-run with --account <id> for the one to use.');
      } else fail('NO_ACCOUNT', 'Could not read your Cloudflare account id. Re-run with --account <id> (Cloudflare dashboard → Account home → Account ID).');
    }
    const prev = loadState();
    const { cron, note } = nightlyCron();
    const st = {
      ...prev,
      family: name,
      accountId,
      workerName: prev.workerName || `${name}-memoir`,
      bucket: prev.bucket || `${name}-memoir-audio`,
      backupBucket: prev.backupBucket || `${name}-memoir-backup`,
      dbName: prev.dbName || `${name}-memoir`,
      cron: prev.cron || cron,
      cronNote: prev.cronNote || note,
    };
    saveState(st);
    if (!readVars().ADMIN_KEY) writeVar('ADMIN_KEY', randomBytes(24).toString('hex'));
    render(st);
    ok(`Initialised "${st.workerName}" (nightly backup at ${st.cronNote}).`);
  },

  resources() {
    const st = loadState();
    if (!st.workerName) fail('INIT', 'Run init first.');
    for (const b of [st.bucket, st.backupBucket]) {
      const r = wrangler(['r2', 'bucket', 'create', b]);
      if (r.code === 0) ok(`Created storage bucket ${b}`);
      else if (/already exists|already own/i.test(r.out)) ok(`Storage bucket ${b} already exists`);
      else if (/10042|enable R2|R2 is not enabled|purchase/i.test(r.out)) {
        console.log(r.out.trim().split('\n').slice(-6).join('\n'));
        fail('ENABLE_R2', `R2 storage isn't switched on for this Cloudflare account yet. Open https://dash.cloudflare.com/${st.accountId}/r2/overview , click to enable R2 (the free tier is 10 GB; Cloudflare asks for a card but does not charge within it), then run this step again.`);
      } else {
        console.log(r.out.trim());
        fail('R2_FAILED', `Could not create bucket ${b}.`);
      }
    }
    if (!st.dbId) {
      const list = wrangler(['d1', 'list', '--json']);
      try {
        const found = JSON.parse(list.out.slice(list.out.indexOf('['), list.out.lastIndexOf(']') + 1))
          .find((d) => d.name === st.dbName);
        if (found) st.dbId = found.uuid;
      } catch {}
      if (!st.dbId) {
        const r = wrangler(['d1', 'create', st.dbName]);
        const m = r.out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
        if (r.code !== 0 || !m) {
          console.log(r.out.trim());
          fail('D1_FAILED', 'Could not create the database.');
        }
        st.dbId = m[0];
        ok(`Created database ${st.dbName}`);
      } else ok(`Database ${st.dbName} already exists`);
      saveState(st);
    }
    render(st);
    const s = wrangler(['d1', 'execute', st.dbName, '--remote', '--file=./src/db/schema.sql']);
    if (s.code !== 0) {
      console.log(s.out.trim());
      fail('SCHEMA_FAILED', 'Could not create the database tables.');
    }
    ok('Database tables ready');
  },

  async deploy() {
    const st = loadState();
    if (!st.dbId) fail('RESOURCES', 'Run resources first.');
    await ensureSubdomain(st);
    render(st);
    const r = wrangler(['deploy']);
    const url = (r.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0];
    if (r.code !== 0 || !url) {
      if (/workers\.dev subdomain|register a workers\.dev|subdomain/i.test(r.out)) {
        fail('NEED_SUBDOMAIN', `Cloudflare needs you to pick your free workers.dev address once. Open https://dash.cloudflare.com/${st.accountId}/workers/subdomain (or Workers & Pages in the dashboard), choose a name (e.g. your surname), save, then run this step again.`);
      }
      console.log(r.out.trim());
      fail('DEPLOY_FAILED', 'Publishing failed.');
    }
    writeVar('BASE_URL', url);
    ok(`Published at ${url}`);
    info('A brand-new address can take a minute or two before it opens.');
  },

  async keys() {
    const st = loadState();
    const vars = readVars();
    if (!vars.BASE_URL) fail('DEPLOY', 'Run deploy first (keys are attached to the published app).');
    const put = (name, value) => {
      const r = wrangler(['secret', 'put', name], { input: value });
      if (r.code !== 0) throw new Error(`Could not store ${name} in Cloudflare: ${r.out.trim().split('\n').slice(-3).join(' ')}`);
    };
    if (has('admin-only')) {
      put('ADMIN_KEY', vars.ADMIN_KEY);
      return ok('Family admin key stored in Cloudflare.');
    }

    const check = async (openai, anthropic) => {
      const errs = [];
      const o = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${openai}` } }).catch(() => null);
      if (!o || o.status === 401) errs.push('The OpenAI key was not accepted. Copy it again (it starts with sk-).');
      const a = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': anthropic, 'anthropic-version': '2023-06-01' },
      }).catch(() => null);
      if (!a || a.status === 401) errs.push('The Anthropic key was not accepted. Copy it again (it starts with sk-ant-).');
      return errs;
    };

    await new Promise((resolve) => {
      const server = createServer(async (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          for await (const c of req) body += c;
          const f = new URLSearchParams(body);
          const openai = (f.get('openai') || '').trim();
          const anthropic = (f.get('anthropic') || '').trim();
          const errs = await check(openai, anthropic);
          if (!errs.length) {
            try {
              put('OPENAI_API_KEY', openai);
              put('ANTHROPIC_API_KEY', anthropic);
              put('ADMIN_KEY', vars.ADMIN_KEY);
            } catch (e) {
              errs.push(e.message);
            }
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          if (errs.length) return res.end(page(errs));
          res.end(page([], true));
          st.keysSet = new Date().toISOString();
          saveState(st);
          ok('Both AI keys checked and stored safely in Cloudflare.');
          server.close();
          return resolve();
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page([]));
      });
      server.listen(0, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${server.address().port}/`;
        console.log(`Opening ${url} – paste your two keys there. (Waiting…)`);
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
        spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      });
      setTimeout(() => {
        console.log('Timed out after 30 minutes. Run this step again when ready.');
        process.exit(1);
      }, 30 * 60 * 1000).unref();
    });
  },

  'check-questions'() {
    const id = positional[0];
    if (!id) fail('NEED_PERSON', 'Pass the person id, e.g. check-questions mum');
    const { cfg } = loadPerson(id);
    const problems = [];
    const tips = [];
    const u = cfg.user || {};
    if (u.id !== id) problems.push(`user.id should be "${id}" (it must match the file name).`);
    if (!u.display_name) problems.push('user.display_name is missing (what the app calls them, e.g. "Mum").');
    if (!['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'].includes(u.voice || 'onyx'))
      problems.push(`user.voice "${u.voice}" is not a known voice.`);
    const qs = cfg.questions || [];
    if (!qs.length) problems.push('There are no questions.');
    const seen = new Set();
    qs.forEach((q, i) => {
      if (!q.theme || !q.text) problems.push(`Question ${i + 1} needs both "theme" and "text".`);
      const t = (q.text || '').trim().toLowerCase();
      if (seen.has(t)) problems.push(`Question ${i + 1} is a duplicate.`);
      seen.add(t);
      if ((q.text || '').length > 240) tips.push(`Question ${i + 1} is long to hear aloud (${q.text.length} chars).`);
      if (((q.text || '').match(/\?/g) || []).length > 2) tips.push(`Question ${i + 1} asks several things at once.`);
    });
    const themes = [...new Set(qs.map((q) => q.theme))];
    // Themes should be contiguous so the topic browser groups cleanly.
    themes.forEach((th) => {
      const idx = qs.map((q, i) => (q.theme === th ? i : -1)).filter((i) => i >= 0);
      if (idx[idx.length - 1] - idx[0] + 1 !== idx.length) tips.push(`Theme "${th}" is split up – keep its questions together.`);
    });
    tips.forEach((t) => warn(t));
    if (problems.length) {
      problems.forEach((p) => console.log(`✗ ${p}`));
      console.log('STATUS: INVALID');
      process.exit(1);
    }
    ok(`${qs.length} questions across ${themes.length} themes: ${themes.join(', ')}`);
  },

  seed() {
    const id = positional[0];
    if (!id) fail('NEED_PERSON', 'Pass the person id, e.g. seed mum');
    const st = loadState();
    const { file, cfg } = loadPerson(id);
    if (!st.keysSet) warn('AI keys are not marked as set – voices and follow-ups will not work until they are.');

    if (!cfg.user.token || /CHANGE/.test(cfg.user.token)) {
      cfg.user.token = `${id}-${randomBytes(16).toString('hex')}`;
      writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
      ok('Created a private link token.');
    }

    // Safety: answers are attached to a question's POSITION. Once recording has
    // started, inserting/removing/reordering questions would put old answers
    // under the wrong question. Only appending and light rewording are safe.
    const snapFile = join(root, 'questions', `.${id}.seeded.json`);
    if (existsSync(snapFile) && !has('force')) {
      const prev = JSON.parse(readFileSync(snapFile, 'utf8')).questions || [];
      const now = cfg.questions;
      const changed = prev
        .map((q, i) => ({ i, before: q.text, after: (now[i] || {}).text }))
        .filter((d) => d.before !== d.after);
      if (now.length < prev.length || changed.length) {
        console.log('These already-loaded questions would change:');
        changed.slice(0, 15).forEach((d) => info(`#${d.i + 1}: "${d.before}"  →  "${d.after ?? '(removed)'}"`));
        console.log(
          '\nIf only wording was polished, re-run with --force. If questions were inserted,\n' +
            'removed or reordered, put them back and add new ones at the END instead –\n' +
            'otherwise answers already recorded will sit under the wrong question.'
        );
        console.log('STATUS: CONFIRM_CHANGES');
        process.exit(1);
      }
    }

    const r = spawnSync(process.execPath, [join(root, 'scripts', 'seed.js'), id], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...readVars() },
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status !== 0) {
      console.log(out.trim());
      if (/fetch failed|ENOTFOUND|getaddrinfo/i.test(out))
        fail('NOT_REACHABLE_YET', 'The new web address is not reachable yet. Wait a minute and run this step again.');
      if (/403|forbidden/i.test(out))
        fail('ADMIN_KEY_MISMATCH', 'The app rejected the family admin key. Run: bash kit.sh keys --admin-only, then seed again.');
      fail('SEED_FAILED', 'Loading questions failed.');
    }
    writeFileSync(snapFile, JSON.stringify({ questions: cfg.questions }, null, 2));
    st.seeded = { ...(st.seeded || {}), [id]: { at: new Date().toISOString(), count: cfg.questions.length } };
    saveState(st);
    ok(`Loaded ${cfg.questions.length} questions for ${cfg.user.display_name}.`);
    commands.links();
  },

  links() {
    const ids = positional[0] ? [positional[0]] : people();
    for (const id of ids) {
      const l = links(id);
      if (!l) {
        warn(`${id}: not live yet.`);
        continue;
      }
      const { cfg } = loadPerson(id);
      console.log(`\n${cfg.user.display_name} (${id})`);
      info(`Link for ${cfg.user.display_name} (send this one):  ${l.parent}`);
      info(`Family listening page (keep private):  ${l.review}`);
      info(`Memoir to read or print (keep private): ${l.memoir}`);
    }
  },

  async doctor() {
    const vars = readVars();
    const st = loadState();
    if (!vars.BASE_URL) fail('DEPLOY', 'Not deployed yet.');
    const home = await fetch(vars.BASE_URL).catch(() => null);
    home && home.ok ? ok('App is reachable') : fail('NOT_REACHABLE_YET', `${vars.BASE_URL} is not reachable yet.`);
    const sec = wrangler(['secret', 'list']);
    for (const n of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ADMIN_KEY']) {
      sec.out.includes(n) ? ok(`${n} is stored`) : warn(`${n} is missing – run: bash kit.sh keys`);
    }
    for (const id of positional[0] ? [positional[0]] : people()) {
      const { cfg } = loadPerson(id);
      if (!cfg.user.token) {
        warn(`${id}: not loaded yet`);
        continue;
      }
      const r = await fetch(`${vars.BASE_URL}/api/questions?token=${encodeURIComponent(cfg.user.token)}`).catch(() => null);
      const n = r && r.ok ? ((await r.json()).questions || []).length : 0;
      n ? ok(`${id}: ${n} questions live`) : warn(`${id}: link does not work yet – run: bash kit.sh seed ${id}`);
      const a = await fetch(`${vars.BASE_URL}/review?token=${encodeURIComponent(cfg.user.token)}&admin=${encodeURIComponent(vars.ADMIN_KEY || '')}`).catch(() => null);
      a && a.ok ? ok(`${id}: family listening page works`) : warn(`${id}: family page refused the admin key – run: bash kit.sh keys --admin-only`);
    }
    if (st.keysSet) info('Tip: open the parent link yourself and answer one question to hear the voice and a follow-up.');
  },
};

function page(errors, done = false) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const body = done
    ? `<h1>All set ✓</h1><p>Both keys work and are stored safely in your Cloudflare account. You can close this tab and go back to Claude.</p>`
    : `<h1>Connect the voice and the interviewer</h1>
<p>The memoir app uses two AI services. Each needs a key from an account in <b>your</b> name, with a little prepaid credit (US$5–10 each lasts a long time).</p>
${errors.map((e) => `<p class="err">${esc(e)}</p>`).join('')}
<form method="post" autocomplete="off">
<label>1 · OpenAI key <small>(listens to answers and speaks the questions)</small></label>
<ol><li>Open <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a> and sign in or sign up.</li>
<li>Add credit under <a href="https://platform.openai.com/settings/organization/billing" target="_blank">Billing</a>.</li>
<li>Click <b>Create new secret key</b>, copy it, paste below.</li></ol>
<input name="openai" type="password" placeholder="sk-..." required>
<label>2 · Anthropic key <small>(Claude, the gentle interviewer)</small></label>
<ol><li>Open <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com/settings/keys</a> and sign in or sign up.</li>
<li>Add credit under <a href="https://console.anthropic.com/settings/billing" target="_blank">Billing</a>.</li>
<li>Click <b>Create Key</b>, copy it, paste below.</li></ol>
<input name="anthropic" type="password" placeholder="sk-ant-..." required>
<button>Check and save</button>
<p class="small">Keys go straight from this page to your own Cloudflare account. They are not saved on this computer and are never shown to Claude.</p>
</form>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memoir Kit – keys</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222;background:#f7f4ee}
h1{font-size:26px}label{display:block;font-weight:600;margin-top:24px}input{width:100%;font-size:17px;padding:10px;border:1px solid #bbb;border-radius:8px;box-sizing:border-box}
button{margin-top:24px;font-size:18px;padding:12px 24px;border:0;border-radius:10px;background:#2f7d4f;color:#fff;cursor:pointer}
.err{background:#fde8e8;border-radius:8px;padding:10px}.small{color:#666;font-size:14px}ol{margin:6px 0 10px}</style>${body}`;
}

if (!commands[cmd]) fail('UNKNOWN', `Unknown step "${cmd}". Steps: ${Object.keys(commands).join(', ')}`);
await commands[cmd]();
