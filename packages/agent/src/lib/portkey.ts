import { env } from "@hermes/shared/env";
import { logger } from "./logger.js";

const PORTKEY_URL = "https://api.portkey.ai/v1/chat/completions";

type PortkeyMessage = { role: "system" | "user" | "assistant"; content: string };

type PortkeyOptions = {
  messages: PortkeyMessage[];
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
};

export async function portkeyChat(opts: PortkeyOptions): Promise<string> {
  const apiKey = env.PORTKEY_API_KEY;
  const virtualKey =
    env.LLM_PRIMARY === "grok"
      ? env.PORTKEY_VIRTUAL_KEY_GROK
      : env.PORTKEY_VIRTUAL_KEY_GEMINI;

  if (!apiKey || !virtualKey) {
    throw new Error("Portkey not configured: set PORTKEY_API_KEY and PORTKEY_VIRTUAL_KEY_*");
  }

  const body = {
    messages: opts.messages,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.maxTokens ?? 1024,
    ...(opts.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
  };

  const res = await fetch(PORTKEY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portkey-api-key": apiKey,
      "x-portkey-virtual-key": virtualKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text }, "portkey error");
    throw new Error(`Portkey ${res.status}: ${text}`);
  }

  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return json.choices[0]?.message?.content ?? "";
}
