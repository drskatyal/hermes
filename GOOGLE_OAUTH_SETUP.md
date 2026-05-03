# Google (Gmail + Drive) OAuth setup

Hermes uses **one** Google account (recommend `sanyam.assistant@gmail.com`) for both Gmail polling and Drive read access. ~10 minutes, one-time.

## 1. Google Cloud Console

1. Visit https://console.cloud.google.com/projectcreate
2. Project name: `hermes-personal`. Create.
3. APIs & Services → Library:
   - Enable **Gmail API**
   - Enable **Google Drive API**
4. APIs & Services → OAuth consent screen:
   - User Type: **External** (your account is the only test user)
   - App name: `Hermes`. Support email: yours.
   - Scopes — add: `gmail.modify`, `drive.readonly`
   - Test users — add your assistant Gmail address
5. APIs & Services → Credentials → Create Credentials → **OAuth client ID**:
   - Application type: **Desktop app**
   - Name: `hermes-cli`
   - Download the JSON. Note `client_id` and `client_secret`.

## 2. Generate refresh token (local, one-time)

```bash
cd D:\Assistant
$env:GMAIL_CLIENT_ID="<from JSON>"
$env:GMAIL_CLIENT_SECRET="<from JSON>"
pnpm --filter @hermes/agent tsx scripts/google-auth.ts
```

It prints a URL. Open it, sign in with `sanyam.assistant@gmail.com`, click "Allow", copy the code shown, paste back into the terminal. The script prints `GMAIL_REFRESH_TOKEN=...`.

## 3. Set in Railway

In Railway → hermes service → Variables, add:

```
GMAIL_CLIENT_ID=<from JSON>
GMAIL_CLIENT_SECRET=<from JSON>
GMAIL_REFRESH_TOKEN=<from script>
GMAIL_ASSISTANT_ADDRESS=sanyam.assistant@gmail.com
```

## 4. Forward your inbox to the assistant

In your normal Gmail (Settings → Forwarding) or any inbox of interest, set up forwarding rules → `sanyam.assistant@gmail.com` for any email you want Hermes to triage.

Hermes polls every 2 minutes, classifies each email through the same Grok orchestrator, creates the right records (bills, events, tasks, notes), then marks the message read. **Hermes never auto-replies emails.**
