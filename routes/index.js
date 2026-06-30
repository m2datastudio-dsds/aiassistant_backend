const express = require("express");

const { authRoutes } = require("./auth.routes");
const { chatRoutes } = require("./chat.routes");
const { emailRoutes } = require("./email.routes");
const { insightsRoutes } = require("./insights.routes");
const { reminderRoutes } = require("./reminder.routes");
const { vaultRoutes } = require("./vault.routes");
const { clipboardRoutes } = require("./clipboard.routes");
const { habitRoutes } = require("./habit.routes");

const routes = express.Router();

routes.use("/auth", authRoutes);
routes.use("/chat", chatRoutes);
routes.use("/email", emailRoutes);
routes.use("/insights", insightsRoutes);
routes.use("/reminders", reminderRoutes);
routes.use("/vault", vaultRoutes);
routes.use("/clipboard", clipboardRoutes);
routes.use("/habits", habitRoutes);

module.exports = { routes };

