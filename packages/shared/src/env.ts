import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  SANYAM_EMAIL: z.string().email().default("drskatyal@gmail.com"),

  XAI_API_KEY: z.string().optional().default(""),
  GEMINI_API_KEY: z.string().optional().default(""),
  GROK_MODEL: z.string().default("grok-4-fast"),
  GROK_GENERATOR_MODEL: z.string().default("grok-4-3"),
  GEMINI_MODEL: z.string().default("gemini-3-flash-latest"),
  LLM_PRIMARY: z.enum(["grok", "gemini"]).default("grok"),

  SONIOX_API_KEY: z.string().optional().default(""),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional().default(""),

  GMAIL_CLIENT_ID: z.string().optional().default(""),
  GMAIL_CLIENT_SECRET: z.string().optional().default(""),
  GMAIL_REFRESH_TOKEN: z.string().optional().default(""),
  GMAIL_ASSISTANT_ADDRESS: z.string().optional().default(""),

  VAPID_PUBLIC_KEY: z.string().optional().default(""),
  VAPID_PRIVATE_KEY: z.string().optional().default(""),
  VAPID_SUBJECT: z.string().optional().default("mailto:drskatyal@gmail.com"),

  INTERNAL_API_KEY: z.string().optional().default(""),
  DASHBOARD_PASSWORD: z.string().optional().default(""),
  OAUTH_REDIRECT_URI: z.string().optional().default(""),
  NTFY_TOPIC: z.string().optional().default(""),
  NTFY_SERVER: z.string().optional().default("https://ntfy.sh"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid env:", parsed.error.flatten().fieldErrors);
    throw new Error("Environment validation failed");
  }
  cached = parsed.data;
  return cached;
}

export const env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return loadEnv()[prop as keyof Env];
  },
});

export function allowedTelegramIds(): number[] {
  const raw = loadEnv().TELEGRAM_ALLOWED_USER_IDS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}
