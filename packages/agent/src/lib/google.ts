import { google } from "googleapis";
import { env } from "@hermes/shared/env";

let cached: ReturnType<typeof buildClient> | null = null;

function buildClient() {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new Error("Google OAuth not configured (GMAIL_CLIENT_ID / SECRET / REFRESH_TOKEN missing)");
  }
  const oauth2 = new google.auth.OAuth2(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
  return oauth2;
}

export function googleAuth() {
  if (!cached) cached = buildClient();
  return cached;
}

export function gmailClient() {
  return google.gmail({ version: "v1", auth: googleAuth() });
}

export function driveClient() {
  return google.drive({ version: "v3", auth: googleAuth() });
}

export function googleConfigured(): boolean {
  return !!(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
}
