# Hermes

Personal assistant agent for Sanyam Katyal. Captures input from Telegram / Gmail / Siri / PWA, classifies into structured actions, persists to Postgres, replies via the same channel.

See [HERMES_ARCHITECTURE.md](./HERMES_ARCHITECTURE.md) for the full design.

## Local dev

```bash
pnpm install
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, DATABASE_URL, PORTKEY_*, SONIOX_API_KEY

# DB
pnpm db:generate
pnpm db:migrate

# run agent (dev, hot reload)
pnpm dev:agent
```

## Deploy (Railway)

1. Push to GitHub.
2. New Railway project -> deploy from repo.
3. Add Postgres plugin (DATABASE_URL injected automatically).
4. Set agent service root: `packages/agent`.
5. Add env vars per `.env.example`.
6. Railway runs `pnpm install && pnpm build:agent && pnpm start:agent`.

## Test capture from CLI

```bash
pnpm test:capture "Mario shadowing Wednesday 2pm hot CT room"
```

## Skills

calendar, bill, reminder, task, shopping, note, flowrad_log. Add a new skill: implement in `packages/agent/src/skills/`, register in `_registry.ts`, add type to `packages/shared/src/types.ts`, update prompt in `pipeline/prompt.ts`.
