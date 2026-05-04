import { env } from "@hermes/shared/env";
import { logger } from "./logger.js";

export type NtfyOpts = {
  title?: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5; // 5 = max (bypass DND)
  tags?: string[]; // emoji shortcodes e.g. ["warning","email"]
  click?: string; // URL opened on tap
};

export async function ntfy(opts: NtfyOpts): Promise<void> {
  const topic = env.NTFY_TOPIC;
  if (!topic) return;
  const base = env.NTFY_SERVER || "https://ntfy.sh";
  const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
  if (opts.title) headers["Title"] = opts.title;
  if (opts.priority) headers["Priority"] = String(opts.priority);
  if (opts.tags?.length) headers["Tags"] = opts.tags.join(",");
  if (opts.click) headers["Click"] = opts.click;
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers,
      body: opts.message,
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "ntfy non-2xx");
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ntfy send failed");
  }
}
