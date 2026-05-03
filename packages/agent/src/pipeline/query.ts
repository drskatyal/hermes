import { db } from "@hermes/shared/db";
import { chat, type ChatMessage, type ToolDef } from "../lib/llm.js";
import { logger } from "../lib/logger.js";
import { searchDrive, readDriveFile } from "../lib/drive.js";
import { googleConfigured } from "../lib/google.js";

const QUERY_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "list_events",
      description: "List calendar events in a date range (default: next 7 days).",
      parameters: {
        type: "object",
        properties: {
          fromIso: { type: "string" },
          toIso: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_unpaid_bills",
      description: "List bills that are not yet paid.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_open_tasks",
      description: "List undone tasks.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_open_reminders",
      description: "List undone reminders.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_shopping",
      description: "List unbought shopping items.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_drive",
      description: "Search Google Drive by keyword. Returns file ids and names.",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_drive_file",
      description: "Read text contents of a Drive file by id.",
      parameters: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] },
    },
  },
  {
    type: "function",
    function: {
      name: "search_notes",
      description: "Free-text search through saved notes (case-insensitive substring match).",
      parameters: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
    },
  },
];

async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_events": {
      const from = args.fromIso ? new Date(args.fromIso as string) : new Date();
      const to = args.toIso ? new Date(args.toIso as string) : new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
      return db.event.findMany({ where: { startsAt: { gte: from, lte: to } }, orderBy: { startsAt: "asc" } });
    }
    case "list_unpaid_bills":
      return db.bill.findMany({ where: { paid: false }, orderBy: { dueDate: "asc" } });
    case "list_open_tasks":
      return db.task.findMany({ where: { done: false }, orderBy: { createdAt: "desc" }, take: 50 });
    case "list_open_reminders":
      return db.reminder.findMany({ where: { done: false }, orderBy: { remindAt: "asc" }, take: 50 });
    case "list_shopping":
      return db.shoppingItem.findMany({ where: { bought: false } });
    case "search_drive": {
      if (!googleConfigured()) return { error: "drive not configured" };
      return searchDrive((args.q as string) ?? "");
    }
    case "read_drive_file": {
      if (!googleConfigured()) return { error: "drive not configured" };
      return readDriveFile((args.fileId as string) ?? "");
    }
    case "search_notes": {
      const q = (args.q as string) ?? "";
      return db.note.findMany({
        where: { content: { contains: q, mode: "insensitive" } },
        orderBy: { createdAt: "desc" },
        take: 30,
      });
    }
    default:
      throw new Error(`unknown query tool: ${name}`);
  }
}

const SYSTEM = `You are Hermes answering Sanyam's questions about his own data. You have read-only tools to look up events, bills, tasks, reminders, shopping, and notes. Call the tools you need, then answer concisely in plain text. Today (Europe/London): ${new Date().toISOString()}`;

export async function runQuery(question: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: question },
  ];
  for (let i = 0; i < 5; i++) {
    const res = await chat({ messages, tools: QUERY_TOOLS, toolChoice: "auto" });
    messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
    if (res.toolCalls.length === 0) return (res.content ?? "").trim() || "(no answer)";
    for (const call of res.toolCalls) {
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        const result = await runTool(call.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 8000),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ tool: call.function.name, err: msg }, "query tool failed");
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: msg }) });
      }
    }
  }
  return "Hermes ran out of rounds.";
}
