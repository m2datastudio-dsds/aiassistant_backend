const express = require("express");

const { authRoutes } = require("./auth.routes");
const { chatRoutes } = require("./chat.routes");
const { emailRoutes } = require("./email.routes");
const { reminderRoutes } = require("./reminder.routes");

const routes = express.Router();

routes.use("/auth", authRoutes);
routes.use("/chat", chatRoutes);
routes.use("/email", emailRoutes);
routes.use("/reminders", reminderRoutes);

module.exports = { routes };

