const express = require("express");
const { authRequired } = require("../middlewares/auth");
const {
  listReminders,
  listDueReminders,
  createReminder,
  createReminderFromAi,
  updateReminder,
  completeReminder,
  deleteReminder
} = require("../controllers/reminder.controller");

const reminderRoutes = express.Router();

reminderRoutes.use(authRequired);

reminderRoutes.get("/", listReminders);
reminderRoutes.get("/due", listDueReminders);
reminderRoutes.post("/", createReminder);
reminderRoutes.post("/ai", createReminderFromAi);
reminderRoutes.put("/:id", updateReminder);
reminderRoutes.post("/:id/complete", completeReminder);
reminderRoutes.delete("/:id", deleteReminder);

module.exports = { reminderRoutes };
