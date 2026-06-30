const express = require("express");

const { authRequired } = require("../middlewares/auth");
const {
  listNotes,
  createNote,
  deleteNote,
  askVault
} = require("../controllers/vault.controller");

const vaultRoutes = express.Router();

vaultRoutes.use(authRequired);

vaultRoutes.get("/notes", listNotes);
vaultRoutes.post("/notes", createNote);
vaultRoutes.delete("/notes/:id", deleteNote);
vaultRoutes.post("/ask", askVault);

module.exports = { vaultRoutes };
