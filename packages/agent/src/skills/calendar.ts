import { db } from "@hermes/shared/db";
import type { ActionExecutionResult, CalendarData } from "@hermes/shared/types";
import { pushEventToGoogleCal } from "../lib/google-calendar.js";
import { logger } from "../lib/logger.js";

export async function executeCalendar(
  data: CalendarData,
  captureId: string,
): Promise<ActionExecutionResult> {
  const event = await db.event.create({
    data: {
      title: data.title,
      description: data.description,
      startsAt: new Date(data.startsAt),
      endsAt: data.endsAt ? new Date(data.endsAt) : null,
      location: data.location,
      tags: data.tags ?? [],
    },
  });
  await db.action.create({
    data: { captureId, skill: "calendar", payload: data as object, eventId: event.id },
  });

  // Sync to Google Calendar (fire-and-forget; don't fail on errors)
  pushEventToGoogleCal({
    title: event.title,
    description: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    location: event.location,
    tags: event.tags,
  })
    .then(async (gid) => {
      if (gid) {
        await db.event.update({ where: { id: event.id }, data: { googleEventId: gid } });
      }
    })
    .catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "calendar sync error"));

  const when = event.startsAt.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const loc = event.location ? ` @ ${event.location}` : "";
  return {
    skill: "calendar",
    recordId: event.id,
    summary: `📅 Added "${event.title}" — ${when}${loc}`,
  };
}
