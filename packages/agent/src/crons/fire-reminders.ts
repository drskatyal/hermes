import { db } from "@hermes/shared/db";
import { env, allowedTelegramIds } from "@hermes/shared/env";
import { logger } from "../lib/logger.js";
import { ntfy } from "../lib/ntfy.js";

async function sendTelegram(chatId: number, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export async function fireDueReminders(): Promise<void> {
  const ids = allowedTelegramIds();
  if (ids.length === 0) return;

  const now = new Date();
  const due = await db.reminder.findMany({
    where: { done: false, remindAt: { lte: now } },
  });
  if (!due.length) return;

  for (const r of due) {
    const text = `⏰ Reminder: ${r.text}`;
    for (const id of ids) {
      try {
        await sendTelegram(id, text);
      } catch (err) {
        logger.error({ id, err }, "reminder send failed");
      }
    }
    ntfy({ title: "⏰ Reminder", message: r.text, priority: 4, tags: ["alarm_clock"] }).catch(() => {});
    await db.reminder.update({ where: { id: r.id }, data: { done: true, doneAt: now } });
  }
  logger.info({ fired: due.length }, "reminders fired");
}
