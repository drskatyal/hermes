import { env } from "@hermes/shared/env";
import { logger } from "./logger.js";

const GEMINI_OAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

export type AttachmentInput = {
  filename: string;
  mimeType: string;
  base64: string; // base64 (or base64url) encoded contents
};

const SYSTEM = `You are extracting structured info from a document attachment for Sanyam's personal assistant.

Output a SHORT plain-text description that captures:
- What the document is (receipt, invoice, statement, screenshot, photo, scan, schedule, contract, etc.)
- ALL legible text, transcribed verbatim with original line breaks where helpful.
- Key data: vendor, total, currency, date, due date, amounts, names, account numbers, addresses, phone numbers.
- For receipts/invoices: lead with the bill summary line "BILL: <vendor> <currency><amount> due <date>".

Plain text only. No JSON. No markdown headings. ~50-500 words.`;

export async function extractAttachment(att: AttachmentInput): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

  // Normalise base64url to base64
  const b64 = att.base64.replace(/-/g, "+").replace(/_/g, "/");

  // Gemini Vision via OpenAI-compatible endpoint accepts data URLs in image_url.
  // PDFs are also supported by Gemini 2.5 / 3 vision multimodal.
  const dataUrl = `data:${att.mimeType};base64,${b64}`;

  const res = await fetch(GEMINI_OAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GEMINI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.GEMINI_MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: `Extract structured info from this attachment (filename: ${att.filename}).` },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 1500,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.warn({ status: res.status, filename: att.filename, body: text.slice(0, 200) }, "attachment extract failed");
    return `[${att.filename}] (${att.mimeType}) — extraction failed`;
  }
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]?.message?.content ?? "";
}

export function isExtractableMime(mimeType: string): boolean {
  if (!mimeType) return false;
  if (mimeType.startsWith("image/")) return true;
  if (mimeType === "application/pdf") return true;
  return false;
}
