import { z } from "zod";

export const Channel = z.enum(["telegram", "gmail", "siri", "pwa"]);
export type Channel = z.infer<typeof Channel>;

export const InputType = z.enum(["text", "voice", "photo", "email", "file"]);
export type InputType = z.infer<typeof InputType>;

export const CalendarData = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  startsAt: z.string(),
  endsAt: z.string().optional(),
  location: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type CalendarData = z.infer<typeof CalendarData>;

export const BillData = z.object({
  vendor: z.string().min(1),
  amount: z.number(),
  currency: z.string().default("GBP"),
  dueDate: z.string(),
  notes: z.string().optional(),
});
export type BillData = z.infer<typeof BillData>;

export const ReminderData = z.object({
  text: z.string().min(1),
  remindAt: z.string(),
});
export type ReminderData = z.infer<typeof ReminderData>;

export const TaskData = z.object({
  title: z.string().min(1),
  details: z.string().optional(),
  dueDate: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type TaskData = z.infer<typeof TaskData>;

export const ShoppingData = z.object({
  name: z.string().min(1),
  qty: z.string().optional(),
});
export type ShoppingData = z.infer<typeof ShoppingData>;

export const NoteData = z.object({
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
});
export type NoteData = z.infer<typeof NoteData>;

export const FlowradLogData = NoteData.extend({
  flowradTag: z.string().min(1),
});
export type FlowradLogData = z.infer<typeof FlowradLogData>;

export const Action = z.discriminatedUnion("skill", [
  z.object({ skill: z.literal("calendar"), data: CalendarData }),
  z.object({ skill: z.literal("bill"), data: BillData }),
  z.object({ skill: z.literal("reminder"), data: ReminderData }),
  z.object({ skill: z.literal("task"), data: TaskData }),
  z.object({ skill: z.literal("shopping"), data: ShoppingData }),
  z.object({ skill: z.literal("note"), data: NoteData }),
  z.object({ skill: z.literal("flowrad_log"), data: FlowradLogData }),
]);
export type Action = z.infer<typeof Action>;
export type SkillName = Action["skill"];

export const ClassifierOutput = z.object({
  actions: z.array(Action).min(1),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
  needsClarification: z.string().optional(),
});
export type ClassifierOutput = z.infer<typeof ClassifierOutput>;

export type InboundCapture = {
  channel: Channel;
  channelMsgId?: string;
  inputType: InputType;
  rawContent: string;
  audioUrl?: string;
  metadata?: Record<string, unknown>;
  reply: (text: string) => Promise<void>;
};

export type ActionExecutionResult = {
  skill: SkillName;
  recordId: string;
  summary: string;
};
