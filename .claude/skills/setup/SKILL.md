---
name: setup
description: Guided, resumable first-time setup of the Memoir Kit – learn about the parent, write their questions, create the Cloudflare app, connect the AI keys, and hand over the parent's link. Use when the user says set up, get started, help, continue setup, or opens this folder for the first time.
---

# Memoir Kit setup wizard

Goal: by the end, the user has a private link to send their parent, and a
private family page to listen to the recordings. Aim for about 30–45 minutes,
most of it spent on the questions.

Always begin with:

```bash
bash kit.sh status
```

The first run may take a couple of minutes: `kit.sh` downloads a private copy
of Node.js into this folder if the computer doesn't have a recent one, and
installs the app's components. Tell the user that's what's happening. Run all
commands through `bash kit.sh …` (never bare `node`/`npm`), so that private
copy is used.

`status` ends with `NEXT: <step>`. Skip anything already done and say so in one
line ("You've already signed in to Cloudflare – picking up at the questions.").
If `kit.sh` reports a download or integrity failure, check the internet
connection and re-run; nothing needs installing by hand.

Give a short welcome on a fresh start: what we'll do in 4 parts (about your
parent → their questions → the online bits → the link), and that they can stop
any time and say "continue setup" later.

## Part 1 – About the parent (conversation, no tools)

Ask in small batches (2–3 questions per message), conversationally:

1. What do you call them, and what should the app call them? (e.g. "Mum", "Papa", "Nana")
2. Roughly how old are they, and how comfortable are they with a phone?
3. Which language(s) will they speak in? (They can mix two; the app's buttons are in English.)
4. Where did they grow up, and where have they lived since?
5. Their working life, marriage/partner, children – whatever the user is happy to share.
6. Big chapters or turning points (migration, war, a business, an illness…).
7. **Anything to steer away from** (a painful loss, a divorce, an estranged relative).
8. Should the voice be a man's or woman's, deeper or lighter?

Record the answers into a short `about` paragraph (names, places, chapters; ≤ 120
words) for `questions/<id>.json`. Pick an `id` like `mum`, `dad`, `nana`
(lowercase, no spaces). Map voice: deeper man → `onyx`; lighter man → `echo`;
warm woman → `shimmer`; brighter woman → `nova`; neutral → `alloy`/`sage`.

## Part 2 – Their questions

Follow the `/questions` skill to draft, review and validate
`questions/<id>.json`. Keep this collaborative: the user's edits matter most.
Don't move on until `bash kit.sh check-questions <id>` passes and the
user says they're happy (they can always add more later).

## Part 3 – The online bits

Explain once: "The app runs on your own free Cloudflare account, so the
recordings belong to you. It also needs two pay-as-you-go AI accounts (OpenAI
for the voice and listening, Anthropic for Claude the interviewer). Expect a few
dollars a month."

Walk these steps, running each command yourself and reporting in one line:

1. **Cloudflare account.** Ask: "Do you already have a Cloudflare account?"
   If not, open the sign-up page for them (`open https://dash.cloudflare.com/sign-up`
   on Mac, `start` on Windows) and say: "Sign up with your email and a password,
   then click the link in the verification email. Tell me when you're done." If
   Cloudflare offers a plan or a domain, they can skip it – nothing is needed.
2. **Sign in:** `bash kit.sh login` – tell them a browser tab will open;
   click **Allow**, then come back. (Run it with a generous timeout, ~5 min.)
   If the browser shows an error, re-run once; if they used a work account,
   suggest a separate personal one.
3. **Name it:** `bash kit.sh init --name <family surname>`.
   On `STATUS: PICK_ACCOUNT`, show the account names and ask which one; re-run
   with `--account <id>`.
4. **Storage + database:** `bash kit.sh resources`.
   On `STATUS: ENABLE_R2`, give them the link from the message, explain that
   Cloudflare asks for a card to switch storage on but the free tier (10 GB,
   years of recordings) isn't charged, wait for "done", re-run.
5. **Publish:** `bash kit.sh deploy`.
   This reserves their free web address (`<family>.workers.dev`) automatically
   the first time. Only on `STATUS: NEED_SUBDOMAIN` (rare), give them the link,
   suggest their surname as the address, wait, re-run.
6. **AI keys:** run `bash kit.sh keys` **in the background** – it opens
   a page in their browser and waits. Tell them: "A page has opened in your
   browser. It walks you through getting two keys and adding a little credit
   (about US$5–10 each). Paste them there – not here – and click *Check and
   save*." When the command finishes it prints whether the keys were stored.
   If they'd rather do it later, that's fine; everything else still works.

## Part 4 – Go live and hand over

1. `bash kit.sh seed <id>` – loads the questions and prints three
   links. On `NOT_REACHABLE_YET`, wait ~60 seconds and retry (up to 3 times).
2. `bash kit.sh doctor <id>`.
3. Ask the user to **try it themselves first** on their own phone: open the
   parent link, tap Begin, allow the microphone, answer one question, and listen
   for the follow-up. (Then on the family page they'll see their test answer –
   that's expected; it stays in the memoir as a test, so suggest a short one.)
4. Hand-over message, in plain words:
   - **Send only the first link** to the parent (WhatsApp/SMS is fine). Best:
     sit with them the first time, open it in Safari/Chrome, tap Begin, allow
     the microphone, and add it to the home screen (Share → *Add to Home Screen*
     on iPhone; ⋮ → *Add to Home screen* on Android).
   - They can stop any time; it remembers where they were. "Add a memory" is for
     anything off-script; "Choose a topic" lets them jump around.
   - **Keep the family listening page and memoir links private** – they include
     the family key.
   - Backups run every night automatically.
   - To change or add questions later, or add another parent, come back and say
     so (`/questions`). To get a Word document of the memoir: `bash kit.sh npm run export -- <id>`.
5. Ask them for beta feedback: what was confusing during setup, and later, how
   their parent found it. Suggest they note it in `FEEDBACK.md` in this folder
   (create it with a few headings) so they can send it to whoever shared the kit.
