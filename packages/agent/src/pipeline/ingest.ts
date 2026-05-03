import { db } from "@hermes/shared/db";
import type { InboundCapture, ActionExecutionResult } from "@hermes/shared/types";
import { logger } from "../lib/logger.js";
import { orchestrate } from "./orchestrator.js";
import { transcribe } from "./transcribe.js";
import { describeImage } from "../lib/vision.js";

export type IngestResult =
  | { status: "processed"; captureId: string; actions: ActionExecutionResult[]; provider: string }
  | { status: "failed"; captureId: string; error: string };

export async function ingest(input: InboundCapture): Promise<IngestResult> {
  const capture = await db.capture.create({
    data: {
      channel: input.channel,
      channelMsgId: input.channelMsgId,
      inputType: input.inputType,
      rawContent: input.rawContent,
      rawMetadata: (input.metadata as object) ?? {},
      status: "pending",
    },
  });
  const log = logger.child({ captureId: capture.id, channel: input.channel });
  log.info({ inputType: input.inputType }, "capture received");

  try {
    let text = input.rawContent;
    if (input.inputType === "voice" && input.audioUrl) {
      text = await transcribe(input.audioUrl);
      await db.capture.update({ where: { id: capture.id }, data: { transcript: text } });
      log.info({ length: text.length }, "transcribed");
    } else if (input.inputType === "photo") {
      const photoUrl = (input.metadata?.imageUrl as string | undefined) ?? input.audioUrl;
      if (photoUrl) {
        const desc = await describeImage({ kind: "url", url: photoUrl });
        text = `[Photo] ${desc}${input.rawContent && input.rawContent !== "[photo]" ? `\n\nCaption: ${input.rawContent}` : ""}`;
        await db.capture.update({ where: { id: capture.id }, data: { transcript: text } });
        log.info({ length: text.length }, "image described");
      }
    }

    const result = await orchestrate({
      text,
      channel: input.channel,
      metadata: input.metadata,
      captureId: capture.id,
    });
    log.info({ provider: result.provider, rounds: result.rounds, actions: result.actions.length }, "orchestrated");

    await db.capture.update({
      where: { id: capture.id },
      data: {
        classification: {
          provider: result.provider,
          rounds: result.rounds,
          actions: result.actions.map((a) => ({ skill: a.skill, recordId: a.recordId })),
        } as object,
        status: "processed",
      },
    });

    await input.reply(result.reply);
    return { status: "processed", captureId: capture.id, actions: result.actions, provider: result.provider };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, "ingest failed");
    await db.capture.update({
      where: { id: capture.id },
      data: { status: "failed", errorMessage: msg },
    });
    try {
      await input.reply("❌ Hermes hit an error. I've logged it.");
    } catch {}
    return { status: "failed", captureId: capture.id, error: msg };
  }
}
