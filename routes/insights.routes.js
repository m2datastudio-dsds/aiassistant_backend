const express = require("express");

const { authRequired } = require("../middlewares/auth");
const { getAppInsights } = require("../controllers/insights.controller");

const insightsRoutes = express.Router();

insightsRoutes.use(authRequired);
insightsRoutes.get("/", getAppInsights);

module.exports = { insightsRoutes };
