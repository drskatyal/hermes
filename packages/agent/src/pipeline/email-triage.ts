import { z } from "zod";
import { db } from "@hermes/shared/db";
import { env, allowedTelegramIds } from "@hermes/shared/env";
import { chat } from "../lib/llm.js";
import { logger } from "../lib/logger.js";
import { ntfy } from "../lib/ntfy.js";

const TriageOutput = z.object({
  triage: z.enum(["URGENT_PING", "REPLY_NEEDED", "LOG_ONLY", "IGNORE"]),
  reasoning: z.string(),
  draftReply: z.string().optional(),
});

const SYSTEM = `You are Hermes Email Triage, a junior assistant that processes Sanyam Katyal's forwarded emails.

# About Sanyam
- Locum Consultant Radiologist (UHDB), founder of FlowRad. Wife Shrishti, daughter Meher.
- Active deals: T-Pro acquisition, Radiopaedia partnership.
- Frequent contacts: Dr Rajeev Singh, Dr Rathy Kirke, Dr Mario Di Nunzio, Frank Gaillard, Jonathan Larbey, Mark Gilmartin, Hetal Patel, Riddhi, Karishma.

# Your job
Classify each email into ONE of:
- URGENT_PING — needs Sanyam's attention TODAY (medical scheduling, contract deadline, family urgent)
- REPLY_NEEDED — a reply is expected. You also draft a tactful first-pass reply.
- LOG_ONLY — informational; file as a note, no action.
- IGNORE — newsletter, marketing, transactional receipt with no action.

Output STRICT JSON:
{
  "triage": "<one of the four>",
  "reasoning": "<one sentence>",
  "draftReply": "<only if triage is REPLY_NEEDED; otherwise omit>"
}

# Draft reply rules (when REPLY_NEEDED)
- British English, professional, concise. 2-4 short paragraphs max.
- Sign off with "Sanyam".
- Do NOT commit to specific times/dates without explicit info from the email; use placeholders like "[propose time]" instead.
- Match the formality of the incoming email.
- Never invent facts about Sanyam's availability.

Today (Europe/London): ${new Date().toISOString()}`;

export async function triageEmail(meta: {
  threadId?: string;
  messageId?: string;
  fromAddress: string;
  subject: string;
  body: string;
}): Promise<void> {
  try {
    const res = await chat({
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `From: ${meta.fromAddress}\nSubject: ${meta.subject}\n\n${meta.body.slice(0, 8000)}`,
        },
      ],
      temperature: 0.2,
    });
    const raw = (res.content ?? "").trim();
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
    const v = TriageOutput.parse(parsed);

    if (v.triage === "IGNORE") {
      logger.info({ subject: meta.subject }, "email triage: ignored");
      return;
    }

    await db.emailDraft.create({
      data: {
        threadId: meta.threadId,
        messageId: meta.messageId,
        fromAddress: meta.fromAddress,
        subject: meta.subject,
        bodySnippet: meta.body.slice(0, 1000),
        triage: v.triage,
        draftReply: v.draftReply,
        reasoning: v.reasoning,
      },
    });
    logger.info({ triage: v.triage, subject: meta.subject }, "email triage: drafted");

    // Telegram alert for URGENT or REPLY_NEEDED via @Sanyamasstbot (Hermes Nous bot)
    if (v.triage === "URGENT_PING" || v.triage === "REPLY_NEEDED") {
      const emoji = v.triage === "URGENT_PING" ? "🚨" : "📨";
      const summary = `${meta.subject} — from ${meta.fromAddress}`;
      const msg = `${emoji} ${v.triage}\n${summary}\n\n${v.reasoning}\n\nDashboard: https://bot.sanyamkatyal.com/#drafts`;
      // Telegram alert
      if (env.TELEGRAM_BOT_TOKEN) {
        for (const id of allowedTelegramIds()) {
          fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: id, text: msg, disable_web_page_preview: true }),
          }).catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "telegram alert failed"));
        }
      }
      // ntfy.sh native iOS push
      ntfy({
        title: `${emoji} ${v.triage}`,
        message: summary,
        priority: v.triage === "URGENT_PING" ? 5 : 4,
        tags: v.triage === "URGENT_PING" ? ["rotating_light", "email"] : ["envelope"],
        click: "https://bot.sanyamkatyal.com/#drafts",
      }).catch(() => {});
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "email triage failed");
  }
}
