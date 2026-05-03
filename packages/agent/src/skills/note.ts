import { db } from "@hermes/shared/db";
import type { ActionExecutionResult, NoteData } from "@hermes/shared/types";

export async function executeNote(
  data: NoteData,
  captureId: string,
): Promise<ActionExecutionResult> {
  const note = await db.note.create({
    data: { content: data.content, tags: data.tags ?? [] },
  });
  await db.action.create({
    data: { captureId, skill: "note", payload: data as object, noteId: note.id },
  });
  return { skill: "note", recordId: note.id, summary: `📝 Noted` };
}
