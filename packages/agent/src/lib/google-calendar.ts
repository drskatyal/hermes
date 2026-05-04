import { google } from "googleapis";
import { googleAuth, googleConfigured } from "./google.js";
import { logger } from "./logger.js";

export type CalendarSyncInput = {
  title: string;
  description?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  location?: string | null;
  tags?: string[];
};

const CALENDAR_ID = "primary";

export async function pushEventToGoogleCal(e: CalendarSyncInput): Promise<string | null> {
  if (!googleConfigured()) return null;
  try {
    const cal = google.calendar({ version: "v3", auth: googleAuth() });
    const start = e.startsAt;
    const end = e.endsAt ?? new Date(start.getTime() + 60 * 60 * 1000);
    const res = await cal.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: e.title,
        description: [e.description, e.tags?.length ? `Tags: ${e.tags.join(", ")}` : null]
          .filter(Boolean)
          .join("\n\n"),
        location: e.location ?? undefined,
        start: { dateTime: start.toISOString(), timeZone: "Europe/London" },
        end: { dateTime: end.toISOString(), timeZone: "Europe/London" },
        reminders: { useDefault: true },
        source: { title: "Hermes", url: "https://bot.sanyamkatyal.com" },
      },
    });
    logger.info({ id: res.data.id, title: e.title }, "google calendar: event created");
    return res.data.id ?? null;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), title: e.title }, "google calendar: insert failed");
    return null;
  }
}
