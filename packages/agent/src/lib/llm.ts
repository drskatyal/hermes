import { env } from "@hermes/shared/env";
import { logger } from "./logger.js";

export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatResponse = {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  provider: "grok" | "gemini";
};

export type ChatOptions = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "required" | "none";
  temperature?: number;
};

const XAI_URL = "https://api.x.ai/v1/chat/completions";
const GEMINI_OAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

async function callOpenAICompatible(
  url: string,
  apiKey: string,
  model: string,
  opts: ChatOptions,
): Promise<Omit<ChatResponse, "provider">> {
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices: Array<{
      message: { content: string | null; tool_calls?: ToolCall[] };
      finish_reason: string;
    }>;
  };
  const choice = json.choices[0];
  if (!choice) throw new Error("LLM returned no choices");
  return {
    content: choice.message.content ?? null,
    toolCalls: choice.message.tool_calls ?? [],
    finishReason: choice.finish_reason,
  };
}

async function callGrok(opts: ChatOptions): Promise<Omit<ChatResponse, "provider">> {
  if (!env.XAI_API_KEY) throw new Error("XAI_API_KEY not set");
  return callOpenAICompatible(XAI_URL, env.XAI_API_KEY, env.GROK_MODEL, opts);
}

async function callGemini(opts: ChatOptions): Promise<Omit<ChatResponse, "provider">> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  return callOpenAICompatible(GEMINI_OAI_URL, env.GEMINI_API_KEY, env.GEMINI_MODEL, opts);
}

export async function chat(opts: ChatOptions): Promise<ChatResponse> {
  const primary = env.LLM_PRIMARY;
  const order: Array<"grok" | "gemini"> = primary === "grok" ? ["grok", "gemini"] : ["gemini", "grok"];

  let lastErr: unknown;
  for (const provider of order) {
    try {
      const res = provider === "grok" ? await callGrok(opts) : await callGemini(opts);
      return { ...res, provider };
    } catch (err) {
      lastErr = err;
      logger.warn({ provider, err: err instanceof Error ? err.message : String(err) }, "llm provider failed, trying fallback");
    }
  }
  throw new Error(`All LLM providers failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
