import { db } from "@hermes/shared/db";
import { env, allowedTelegramIds } from "@hermes/shared/env";
import { logger } from "../lib/logger.js";

async function sendTelegram(chatId: number, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export async function sendMorningBrief(): Promise<void> {
  const ids = allowedTelegramIds();
  if (ids.length === 0) {
    logger.info("morning brief: no Telegram allowlist, skipping");
    return;
  }

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const weekEnd = new Date(start);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const [todayEvents, dueBills, dueReminders, openTasks, shopping] = await Promise.all([
    db.event.findMany({
      where: { startsAt: { gte: start, lt: end } },
      orderBy: { startsAt: "asc" },
    }),
    db.bill.findMany({
      where: { paid: false, dueDate: { lt: weekEnd } },
      orderBy: { dueDate: "asc" },
    }),
    db.reminder.findMany({
      where: { done: false, remindAt: { gte: start, lt: end } },
      orderBy: { remindAt: "asc" },
    }),
    db.task.findMany({ where: { done: false }, orderBy: { dueDate: "asc" }, take: 5 }),
    db.shoppingItem.findMany({ where: { bought: false } }),
  ]);

  const lines: string[] = [`🌅 Morning, Sanyam — ${start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`];

  if (todayEvents.length) {
    lines.push("\n📅 Today:");
    for (const e of todayEvents) {
      const t = e.startsAt.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
      lines.push(`  • ${t} — ${e.title}${e.location ? ` @ ${e.location}` : ""}`);
    }
  } else {
    lines.push("\n📅 No events today");
  }

  if (dueReminders.length) {
    lines.push("\n⏰ Reminders today:");
    for (const r of dueReminders) {
      const t = r.remindAt.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
      lines.push(`  • ${t} — ${r.text}`);
    }
  }

  if (dueBills.length) {
    lines.push("\n💷 Bills due this week:");
    for (const b of dueBills) {
      const d = b.dueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
      lines.push(`  • ${b.vendor} ${b.currency}${b.amount} — ${d}`);
    }
  }

  if (openTasks.length) {
    lines.push("\n✅ Open tasks:");
    for (const t of openTasks) {
      const due = t.dueDate ? ` (${t.dueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })})` : "";
      lines.push(`  • ${t.title}${due}`);
    }
  }

  if (shopping.length) {
    lines.push(`\n🛒 Shopping (${shopping.length}): ${shopping.map((s) => s.name).join(", ")}`);
  }

  const text = lines.join("\n");
  for (const id of ids) {
    try {
      await sendTelegram(id, text);
    } catch (err) {
      logger.error({ id, err }, "morning brief send failed");
    }
  }
  logger.info({ recipients: ids.length }, "morning brief sent");
}
