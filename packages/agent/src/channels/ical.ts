import { Hono } from "hono";
import { db } from "@hermes/shared/db";
import { env } from "@hermes/shared/env";

export const ical = new Hono();

function fmtICSDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function escapeICS(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

ical.get("/calendar.ics", async (c) => {
  const token = c.req.query("token");
  const expected = env.INTERNAL_API_KEY;
  if (!expected || token !== expected) {
    return c.text("unauthorized", 401);
  }

  const horizon = new Date();
  horizon.setMonth(horizon.getMonth() - 1);
  const events = await db.event.findMany({
    where: { startsAt: { gte: horizon } },
    orderBy: { startsAt: "asc" },
    take: 500,
  });

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hermes//Sanyam//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Hermes",
    "X-WR-TIMEZONE:Europe/London",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
  ];

  const now = fmtICSDate(new Date());
  for (const e of events) {
    const start = e.startsAt;
    const end = e.endsAt ?? new Date(start.getTime() + 60 * 60 * 1000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@hermes.sanyamkatyal.com`,
      `DTSTAMP:${now}`,
      `DTSTART:${fmtICSDate(start)}`,
      `DTEND:${fmtICSDate(end)}`,
      `SUMMARY:${escapeICS(e.title)}`,
    );
    if (e.location) lines.push(`LOCATION:${escapeICS(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeICS(e.description)}`);
    if (e.tags?.length) lines.push(`CATEGORIES:${e.tags.map(escapeICS).join(",")}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");

  return c.text(lines.join("\r\n"), 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Cache-Control": "private, max-age=60",
  });
});
