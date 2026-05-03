import {
  CalendarData,
  BillData,
  ReminderData,
  TaskData,
  ShoppingData,
  NoteData,
  FlowradLogData,
  type ActionExecutionResult,
} from "@hermes/shared/types";
import type { ToolDef } from "../lib/llm.js";
import { executeCalendar } from "./calendar.js";
import { executeBill } from "./bill.js";
import { executeReminder } from "./reminder.js";
import { executeTask } from "./task.js";
import { executeShopping } from "./shopping.js";
import { executeNote } from "./note.js";
import { executeFlowradLog } from "./flowrad-log.js";
import { searchDrive, readDriveFile } from "../lib/drive.js";
import { googleConfigured } from "../lib/google.js";
import { runSubagent } from "../lib/subagent-runner.js";

export const SKILL_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "delegate_to_subagent",
      description:
        "Hand off a focused task to a registered specialist subagent (e.g. cesr_coach, flowrad_strategist). Use ONLY when an active subagent's charter cleanly matches the task. The subagent runs its own LLM loop with its own tool subset and returns a single result.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Subagent routing name (snake_case)" },
          task: { type: "string", description: "Self-contained task description for the subagent" },
        },
        required: ["name", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_drive",
      description:
        "Search Sanyam's Google Drive by keyword. Use when the input references a document by name, or when you need context from existing files (e.g. 'check my CESR portfolio doc').",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", default: 10 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_drive_file",
      description: "Read the text contents of a Drive file by id (returned from search_drive).",
      parameters: {
        type: "object",
        properties: { fileId: { type: "string" } },
        required: ["fileId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description:
        "Create a calendar event with a specific start time. Use for meetings, appointments, shadowing sessions, anything time-bound.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          startsAt: { type: "string", description: "ISO 8601 datetime, Europe/London if no zone given" },
          endsAt: { type: "string", description: "ISO 8601 datetime, optional" },
          location: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["title", "startsAt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_bill",
      description: "Record a bill with vendor, amount, and due date. Auto-creates a 3-day-before reminder event.",
      parameters: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string", default: "GBP" },
          dueDate: { type: "string", description: "ISO date" },
          notes: { type: "string" },
        },
        required: ["vendor", "amount", "dueDate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "Simple reminder with text + time. No metadata.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          remindAt: { type: "string", description: "ISO 8601 datetime" },
        },
        required: ["text", "remindAt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "TODO with optional due date. No specific time of day.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          details: { type: "string" },
          dueDate: { type: "string", description: "ISO date, optional" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_shopping_item",
      description: "Add ONE item to the shopping list. Call multiple times for multiple items.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          qty: { type: "string", description: "Free-text quantity, e.g. '2', '1 pack'" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Capture a thought, snippet, or general info. Use when no other skill fits.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_flowrad_log",
      description:
        "Note specifically about FlowRad (T-Pro, Radiopaedia, TechStaunch, IRIA, NHS pilots). Use ONLY when content explicitly references FlowRad business.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" },
          flowradTag: { type: "string", description: "e.g. tpro_acquisition, radiopaedia, techstaunch" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["content", "flowradTag"],
      },
    },
  },
];

export async function executeTool(
  name: string,
  rawArgs: string,
  captureId: string,
): Promise<ActionExecutionResult> {
  let args: unknown;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    throw new Error(`Tool ${name} got invalid JSON args: ${rawArgs}`);
  }
  switch (name) {
    case "delegate_to_subagent": {
      const a = args as { name: string; task: string };
      const r = await runSubagent(a.name, a.task, captureId);
      return {
        skill: "note",
        recordId: r.actions[0]?.recordId ?? "",
        summary: `🤖 ${a.name}: ${r.reply}`,
      };
    }
    case "search_drive": {
      if (!googleConfigured()) {
        return { skill: "note", recordId: "", summary: "(Drive not configured — skipping)" };
      }
      const q = (args as { query: string; limit?: number }).query;
      const lim = (args as { limit?: number }).limit ?? 10;
      const hits = await searchDrive(q, lim);
      return {
        skill: "note",
        recordId: "",
        summary: `Drive results: ${JSON.stringify(hits)}`,
      };
    }
    case "read_drive_file": {
      if (!googleConfigured()) {
        return { skill: "note", recordId: "", summary: "(Drive not configured — skipping)" };
      }
      const text = await readDriveFile((args as { fileId: string }).fileId);
      return { skill: "note", recordId: "", summary: text };
    }
    case "create_calendar_event":
      return executeCalendar(CalendarData.parse(args), captureId);
    case "create_bill":
      return executeBill(BillData.parse(args), captureId);
    case "create_reminder":
      return executeReminder(ReminderData.parse(args), captureId);
    case "create_task":
      return executeTask(TaskData.parse(args), captureId);
    case "add_shopping_item":
      return executeShopping(ShoppingData.parse(args), captureId);
    case "create_note":
      return executeNote(NoteData.parse(args), captureId);
    case "create_flowrad_log":
      return executeFlowradLog(FlowradLogData.parse(args), captureId);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
