import { db } from "@hermes/shared/db";
import type { ActionExecutionResult, BillData } from "@hermes/shared/types";

export async function executeBill(
  data: BillData,
  captureId: string,
): Promise<ActionExecutionResult> {
  const due = new Date(data.dueDate);
  const remind = new Date(due.getTime() - 3 * 24 * 60 * 60 * 1000);
  remind.setHours(9, 0, 0, 0);

  const reminderEvent = await db.event.create({
    data: {
      title: `Bill due: ${data.vendor} ${data.currency ?? "GBP"}${data.amount}`,
      startsAt: remind,
      tags: ["bill"],
    },
  });

  const bill = await db.bill.create({
    data: {
      vendor: data.vendor,
      amount: data.amount,
      currency: data.currency ?? "GBP",
      dueDate: due,
      notes: data.notes,
      reminderEventId: reminderEvent.id,
    },
  });

  await db.action.create({
    data: { captureId, skill: "bill", payload: data as object, billId: bill.id },
  });

  const dueStr = due.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  return {
    skill: "bill",
    recordId: bill.id,
    summary: `💷 Bill: ${bill.vendor} ${bill.currency}${bill.amount} due ${dueStr}. Reminder set 3 days before.`,
  };
}
