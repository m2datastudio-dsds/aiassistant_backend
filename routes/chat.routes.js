const express = require("express");
const { authRequired } = require("../middlewares/auth");
const {
  listConversations,
  listFavorites,
  getConversation,
  createConversation,
  createFavorite,
  updateConversationTitle,
  deleteConversation,
  deleteFavorite,
  sendMessage,
  runQuickAction,
  runConversationalOnboarding,
  regenerateResponse,
  editAndResendMessage
} = require("../controllers/chat.controller");

const chatRoutes = express.Router();

chatRoutes.use(authRequired);

chatRoutes.get("/conversations", listConversations);
chatRoutes.get("/favorites", listFavorites);
chatRoutes.post("/conversations", createConversation);
chatRoutes.post("/favorites", createFavorite);
chatRoutes.get("/conversations/:id", getConversation);
chatRoutes.post("/conversations/:id/title", updateConversationTitle);
chatRoutes.delete("/conversations/:id", deleteConversation);
chatRoutes.delete("/favorites/:id", deleteFavorite);

chatRoutes.post("/messages", sendMessage);
chatRoutes.post("/quick-actions", runQuickAction);
chatRoutes.post("/onboarding", runConversationalOnboarding);
chatRoutes.post("/messages/regenerate", regenerateResponse);
chatRoutes.post("/messages/edit-resend", editAndResendMessage);

module.exports = { chatRoutes };

