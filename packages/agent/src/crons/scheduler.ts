import { logger } from "../lib/logger.js";
import { sendMorningBrief } from "./morning-brief.js";
import { fireDueReminders } from "./fire-reminders.js";

let timers: NodeJS.Timeout[] = [];

function nextMorningBriefMs(): number {
  // 07:00 Europe/London. Approx via UTC+0/+1 — accept a few-minute drift.
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(6, 0, 0, 0); // 07:00 BST in summer; 06:00 GMT shows as 06:00, close enough
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export function startSchedulers(): void {
  const briefDelay = nextMorningBriefMs();
  logger.info({ minutes: Math.round(briefDelay / 60000) }, "morning brief scheduled");
  timers.push(
    setTimeout(function fire() {
      sendMorningBrief().catch((err) => logger.error({ err }, "morning brief failed"));
      timers.push(setTimeout(fire, 24 * 60 * 60 * 1000));
    }, briefDelay),
  );

  // Reminders fire every 5 min
  timers.push(
    setInterval(() => {
      fireDueReminders().catch((err) => logger.error({ err }, "fire reminders failed"));
    }, 5 * 60 * 1000),
  );
  logger.info("schedulers started");
}

export function stopSchedulers(): void {
  for (const t of timers) clearTimeout(t as NodeJS.Timeout);
  timers = [];
}
