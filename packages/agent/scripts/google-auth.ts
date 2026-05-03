// One-time bootstrap: run locally to obtain a Google OAuth refresh token.
// Usage:
//   1. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in your local .env
//   2. pnpm --filter @hermes/agent tsx scripts/google-auth.ts
//   3. Visit the printed URL, sign in with sanyam.assistant@gmail.com
//   4. Paste the redirected `?code=...` URL back into the terminal
//   5. Copy the printed refresh_token into Railway as GMAIL_REFRESH_TOKEN
import readline from "node:readline";
import { google } from "googleapis";

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT = "urn:ietf:wg:oauth:2.0:oob"; // out-of-band; user pastes code

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first.");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);

const url = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
});

console.log("\n1. Open this URL in a browser, sign in with the assistant Gmail account:\n");
console.log(url);
console.log("\n2. Copy the resulting code and paste it below.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("Paste code: ", async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2.getToken(code.trim());
    console.log("\n=== SUCCESS ===\n");
    console.log("Add this to Railway env vars:\n");
    console.log("GMAIL_REFRESH_TOKEN=" + tokens.refresh_token);
    console.log("\nKeep your CLIENT_ID and CLIENT_SECRET secret too.");
  } catch (err) {
    console.error("Failed to exchange code:", err);
    process.exit(1);
  }
});
