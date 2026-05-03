import { z } from "zod";
import { db } from "@hermes/shared/db";
import { env } from "@hermes/shared/env";
import { chat } from "./llm.js";
import { SKILL_TOOLS } from "../skills/_registry.js";
import { logger } from "./logger.js";

export const SubagentSpec = z.object({
  name: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, "name must be snake_case starting with a letter"),
  displayName: z.string().min(2).max(80),
  description: z.string().min(10).max(280),
  systemPrompt: z.string().min(40).max(4000),
  allowedTools: z.array(z.string()).min(0).max(50),
});
export type SubagentSpec = z.infer<typeof SubagentSpec>;

const GENERATOR_SYSTEM = `You are the Agent Generator: a senior prompt-engineering agent that designs new specialised subagents for Hermes (Sanyam Katyal's personal assistant orchestrator).

# What a Hermes subagent is
A focused, narrow agent invoked by the orchestrator for a specific recurring class of task. It has:
1. A snake_case routing name (e.g. cesr_coach, flowrad_strategist, family_planner)
2. A short user-facing display name
3. A one-line description used by the orchestrator to decide when to delegate to it
4. A system prompt that defines its role, knowledge, working style, and constraints
5. An allowlist of tools it may invoke

# About the principal user (Sanyam Katyal)
- Locum Consultant Radiologist at UHDB. Wife Shrishti, daughter Meher (1yo). Lives in Derby.
- Founder of FlowRad (AI radiology reporting). Active deals: T-Pro acquisition, Radiopaedia partnership.
- Building CESR portfolio for UK consultancy.
- Side projects: H1B Radar, CrimeRank UK, AgentHub.

# Available tools (you assign a SUBSET to each subagent)
{TOOLS}

# Your job
The user describes a capability they want. You output ONE strict JSON object matching:
{
  "name": "<snake_case>",
  "displayName": "<Title Case>",
  "description": "<one short sentence; the orchestrator reads this to route>",
  "systemPrompt": "<200-1500 words. Define identity, scope, working style, output expectations, refusal conditions. Reference Sanyam's context only when relevant.>",
  "allowedTools": ["tool_name", ...]
}

# Quality bar for systemPrompt
- Lead with identity: "You are <X>, the <role> for Sanyam..."
- Define scope precisely. List 3-5 specific responsibilities. List explicit non-goals.
- Specify reasoning style for the domain (e.g. "Always weigh CESR competency requirements before suggesting log entries").
- Define output style (concise vs detailed, structured vs prose, emoji prefixes).
- Define refusal: "If the request is outside <scope>, return one short refusal."
- No fluff, no marketing language, no apologies.
- Treat the subagent like a senior specialist colleague, not a chatbot.

# Tool selection rules
- Pick the MINIMUM viable tool set. Most subagents need 2-5 tools.
- A planning/coaching agent often needs only create_note, create_task, create_reminder.
- A research agent needs search_drive + read_drive_file + create_note.
- A logging agent needs create_note or create_flowrad_log.
- Never grant tools the subagent's charter doesn't justify.

# Output rules
- STRICT JSON only. No markdown, no prose, no code fences.
- name MUST be snake_case, 2-40 chars, alphanumeric + underscore, start with letter.
- description MUST be one sentence ≤ 280 chars.
- allowedTools MUST be a subset of the names listed above.

Today (Europe/London): {DATE}`;

export async function generateSubagent(userDescription: string): Promise<SubagentSpec> {
  const toolList = SKILL_TOOLS.map((t) => `- ${t.function.name}: ${t.function.description}`).join("\n");
  const sys = GENERATOR_SYSTEM.replace("{TOOLS}", toolList).replace("{DATE}", new Date().toISOString());

  // Use the most capable Grok model for generation, falling back to whatever's configured.
  const previousModel = process.env.GROK_MODEL;
  process.env.GROK_MODEL = env.GROK_GENERATOR_MODEL || env.GROK_MODEL;
  try {
    const res = await chat({
      messages: [
        { role: "system", content: sys },
        {
          role: "user",
          content: `Design a Hermes subagent for this capability:\n\n${userDescription}\n\nReturn ONLY the JSON object.`,
        },
      ],
      temperature: 0.4,
    });
    const raw = (res.content ?? "").trim();
    const parsed = extractJson(raw);
    const validated = SubagentSpec.parse(parsed);
    const validNames = new Set(SKILL_TOOLS.map((t) => t.function.name));
    validated.allowedTools = validated.allowedTools.filter((t) => validNames.has(t));
    return validated;
  } finally {
    if (previousModel !== undefined) process.env.GROK_MODEL = previousModel;
  }
}

function extractJson(s: string): unknown {
  const direct = tryParse(s);
  if (direct !== null) return direct;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const v = tryParse(fenced[1]);
    if (v !== null) return v;
  }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const v = tryParse(s.slice(first, last + 1));
    if (v !== null) return v;
  }
  throw new Error("agent generator returned non-JSON output");
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function saveSubagent(spec: SubagentSpec, generatedBy: string) {
  return db.subagent.upsert({
    where: { name: spec.name },
    create: { ...spec, generatedBy, enabled: true },
    update: {
      displayName: spec.displayName,
      description: spec.description,
      systemPrompt: spec.systemPrompt,
      allowedTools: spec.allowedTools,
      generatedBy,
    },
  });
}

export async function previewAndSave(userDescription: string) {
  const spec = await generateSubagent(userDescription);
  logger.info({ name: spec.name, tools: spec.allowedTools.length }, "agent generator: produced spec");
  return saveSubagent(spec, env.GROK_GENERATOR_MODEL || env.GROK_MODEL);
}
