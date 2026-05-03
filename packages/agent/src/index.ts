import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { env } from "@hermes/shared/env";
import { logger } from "./lib/logger.js";
import { startTelegram, stopTelegram } from "./channels/telegram.js";
import { httpRoutes } from "./channels/http.js";

const app = new Hono();
app.route("/", httpRoutes);

const port = env.PORT;
const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, "Hermes agent listening");
});

startTelegram();

const shutdown = (sig: string) => {
  logger.info({ sig }, "shutting down");
  stopTelegram();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
