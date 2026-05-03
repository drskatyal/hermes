import { db } from "@hermes/shared/db";
import type { InboundCapture, ActionExecutionResult } from "@hermes/shared/types";
import { logger } from "../lib/logger.js";
import { classify } from "./classifier.js";
import { transcribe } from "./transcribe.js";
import { executeAction } from "../skills/_registry.js";
import { formatConfirmation } from "./confirmer.js";

export type IngestResult =
  | { status: "processed"; captureId: string; actions: ActionExecutionResult[] }
  | { status: "clarification_requested"; captureId: string; question: string }
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
    }

    const classification = await classify({
      text,
      channel: input.channel,
      metadata: input.metadata,
    });
    await db.capture.update({
      where: { id: capture.id },
      data: { classification: classification as object },
    });
    log.info({ confidence: classification.confidence, n: classification.actions.length }, "classified");

    if (classification.confidence < 0.7 && classification.needsClarification) {
      await input.reply(`❓ ${classification.needsClarification}`);
      await db.capture.update({
        where: { id: capture.id },
        data: { status: "clarification_requested" },
      });
      return {
        status: "clarification_requested",
        captureId: capture.id,
        question: classification.needsClarification,
      };
    }

    const results: ActionExecutionResult[] = [];
    for (const action of classification.actions) {
      results.push(await executeAction(action, capture.id));
    }

    await input.reply(formatConfirmation(results));
    await db.capture.update({ where: { id: capture.id }, data: { status: "processed" } });
    return { status: "processed", captureId: capture.id, actions: results };
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
