import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { google } from "googleapis";
import { env } from "@hermes/shared/env";

export const googleOauth = new Hono();

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive.readonly",
];

const COOKIE = "hermes_session";

function authed(c: import("hono").Context): boolean {
  const expected = env.DASHBOARD_PASSWORD || env.INTERNAL_API_KEY;
  return !!expected && getCookie(c, COOKIE) === expected;
}

function redirectUri(c: import("hono").Context): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}/oauth/google/callback`;
}

googleOauth.get("/oauth/google/start", (c) => {
  if (!authed(c)) return c.redirect("/login");
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    return c.text("GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not set on Railway yet", 500);
  }
  const oauth2 = new google.auth.OAuth2(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET, redirectUri(c));
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    include_granted_scopes: true,
  });
  return c.redirect(url);
});

googleOauth.get("/oauth/google/callback", async (c) => {
  if (!authed(c)) return c.redirect("/login");
  const code = c.req.query("code");
  const error = c.req.query("error");
  if (error) return c.text(`OAuth error: ${error}`, 400);
  if (!code) return c.text("Missing code", 400);

  const oauth2 = new google.auth.OAuth2(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET, redirectUri(c));
  try {
    const { tokens } = await oauth2.getToken(code);
    const refresh = tokens.refresh_token;
    if (!refresh) {
      return c.html(`<html><body style="font-family:system-ui;padding:40px;background:#0a0a0a;color:#eee">
        <h2>No refresh token returned</h2>
        <p>Try again — sometimes Google omits it on re-auth. Revoke access at <a style="color:#a78bfa" href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and retry <a style="color:#a78bfa" href="/oauth/google/start">/oauth/google/start</a>.</p>
      </body></html>`, 200);
    }
    return c.html(`<html><body style="font-family:system-ui;padding:40px;background:#0a0a0a;color:#eee;line-height:1.5">
      <h2>✅ Google connected</h2>
      <p>Copy this refresh token into Railway → hermes service → Variables → <code>GMAIL_REFRESH_TOKEN</code>:</p>
      <pre style="background:#18181b;padding:16px;border-radius:8px;border:1px solid #27272a;overflow:auto">${refresh.replace(/[<&]/g, (c) => ({ "<": "&lt;", "&": "&amp;" }[c] ?? c))}</pre>
      <p style="color:#a1a1aa;margin-top:24px">Scopes granted:</p>
      <ul style="color:#a1a1aa">
        ${SCOPES.map((s) => `<li><code>${s}</code></li>`).join("")}
      </ul>
      <p style="margin-top:24px"><a style="color:#a78bfa" href="/">← back to dashboard</a></p>
    </body></html>`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.text(`Token exchange failed: ${msg}`, 500);
  }
});
