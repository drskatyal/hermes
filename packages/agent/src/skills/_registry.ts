import type { Action, ActionExecutionResult } from "@hermes/shared/types";
import { executeCalendar } from "./calendar.js";
import { executeBill } from "./bill.js";
import { executeReminder } from "./reminder.js";
import { executeTask } from "./task.js";
import { executeShopping } from "./shopping.js";
import { executeNote } from "./note.js";
import { executeFlowradLog } from "./flowrad-log.js";

export async function executeAction(
  action: Action,
  captureId: string,
): Promise<ActionExecutionResult> {
  switch (action.skill) {
    case "calendar":
      return executeCalendar(action.data, captureId);
    case "bill":
      return executeBill(action.data, captureId);
    case "reminder":
      return executeReminder(action.data, captureId);
    case "task":
      return executeTask(action.data, captureId);
    case "shopping":
      return executeShopping(action.data, captureId);
    case "note":
      return executeNote(action.data, captureId);
    case "flowrad_log":
      return executeFlowradLog(action.data, captureId);
  }
}
