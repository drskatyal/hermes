import { gmailClient, googleConfigured } from "../lib/google.js";
import { logger } from "../lib/logger.js";
import { ingest } from "../pipeline/ingest.js";
import { triageEmail } from "../pipeline/email-triage.js";
import { env } from "@hermes/shared/env";

let timer: NodeJS.Timeout | null = null;
const POLL_MS = 2 * 60 * 1000;

function decodeBody(part: { body?: { data?: string | null } | null; parts?: any[] } | undefined): string {
  if (!part) return "";
  if (part.body?.data) {
    try {
      return Buffer.from(part.body.data, "base64url").toString("utf8");
    } catch {
      return "";
    }
  }
  if (part.parts) {
    for (const p of part.parts) {
      const t = decodeBody(p);
      if (t) return t;
    }
  }
  return "";
}

async function pollOnce(): Promise<void> {
  const gmail = gmailClient();
  const list = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread -from:me",
    maxResults: 10,
  });
  const messages = list.data.messages ?? [];
  if (messages.length === 0) return;
  logger.info({ count: messages.length }, "gmail: unread messages");

  for (const m of messages) {
    if (!m.id) continue;
    try {
      const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
      const headers = full.data.payload?.headers ?? [];
      const h = (name: string) => headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
      const subject = h("Subject");
      const from = h("From");
      const snippet = full.data.snippet ?? "";
      const body = decodeBody(full.data.payload as any);
      const text = `Email from ${from}\nSubject: ${subject}\n\n${body || snippet}`.slice(0, 12000);

      await ingest({
        channel: "gmail",
        channelMsgId: m.id,
        inputType: "email",
        rawContent: text,
        metadata: { from, subject, threadId: full.data.threadId },
        reply: async () => {
          // Hermes does NOT auto-reply emails per architecture rules.
        },
      });

      // Run a separate triage classifier in parallel — produces a Draft for review.
      triageEmail({
        threadId: full.data.threadId ?? undefined,
        messageId: m.id,
        fromAddress: from,
        subject,
        body: body || snippet,
      }).catch((err) => logger.error({ err: err instanceof Error ? err.message : String(err) }, "gmail: triage failed"));

      // Mark as read
      await gmail.users.messages.modify({
        userId: "me",
        id: m.id,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
    } catch (err) {
      logger.error({ id: m.id, err: err instanceof Error ? err.message : String(err) }, "gmail: process failed");
    }
  }
}

export function startGmail(): void {
  if (!googleConfigured()) {
    logger.warn("gmail: Google OAuth not configured, skipping");
    return;
  }
  if (!env.GMAIL_ASSISTANT_ADDRESS) {
    logger.warn("gmail: GMAIL_ASSISTANT_ADDRESS not set; polling 'me' on the OAuth-authenticated account");
  }
  logger.info({ pollMs: POLL_MS }, "gmail polling started");
  pollOnce().catch((err) => logger.error({ err: err instanceof Error ? err.message : String(err) }, "gmail initial poll failed"));
  timer = setInterval(() => {
    pollOnce().catch((err) => logger.error({ err: err instanceof Error ? err.message : String(err) }, "gmail poll failed"));
  }, POLL_MS);
}

export function stopGmail(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
