# FragLy — Codex Instructions

## Project Overview

FragLy is a single-file Valorant stats tracker (`index.html`, ~2700 lines).
No build tools, no npm, no framework — pure vanilla JS/CSS/HTML.
Data from HenrikDev API (`api.henrikdev.xyz/valorant`), baked API key in source.
AI coach uses Pollinations.ai (keyless, no user key needed).
PNG export via html2canvas@1.4.1.

## Key Files

- `index.html` — entire app, all logic, styles, and markup

## Important Constraints

- No fake/static/demo data anywhere in the UI. Real API values only.
- No build step. Edit `index.html` directly.
- Keep AI coach keyless (no user API key required).
- Mobile-first. Test on 390px viewport.

---

# Codex Instructions for This Repo

## Strict Caveman Method

Codex must respond in short, direct, low-token style.

### Default Style

- Be direct.
- Use short lines.
- No long paragraphs.
- No filler.
- No over-explaining.
- No teaching unless asked.
- No repeated explanations.
- No "Let me explain" unless requested.
- Prefer action over discussion.
- Keep responses short even when the task is complex.

### Before Editing Code

Use max 3 short lines.

Format:

Problem:
<short problem>

Fix:
<short fix>

Files:
<files to check/edit>

Example:

Problem:
app/layout.tsx has raw HTML.

Fix:
Rebuild it as proper Next.js root layout.

Files:
app/layout.tsx

### While Working

- Do not narrate every small step.
- Do not explain obvious framework basics.
- Do not repeat what the user already knows.
- Only mention important findings.
- Keep detailed notes inside .Codex/progress/, not in chat.
- If using tools, do the work instead of writing long plans.
- Avoid token-wasting summaries during the task.

### After Editing Code

Use this final format only:

Done.

Changed:
- path/to/file — short note

Tested:
- what was checked

Notes:
- only important warnings or follow-ups

Rules:
- Max 5 bullets under Changed.
- Max 3 bullets under Tested.
- Max 3 bullets under Notes.
- No long final explanation.

### Code Output Rules

- If I ask for full code, give full copy-paste-ready code.
- If I ask for a fix, edit only the needed files.
- Do not rewrite the whole project unless I clearly ask.
- Do not create fake features.
- Do not create fake buttons.
- Do not create fake data.
- Do not remove existing working features unless asked.
- Preserve the existing design direction unless asked to overhaul it.

### Repo Awareness

- Read AGENTS.md first.
- Check existing project structure before editing.
- Use existing patterns, components, styling, naming, and architecture.
- Do not scan the entire repo repeatedly unless needed.
- If relevant files were already inspected in the current session, continue from that context.
- Do not blindly rewrite the whole app.
- Find the smallest relevant set of files for the task.
- Ask only when truly blocked.

### UI / UX Rules

Default UI direction:
- Premium.
- Cinematic.
- Modern.
- Clean.
- Not generic AI-looking.
- Mobile responsive.
- Smooth but not bloated.
- Avoid ugly spacing, broken cards, bad alignment, and random colors.

Before final response, check:
- Mobile layout.
- Broken buttons.
- Console/build errors when possible.
- Obvious spacing issues.
- Fake or unfinished UI states.
- Any feature that looks clickable but does nothing.

### Working Method

For every task:

1. Understand the requested change.
2. Find the smallest relevant files.
3. Explain the plan briefly using Caveman Method.
4. Make the change.
5. Test or inspect the result.
6. Summarize shortly.

### Progress Notes

Use .Codex/progress/ for task-by-task notes.

For every meaningful task, create or update a progress markdown file.

Each progress file should include:
- What changed
- Why it changed
- Files edited
- How it was tested
- Follow-ups or known issues

Do not put long progress details in chat.
Put them in .Codex/progress/.
