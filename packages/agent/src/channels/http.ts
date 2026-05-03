import { Hono } from "hono";
import { z } from "zod";
import { env } from "@hermes/shared/env";
import { ingest } from "../pipeline/ingest.js";
import { logger } from "../lib/logger.js";

const CaptureBody = z.object({
  text: z.string().min(1),
  channel: z.enum(["siri", "pwa"]).default("pwa"),
  metadata: z.record(z.unknown()).optional(),
});

export const httpRoutes = new Hono();

httpRoutes.get("/health", (c) => c.json({ ok: true, service: "hermes-agent" }));

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
