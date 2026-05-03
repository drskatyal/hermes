import { db } from "@hermes/shared/db";
import type { ActionExecutionResult, FlowradLogData } from "@hermes/shared/types";

export async function executeFlowradLog(
  data: FlowradLogData,
  captureId: string,
): Promise<ActionExecutionResult> {
  const tags = Array.from(new Set([...(data.tags ?? []), "FlowRad", data.flowradTag]));
  const note = await db.note.create({
    data: { content: data.content, tags },
  });
  await db.action.create({
    data: { captureId, skill: "flowrad_log", payload: data as object, noteId: note.id },
  });
  return {
    skill: "flowrad_log",
    recordId: note.id,
    summary: `🔶 FlowRad note logged (${data.flowradTag})`,
  };
}
