import { gmailClient, googleConfigured } from "../lib/google.js";
import { logger } from "../lib/logger.js";
import { ingest } from "../pipeline/ingest.js";
import { triageEmail } from "../pipeline/email-triage.js";
import { extractAttachment, isExtractableMime } from "../lib/attachments.js";
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

type AttPart = {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string | null; data?: string | null } | null;
  parts?: AttPart[];
};

function collectAttachments(part: AttPart | undefined, out: AttPart[] = []): AttPart[] {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId && part.mimeType && isExtractableMime(part.mimeType)) {
    out.push(part);
  }
  if (part.parts) for (const p of part.parts) collectAttachments(p, out);
  return out;
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8MB cap per attachment

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

      // Extract attachments via Gemini vision (PDFs + images)
      const atts = collectAttachments(full.data.payload as AttPart);
      const attachmentTexts: string[] = [];
      for (const att of atts) {
        if (!att.body?.attachmentId || !att.mimeType || !att.filename) continue;
        try {
          const data = await gmail.users.messages.attachments.get({
            userId: "me",
            messageId: m.id,
            id: att.body.attachmentId,
          });
          const sizeBytes = (data.data.size as number | undefined) ?? 0;
          if (sizeBytes > MAX_ATTACHMENT_BYTES) {
            attachmentTexts.push(`[${att.filename}] (${att.mimeType}) — skipped (>${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB)`);
            continue;
          }
          const b64 = (data.data.data as string | undefined) ?? "";
          if (!b64) continue;
          const extracted = await extractAttachment({ filename: att.filename, mimeType: att.mimeType, base64: b64 });
          attachmentTexts.push(`--- attachment: ${att.filename} (${att.mimeType}) ---\n${extracted}`);
          logger.info({ filename: att.filename, mimeType: att.mimeType, length: extracted.length }, "gmail: attachment extracted");
        } catch (err) {
          logger.warn({ filename: att.filename, err: err instanceof Error ? err.message : String(err) }, "gmail: attachment extract failed");
        }
      }

      const fullBody = body || snippet;
      const attBlock = attachmentTexts.length ? `\n\n[ATTACHMENTS]\n${attachmentTexts.join("\n\n")}` : "";
      const text = `Email from ${from}\nSubject: ${subject}\n\n${fullBody}${attBlock}`.slice(0, 32000);

      await ingest({
        channel: "gmail",
        channelMsgId: m.id,
        inputType: "email",
        rawContent: text,
        metadata: { from, subject, threadId: full.data.threadId, attachmentCount: atts.length },
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
        body: `${fullBody}${attBlock}`,
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
