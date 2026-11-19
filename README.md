# Memoir Kit (beta)

Help your mum or dad record the story of their life – just by talking.

They open a private link on their phone, hear a question read aloud in a warm
voice, tap one big button and answer. A gentle AI interviewer asks the odd
follow-up ("What was your brother's name?") then moves on. You get every
recording, a written transcript, and a memoir you can read, print or export to
Word. Nothing to install on their phone.

## What you need

- A Mac or Windows computer.
- **Claude** – the Claude desktop app (Code tab) or Claude Code, on a paid plan.
- About **an hour**, mostly spent shaping the questions with Claude.
- A card for three accounts in your name (Claude creates them with you during setup):
  - **Cloudflare** – hosts the app and keeps the recordings. Free.
  - **OpenAI** – the speaking voice and listening. Pay-as-you-go.
  - **Anthropic** – Claude, the interviewer. Pay-as-you-go.

  Typical cost: a few US dollars a month while your parent is recording.
  Start with US$5–10 credit on each AI account.

## Get started

Check the short list in [PREREQUISITES.md](PREREQUISITES.md) first. Nothing
needs installing apart from the Claude app.

1. Download this folder (the link you were sent) and unzip it somewhere you'll
   find it, e.g. Documents.
2. Open the folder in Claude (desktop app: Code tab → choose folder; or run
   `claude` inside it) and type:

   ```
   /setup
   ```

Claude will ask about your parent, write a personal set of questions with you,
set everything up, and give you the link to send them. If you stop halfway, open
the folder again and say **continue setup**.

## Later on

Just open the folder in Claude and ask, for example:

- "Add some questions about Dad's time in the navy"
- "Set this up for my mother-in-law too"
- "Give me the links again"
- "Make a Word document of the memoir so far"
- "Is everything healthy?"

## Your recordings are safe

- Everything lives in **your** Cloudflare account. Nobody else can see it.
- Recordings are never deleted by the app, and are backed up every night.
- Only the link ending in `/d/...` goes to your parent. Keep the family pages
  (`/review`, `/memoir`) private – they contain your family key.

## Beta feedback

This is an early version shared with friends. Please note anything confusing –
during setup and once your parent starts using it – in `FEEDBACK.md` and send
it back. Claude can help you write it.
