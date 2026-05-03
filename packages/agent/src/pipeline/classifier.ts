import { ClassifierOutput, type Channel } from "@hermes/shared/types";
import { portkeyChat } from "../lib/portkey.js";
import { logger } from "../lib/logger.js";
import { systemPrompt } from "./prompt.js";

export type ClassifierInput = {
  text: string;
  channel: Channel;
  metadata?: Record<string, unknown>;
};

export async function classify(input: ClassifierInput): Promise<ClassifierOutput> {
  const userMsg = JSON.stringify({
    text: input.text,
    channel: input.channel,
    metadata: input.metadata ?? {},
  });

  const raw = await portkeyChat({
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: userMsg },
    ],
    jsonMode: true,
    temperature: 0.1,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error({ raw }, "classifier returned non-JSON");
    throw new Error("Classifier returned invalid JSON");
  }

  const result = ClassifierOutput.safeParse(parsed);
  if (!result.success) {
    logger.error({ errors: result.error.flatten(), raw }, "classifier output failed validation");
    throw new Error("Classifier output failed schema validation");
  }
  return result.data;
}
