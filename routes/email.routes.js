const express = require("express");

const { authRequired } = require("../middlewares/auth");
const {
  getConnectUrl,
  oauthCallback,
  getStatus,
  getThreads,
  getThreadDetail,
  getDrafts,
  createComposeDraft,
  createReplyDraft,
  sendEmail,
  saveDraft,
  updateThreadState,
  disconnectGmail
} = require("../controllers/email.controller");

const emailRoutes = express.Router();

emailRoutes.get("/oauth/callback", oauthCallback);

emailRoutes.use(authRequired);

emailRoutes.get("/connect-url", getConnectUrl);
emailRoutes.get("/status", getStatus);
emailRoutes.delete("/status", disconnectGmail);
emailRoutes.get("/threads", getThreads);
emailRoutes.get("/threads/:threadId", getThreadDetail);
emailRoutes.post("/threads/:threadId/state", updateThreadState);
emailRoutes.get("/drafts", getDrafts);
emailRoutes.post("/drafts/compose", createComposeDraft);
emailRoutes.post("/drafts/reply", createReplyDraft);
emailRoutes.post("/drafts/save", saveDraft);
emailRoutes.post("/messages/send", sendEmail);

module.exports = { emailRoutes };
