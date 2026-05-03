import { db } from "@hermes/shared/db";
import type { ActionExecutionResult } from "@hermes/shared/types";
import { chat, type ChatMessage } from "./llm.js";
import { logger } from "./logger.js";
import { SKILL_TOOLS, executeTool } from "../skills/_registry.js";

const MAX_ROUNDS = 6;

export type SubagentResult = {
  name: string;
  reply: string;
  actions: ActionExecutionResult[];
  rounds: number;
  provider: "grok" | "gemini";
};

export async function runSubagent(name: string, task: string, captureId: string): Promise<SubagentResult> {
  const sa = await db.subagent.findUnique({ where: { name } });
  if (!sa || !sa.enabled) {
    throw new Error(`subagent '${name}' not found or disabled`);
  }

  const allowed = new Set(sa.allowedTools);
  const tools = SKILL_TOOLS.filter((t) => allowed.has(t.function.name));
  if (tools.length === 0) {
    logger.warn({ name }, "subagent has no allowed tools, will reply without tool-use");
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are the "${sa.displayName}" subagent of Hermes (Sanyam Katyal's personal assistant). You have been spawned for a focused task.

# Your charter
${sa.description}

# Behaviour
${sa.systemPrompt}

# Rules
- Stay in scope. If the task is outside your charter, refuse with one short sentence and stop.
- Use tools to take action. Never fabricate effects; if you didn't call a tool, no record was created.
- After all tools complete, return ONE concise plain-text confirmation (no preamble, no apology).
- Today (Europe/London): ${new Date().toISOString()}`,
    },
    { role: "user", content: task },
  ];

  const actions: ActionExecutionResult[] = [];
  let provider: "grok" | "gemini" = "grok";
  let round = 0;

  for (round = 0; round < MAX_ROUNDS; round++) {
    const res = await chat({ messages, tools, toolChoice: tools.length ? "auto" : "none" });
    provider = res.provider;
    messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
    if (res.toolCalls.length === 0) {
      const reply = (res.content ?? "").trim() || "(subagent returned no reply)";
      return { name, reply, actions, rounds: round + 1, provider };
    }
    for (const call of res.toolCalls) {
      try {
        if (!allowed.has(call.function.name)) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ ok: false, error: `tool '${call.function.name}' not allowed for this subagent` }),
          });
          continue;
        }
        const r = await executeTool(call.function.name, call.function.arguments, captureId);
        actions.push(r);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: true, summary: r.summary, recordId: r.recordId }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, error: msg }) });
      }
    }
  }

  return {
    name,
    reply: actions.length ? actions.map((a) => a.summary).join("\n") : "(subagent ran out of rounds)",
    actions,
    rounds: round,
    provider,
  };
}

export async function listEnabledSubagents() {
  return db.subagent.findMany({ where: { enabled: true }, orderBy: { name: "asc" } });
}
