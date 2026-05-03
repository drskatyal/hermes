import TelegramBot from "node-telegram-bot-api";
import { env, allowedTelegramIds } from "@hermes/shared/env";
import { logger } from "../lib/logger.js";
import { ingest } from "../pipeline/ingest.js";
import type { InboundCapture } from "@hermes/shared/types";

let bot: TelegramBot | null = null;

export function startTelegram(): void {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram channel disabled");
    return;
  }
  const allowed = new Set(allowedTelegramIds());
  if (allowed.size === 0) {
    logger.warn("TELEGRAM_ALLOWED_USER_IDS empty — Telegram channel will reject all users");
  }

  bot = new TelegramBot(token, { polling: true });
  logger.info("Telegram polling started");

  bot.on("message", async (msg) => {
    const userId = msg.from?.id;
    if (!userId || !allowed.has(userId)) {
      logger.warn({ userId, username: msg.from?.username }, "telegram: rejected unauthorized user");
      return;
    }

    const chatId = msg.chat.id;
    const reply = async (text: string) => {
      await bot!.sendMessage(chatId, text);
    };

    let inputType: InboundCapture["inputType"] = "text";
    let rawContent = msg.text ?? msg.caption ?? "";
    let audioUrl: string | undefined;

    if (msg.voice || msg.audio) {
      inputType = "voice";
      const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
      if (fileId && bot) {
        try {
          const link = await bot.getFileLink(fileId);
          audioUrl = link;
          rawContent = `[voice ${msg.voice?.duration ?? msg.audio?.duration ?? "?"}s]`;
        } catch (err) {
          logger.error({ err }, "telegram: failed to resolve voice file");
        }
      }
    } else if (msg.photo && msg.photo.length > 0) {
      inputType = "photo";
      rawContent = msg.caption ?? "[photo]";
      const largest = msg.photo[msg.photo.length - 1]!;
      try {
        const link = await bot!.getFileLink(largest.file_id);
        (msg as unknown as { _imageUrl?: string })._imageUrl = link;
        // also pass via audioUrl field which our pipeline reads as fallback
        audioUrl = link;
      } catch (err) {
        logger.error({ err }, "telegram: failed to resolve photo file");
      }
    } else if (msg.document) {
      inputType = "file";
      rawContent = msg.caption ?? `[file: ${msg.document.file_name}]`;
    }

    if (!rawContent) {
      await reply("I got an empty message — try again with text or voice.");
      return;
    }

    await ingest({
      channel: "telegram",
      channelMsgId: String(msg.message_id),
      inputType,
      rawContent,
      audioUrl,
      metadata: {
        chatId,
        userId,
        username: msg.from?.username,
        date: msg.date,
        imageUrl: audioUrl && inputType === "photo" ? audioUrl : undefined,
      },
      reply,
    });
  });

  bot.on("polling_error", (err) => {
    logger.error({ err: err.message }, "telegram polling error");
  });
}

export function stopTelegram(): void {
  bot?.stopPolling().catch(() => {});
  bot = null;
}
