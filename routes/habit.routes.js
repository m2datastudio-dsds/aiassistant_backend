const express = require("express");
const { authRequired } = require("../middlewares/auth");
const {
  listHabits,
  createHabit,
  getHabit,
  updateHabit,
  deleteHabit,
  completeHabit,
  dashboard,
  coach,
  nudges
} = require("../controllers/habit.controller");

const habitRoutes = express.Router();

habitRoutes.use(authRequired);

habitRoutes.get("/dashboard", dashboard);
habitRoutes.get("/nudges", nudges);
habitRoutes.post("/coach", coach);
habitRoutes.get("/", listHabits);
habitRoutes.post("/", createHabit);
habitRoutes.get("/:id", getHabit);
habitRoutes.put("/:id", updateHabit);
habitRoutes.delete("/:id", deleteHabit);
habitRoutes.post("/:id/complete", completeHabit);

module.exports = { habitRoutes };
