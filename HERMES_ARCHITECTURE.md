# Hermes — Personal Assistant Architecture & Build Plan

**Owner:** Sanyam Katyal
**Repo:** `github.com/<username>/hermes`
**Hosting:** Railway

See conversation for full architecture. This document is the source of truth for Claude Code working sessions.

## Quick reference

- **Stack:** Node 20 + Hono + TypeScript + Prisma + Postgres + Next.js (later)
- **LLM:** Gemini 2.5 Flash via Portkey (fallback Grok 4.1 Fast)
- **Voice:** Soniox v4
- **Channels:** Telegram (Phase 1), Gmail (Phase 4), Siri/PWA (Phase 5/7)
- **Single user:** drskatyal@gmail.com — hardcoded allowlist

## Hard rules

1. No NHS data ever.
2. No autonomous outbound emails. Drafts only.
3. One agent, many skills. No multi-agent fanout.
4. Code-only — no n8n / visual workflows.
5. pnpm only (never npm/yarn).
6. Never modify Prisma schema without explicit instruction.
7. Always validate classifier output with Zod.
8. Never commit secrets — `.env.example` only.

## Phases

1. Skeleton — Telegram bot replies "got it"
2. Database — captures persist to Postgres
3. Classifier + skills — full pipeline (calendar, bill, reminder, task, shopping, note, flowrad_log)
4. Gmail channel
5. Dashboard (Next.js)
6. Web push notifications
7. Siri Shortcut

## Skills (current)

- `calendar` — Event with startsAt/endsAt
- `bill` — vendor + amount + dueDate, auto-creates 3-day reminder Event
- `reminder` — text + remindAt
- `task` — title + optional dueDate
- `shopping` — single item, list-splitting handled by classifier
- `note` — content + tags
- `flowrad_log` — note tagged for FlowRad context (T-Pro, Radiopaedia, etc.)

## Confirmation reply formats

| Skill | Format |
|---|---|
| calendar | `Added "{title}" - {when} {at-location}` |
| bill | `Bill: {vendor} GBP{amount} due {date}. Reminder set 3 days before.` |
| reminder | `Reminder: "{text}" at {when}` |
| task | `Task: "{title}"{ - due date}` |
| shopping | `Added: {name}{ x qty}` |
| note | `Noted` |
| flowrad_log | `FlowRad note logged ({tag})` |

## Working agreement

- Read this doc first every session.
- pnpm only.
- Logging via `lib/logger.ts` (Pino). No `console.log`.
- Commit messages: `feat(skill): ...`, `fix(pipeline): ...`, `chore: ...`.
- Test locally with `pnpm test:capture "<input>"` before pushing.
