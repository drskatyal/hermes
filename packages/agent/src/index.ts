import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { env } from "@hermes/shared/env";
import { logger } from "./lib/logger.js";
import { startTelegram, stopTelegram } from "./channels/telegram.js";
import { startGmail, stopGmail } from "./channels/gmail.js";
import { httpRoutes } from "./channels/http.js";
import { dashboard } from "./channels/dashboard.js";
import { ical } from "./channels/ical.js";
import { googleOauth } from "./channels/google-oauth.js";
import { startSchedulers, stopSchedulers } from "./crons/scheduler.js";

const app = new Hono();
app.route("/", httpRoutes);
app.route("/", ical);
app.route("/", googleOauth);
app.route("/", dashboard);

const port = env.PORT;
const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, "Hermes agent listening");
});

startTelegram();
startGmail();
startSchedulers();

const shutdown = (sig: string) => {
  logger.info({ sig }, "shutting down");
  stopTelegram();
  stopGmail();
  stopSchedulers();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
