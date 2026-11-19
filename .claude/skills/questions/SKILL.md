---
name: questions
description: Write, tailor, review or change a parent's memoir questions (questions/<id>.json), add another parent, and load changes into the live app safely. Use when the user wants to customise, add, edit, reword or reorder questions, or set up a second parent.
---

# Writing a parent's questions

The questions are **spoken aloud to an older person** and answered by voice.
Claude in the app adds up to 2 gentle follow-ups per question, so each question
only needs to open a door.

## File format – `questions/<id>.json`

```json
{
  "user": {
    "id": "mum",
    "display_name": "Mum",
    "token": "",
    "language_primary": "en",
    "language_secondary": "ta",
    "voice": "shimmer",
    "about": "Grew up in Ipoh, Malaysia, the eldest of six. Trained as a nurse in London in the 1960s..."
  },
  "questions": [
    { "theme": "Childhood in Ipoh", "text": "What do you remember about the house you grew up in, in Ipoh?" }
  ]
}
```

- `id` = file name. `token` stays `""` – the seed step creates the private link.
- `language_secondary` optional (ISO code, e.g. `hi`, `zh`, `ms`, `ta`, `es`).
- `about` is private background so follow-ups recognise names and places. It is
  never read out.

## Drafting a new set

1. Start from `questions/_starter.json` (11 themes, 56 generic questions).
2. Use what the user told you about the parent to make it **theirs**:
   - Rename themes to their life ("Childhood" → "Growing up in Ipoh",
     "Work & purpose" → "Nursing in London").
   - Rewrite generic questions with real names, places and chapters ("How did
     you meet Dad?" not "How did you meet the person you married?").
   - Add 2–5 specific questions per major chapter the user mentioned.
   - Drop questions that don't fit (no "Love & marriage" theme for someone who
     never married, unless the user wants it) and anything touching the
     "steer away from" list. Treat losses gently or leave them out.
3. Aim for **40–80 questions**, 6–12 themes, roughly chronological, with lighter
   questions first so the first session feels easy and rewarding.
4. Style rules: one question at a time; under ~25 words; plain spoken words;
   warm and specific; no yes/no questions; no assumptions you weren't told.
5. Write the file, then run `bash kit.sh check-questions <id>` and fix
   anything it flags.

## Reviewing with the user

Show the draft **grouped by theme with numbers**, compactly (one line per
question). Invite edits in plain language: "drop 12", "add one about her
brother Raj", "make 'Work' its own section earlier". Apply, re-validate, and
show only what changed. Suggest they also ask a sibling to glance over it.

## Changing questions after recording has started

Answers are tied to a question's **position**. So once the parent has recorded
anything (check: `bash kit.sh status` shows the person as loaded):

- ✅ Add new questions **at the end** (they can still reach them any time via
  "Choose a topic"; you can reuse an existing theme name).
- ✅ Lightly reword a question without changing what it asks.
- ❌ Do not insert, delete or reorder earlier questions. If the user wants a
  question gone, explain it can't be removed safely but it's fine to leave it –
  the parent can skip with "Next".

Then load the change: `bash kit.sh seed <id>`. If it stops with
`STATUS: CONFIRM_CHANGES`, show the user the listed changes; only re-run with
`--force` if every change is wording-only.

## Adding another parent

Repeat Part 1 of `/setup` for them, create `questions/<newid>.json`, validate,
then `bash kit.sh seed <newid>`. Each parent gets their own link and
family page; the app, keys and storage are shared.
