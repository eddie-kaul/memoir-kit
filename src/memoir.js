// Builds the memoir as a self-contained HTML document (opens in any browser,
// prints to PDF, opens in Word). Used for the copy stored in R2 and backed up.

import * as store from './storage.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

export async function buildMemoirHTML(env, user) {
  const entries = await store.getTranscript(env, user.id);
  const addenda = await store.getAddenda(env, user.id);

  // Group answers by question (already ordered by order_index, then time).
  const groups = [];
  const byOrder = {};
  for (const r of entries) {
    if (!byOrder[r.order_index]) {
      byOrder[r.order_index] = { theme: r.theme, seed_text: r.seed_text, rows: [] };
      groups.push(byOrder[r.order_index]);
    }
    byOrder[r.order_index].rows.push(r);
  }

  let body = '';
  let lastTheme = null;
  for (const g of groups) {
    if (g.theme !== lastTheme) { body += `<h2>${esc(g.theme)}</h2>`; lastTheme = g.theme; }
    body += `<p class="q">${esc(g.seed_text)}</p>`;
    for (const r of g.rows) {
      if (r.role === 'question' && r.is_follow_up) body += `<p class="q">${esc(r.text)}</p>`;
      else if (r.role === 'answer') body += `<p class="a">${esc(r.text) || '<em>(recording saved — not transcribed)</em>'}</p>`;
    }
  }
  if (!groups.length) body += '<p><em>No answers recorded yet.</em></p>';

  if (addenda.length) {
    body += '<h2>Additional memories</h2>';
    for (const a of addenda) body += `<p class="a">${esc(a.text) || '<em>(recording saved — not transcribed)</em>'}</p>`;
  }

  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const title = `${esc(user.display_name)}'s Story`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 760px; margin: 0 auto; padding: 40px 24px; color: #1c1a17; line-height: 1.6; }
  h1 { font-size: 2rem; margin: 0 0 4px; }
  .sub { color: #777; font-style: italic; margin: 0 0 1.5em; }
  h2 { font-size: 1.3rem; margin: 1.8em 0 0.4em; color: #9a4a17; border-bottom: 1px solid #e4ddcf; padding-bottom: 4px; }
  p.q { font-weight: bold; margin: 1em 0 0.2em; }
  p.a { margin: 0 0 0.8em; white-space: pre-wrap; }
</style></head><body>
<h1>${title}</h1>
<p class="sub">A recorded life story · updated ${dateStr}</p>
${body}
</body></html>`;
}
