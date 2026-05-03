import { env } from "@hermes/shared/env";
import { logger } from "./logger.js";

const GEMINI_VISION_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

export type VisionInput =
  | { kind: "url"; url: string }
  | { kind: "base64"; base64: string; mimeType: string };

const VISION_PROMPT = `You are extracting structured information from an image for Sanyam Katyal's personal assistant.

Look at the image and produce a SHORT structured plain-text description that includes:
- What the image is (receipt, whiteboard, screenshot, photo of a document, food, place, person, etc.)
- ALL legible text, transcribed verbatim. For receipts: vendor, total, currency, date if visible. For whiteboards/notes: every line.
- Any names, dates, amounts, addresses, or phone numbers.

Output plain text only. No JSON. No markdown headings. ~50-300 words. If the image is unclear, say so in one line and stop.`;

export async function describeImage(input: VisionInput): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set for vision");
  const imagePart =
    input.kind === "url"
      ? { type: "image_url" as const, image_url: { url: input.url } }
      : {
          type: "image_url" as const,
          image_url: { url: `data:${input.mimeType};base64,${input.base64}` },
        };

  const res = await fetch(GEMINI_VISION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GEMINI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.GEMINI_MODEL,
      messages: [
        { role: "system", content: VISION_PROMPT },
        { role: "user", content: [imagePart, { type: "text", text: "Describe this image." }] },
      ],
      temperature: 0.1,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text.slice(0, 300) }, "vision request failed");
    throw new Error(`Gemini vision ${res.status}`);
  }
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]?.message?.content ?? "";
}
