import { db } from "@hermes/shared/db";
import type { ActionExecutionResult, TaskData } from "@hermes/shared/types";

export async function executeTask(
  data: TaskData,
  captureId: string,
): Promise<ActionExecutionResult> {
  const task = await db.task.create({
    data: {
      title: data.title,
      details: data.details,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      tags: data.tags ?? [],
    },
  });
  await db.action.create({
    data: { captureId, skill: "task", payload: data as object, taskId: task.id },
  });
  const due = task.dueDate
    ? ` — due ${task.dueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}`
    : "";
  return { skill: "task", recordId: task.id, summary: `✅ Task: "${task.title}"${due}` };
}
