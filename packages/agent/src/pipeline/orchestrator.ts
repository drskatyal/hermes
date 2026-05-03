import type { ActionExecutionResult, Channel } from "@hermes/shared/types";
import { chat, type ChatMessage } from "../lib/llm.js";
import { logger } from "../lib/logger.js";
import { systemPrompt } from "./prompt.js";
import { SKILL_TOOLS, executeTool } from "../skills/_registry.js";

export type OrchestratorInput = {
  text: string;
  channel: Channel;
  metadata?: Record<string, unknown>;
  captureId: string;
};

export type OrchestratorResult = {
  reply: string;
  actions: ActionExecutionResult[];
  provider: "grok" | "gemini";
  rounds: number;
};

const MAX_ROUNDS = 5;

export async function orchestrate(input: OrchestratorInput): Promise<OrchestratorResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: await systemPrompt() },
    {
      role: "user",
      content: JSON.stringify({
        text: input.text,
        channel: input.channel,
        metadata: input.metadata ?? {},
      }),
    },
  ];

  const actions: ActionExecutionResult[] = [];
  let provider: "grok" | "gemini" = "grok";
  let round = 0;

  for (round = 0; round < MAX_ROUNDS; round++) {
    const res = await chat({ messages, tools: SKILL_TOOLS, toolChoice: "auto" });
    provider = res.provider;
    logger.debug({ round, provider, tools: res.toolCalls.length, finish: res.finishReason }, "orchestrator round");

    messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });

    if (res.toolCalls.length === 0) {
      const reply = (res.content ?? "").trim() || (actions.length ? actions.map((a) => a.summary).join("\n") : "📝 Noted");
      return { reply, actions, provider, rounds: round + 1 };
    }

    for (const call of res.toolCalls) {
      try {
        const result = await executeTool(call.function.name, call.function.arguments, input.captureId);
        actions.push(result);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: true, summary: result.summary, recordId: result.recordId }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ tool: call.function.name, err: msg }, "tool execution failed");
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: msg }),
        });
      }
    }
  }

  logger.warn({ rounds: round }, "orchestrator hit MAX_ROUNDS");
  const reply = actions.length
    ? actions.map((a) => a.summary).join("\n")
    : "❌ Hermes ran too many rounds without finishing.";
  return { reply, actions, provider, rounds: round };
}
