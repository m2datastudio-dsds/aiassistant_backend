const express = require("express");
const { register, login, me, refresh, logout, switchOrganization } = require("../controllers/auth.controller");
const { authRequired } = require("../middlewares/auth");

const authRoutes = express.Router();

authRoutes.post("/register", register);
authRoutes.post("/login", login);
authRoutes.post("/refresh", refresh);
authRoutes.post("/logout", logout);
authRoutes.get("/me", authRequired, me);
authRoutes.post("/switch-organization", authRequired, switchOrganization);

module.exports = { authRoutes };

