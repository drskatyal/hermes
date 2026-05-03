import { env } from "@hermes/shared/env";
import { logger } from "../lib/logger.js";

export async function transcribe(audioUrl: string): Promise<string> {
  if (!env.SONIOX_API_KEY) {
    throw new Error("SONIOX_API_KEY not set");
  }
  // Soniox v4 file transcription via URL.
  // Reference: https://soniox.com/docs/speech_to_text/api_reference/files
  const startRes = await fetch("https://api.soniox.com/v1/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SONIOX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      model: "stt-async-preview",
      language_hints: ["en"],
    }),
  });
  if (!startRes.ok) {
    throw new Error(`Soniox start failed: ${startRes.status} ${await startRes.text()}`);
  }
  const { id } = (await startRes.json()) as { id: string };

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await fetch(`https://api.soniox.com/v1/transcriptions/${id}`, {
      headers: { Authorization: `Bearer ${env.SONIOX_API_KEY}` },
    });
    if (!r.ok) continue;
    const job = (await r.json()) as { status: string };
    if (job.status === "completed") {
      const tr = await fetch(`https://api.soniox.com/v1/transcriptions/${id}/transcript`, {
        headers: { Authorization: `Bearer ${env.SONIOX_API_KEY}` },
      });
      const t = (await tr.json()) as { text?: string };
      return t.text ?? "";
    }
    if (job.status === "error") {
      throw new Error("Soniox transcription failed");
    }
  }
  logger.warn({ id }, "Soniox transcription timed out");
  throw new Error("Transcription timed out");
}
