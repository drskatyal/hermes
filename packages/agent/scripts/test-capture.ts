// Usage: pnpm test:capture "Mario shadowing Wednesday 2pm hot CT room"
import { ingest } from "../src/pipeline/ingest.js";

const text = process.argv.slice(2).join(" ");
if (!text) {
  console.error("Usage: pnpm test:capture <text>");
  process.exit(1);
}

const result = await ingest({
  channel: "pwa",
  inputType: "text",
  rawContent: text,
  reply: async (t) => console.log("REPLY:", t),
});
console.log("RESULT:", JSON.stringify(result, null, 2));
process.exit(0);
