import { env } from "@hermes/shared/env";
import { logger } from "./logger.js";

// Mistral Voxtral transcribe via their OpenAI-compatible audio.transcriptions endpoint
const MISTRAL_TRANSCRIBE_URL = "https://api.mistral.ai/v1/audio/transcriptions";

export type TranscribeOpts = {
  buffer: Buffer;
  filename: string;       // e.g. "recording.m4a"
  mimeType: string;       // "audio/m4a", "audio/mp4", "audio/wav", "audio/mpeg", "audio/webm", "audio/ogg"
  language?: string;      // e.g. "en"
};

export async function transcribeWithVoxtral(opts: TranscribeOpts): Promise<string> {
  if (!env.MISTRAL_API_KEY) {
    throw new Error("MISTRAL_API_KEY not set");
  }
  const form = new FormData();
  const blob = new Blob([opts.buffer], { type: opts.mimeType });
  form.append("file", blob, opts.filename);
  form.append("model", env.VOXTRAL_MODEL);
  if (opts.language) form.append("language", opts.language);

  const res = await fetch(MISTRAL_TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.MISTRAL_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text.slice(0, 300) }, "voxtral failed");
    throw new Error(`Voxtral ${res.status}`);
  }
  const json = (await res.json()) as { text?: string };
  return json.text ?? "";
}
