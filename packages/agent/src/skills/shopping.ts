import { db } from "@hermes/shared/db";
import type { ActionExecutionResult, ShoppingData } from "@hermes/shared/types";

export async function executeShopping(
  data: ShoppingData,
  captureId: string,
): Promise<ActionExecutionResult> {
  const item = await db.shoppingItem.create({
    data: { name: data.name, qty: data.qty },
  });
  await db.action.create({
    data: { captureId, skill: "shopping", payload: data as object, shoppingItemId: item.id },
  });
  const qty = item.qty ? ` × ${item.qty}` : "";
  return { skill: "shopping", recordId: item.id, summary: `🛒 Added: ${item.name}${qty}` };
}
