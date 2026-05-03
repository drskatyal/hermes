import { db } from "@hermes/shared/db";
import type { ActionExecutionResult, ReminderData } from "@hermes/shared/types";

export async function executeReminder(
  data: ReminderData,
  captureId: string,
): Promise<ActionExecutionResult> {
  const remindAt = new Date(data.remindAt);
  const reminder = await db.reminder.create({
    data: { text: data.text, remindAt },
  });
  await db.action.create({
    data: { captureId, skill: "reminder", payload: data as object, reminderId: reminder.id },
  });
  const when = remindAt.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return { skill: "reminder", recordId: reminder.id, summary: `⏰ Reminder: "${reminder.text}" at ${when}` };
}
