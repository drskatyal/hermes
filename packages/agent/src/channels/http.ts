import { Hono } from "hono";
import { z } from "zod";
import { env } from "@hermes/shared/env";
import { ingest } from "../pipeline/ingest.js";
import { logger } from "../lib/logger.js";
import { transcribeWithVoxtral } from "../lib/voxtral.js";

const CaptureBody = z.object({
  text: z.string().min(1),
  channel: z.enum(["siri", "pwa"]).default("pwa"),
  metadata: z.record(z.unknown()).optional(),
});

export const httpRoutes = new Hono();

httpRoutes.get("/health", (c) => c.json({ ok: true, service: "hermes-agent" }));

function authedBearer(c: import("hono").Context): boolean {
  const auth = c.req.header("authorization") ?? "";
  return !!env.INTERNAL_API_KEY && auth === `Bearer ${env.INTERNAL_API_KEY}`;
}

// POST /capture/audio
//   Accepts a single audio file. Two upload shapes supported:
//     1. multipart/form-data with field name "file" (or "audio")
//     2. raw audio body with Content-Type: audio/* (use ?channel= and ?lang= query params)
//   Returns { reply, transcript, ...result }
httpRoutes.post("/capture/audio", async (c) => {
  if (!authedBearer(c)) return c.json({ error: "unauthorized" }, 401);
  if (!env.MISTRAL_API_KEY) return c.json({ error: "MISTRAL_API_KEY not set on server" }, 500);

  const channel = (c.req.query("channel") as "siri" | "pwa" | undefined) ?? "siri";
  const language = c.req.query("lang") || c.req.query("language") || "en";
  const ctype = (c.req.header("content-type") ?? "").toLowerCase();

  let buffer: Buffer | null = null;
  let filename = "recording.m4a";
  let mimeType = "audio/m4a";

  try {
    if (ctype.startsWith("multipart/form-data")) {
      const form = await c.req.parseBody();
      const f = (form.file ?? form.audio) as File | undefined;
      if (!f) return c.json({ error: "no file part (use field name 'file' or 'audio')" }, 400);
      buffer = Buffer.from(await f.arrayBuffer());
      filename = f.name || filename;
      mimeType = f.type || mimeType;
    } else if (ctype.startsWith("audio/")) {
      const ab = await c.req.arrayBuffer();
      buffer = Buffer.from(ab);
      mimeType = ctype.split(";")[0]!.trim();
      const ext = mimeType.split("/")[1] || "m4a";
      filename = `recording.${ext}`;
    } else {
      return c.json({ error: "unsupported content-type; use multipart/form-data or audio/*" }, 415);
    }
  } catch (err) {
    return c.json({ error: "failed to read body", details: err instanceof Error ? err.message : String(err) }, 400);
  }

  if (!buffer || buffer.byteLength === 0) {
    return c.json({ error: "empty audio body" }, 400);
  }

  let transcript = "";
  try {
    transcript = (await transcribeWithVoxtral({ buffer, filename, mimeType, language })).trim();
  } catch (err) {
    return c.json({ error: "transcription failed", details: err instanceof Error ? err.message : String(err) }, 502);
  }
  if (!transcript) return c.json({ error: "empty transcript" }, 400);

  const replies: string[] = [];
  const result = await ingest({
    channel,
    inputType: "voice",
    rawContent: transcript,
    metadata: { transcribedBy: "voxtral", filename, mimeType },
    reply: async (t) => {
      replies.push(t);
    },
  });
  logger.info({ status: result.status, length: transcript.length }, "audio capture done");
  return c.json({ ...result, transcript, reply: replies.join("\n") });
});

httpRoutes.post("/capture", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const expected = `Bearer ${env.INTERNAL_API_KEY}`;
  if (!env.INTERNAL_API_KEY || auth !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = CaptureBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: "invalid body", details: body.error.flatten() }, 400);
  }
  const replies: string[] = [];
  const result = await ingest({
    channel: body.data.channel,
    inputType: "text",
    rawContent: body.data.text,
    metadata: body.data.metadata,
    reply: async (t) => {
      replies.push(t);
    },
  });
  logger.info({ status: result.status }, "http capture done");
  return c.json({ ...result, reply: replies.join("\n") });
});
