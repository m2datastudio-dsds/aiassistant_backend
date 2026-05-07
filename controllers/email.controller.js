const { z } = require("zod");
const { google } = require("googleapis");

const { prisma } = require("../config/prisma");
const { env } = require("../config/env");
const { HttpError } = require("../utils/httpError");
const { generateAssistantReply } = require("../utils/aiClient");

const listThreadsSchema = z.object({
  maxResults: z.coerce.number().int().min(1).max(50).optional(),
  pageToken: z.string().min(1).optional(),
  q: z.string().min(1).optional()
});

const recipientListSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}, z.array(z.string().email()).max(20));

const composeDraftSchema = z.object({
  to: recipientListSchema.optional().default([]),
  subject: z.string().max(200).optional().default(""),
  context: z.string().min(1).max(4000),
  tone: z.string().max(60).optional().default("professional"),
  onboardingProfile: z
    .object({
      role: z.string().trim().min(1).max(80),
      primaryGoal: z.string().trim().min(1).max(240),
      experienceLevel: z.enum(["beginner", "intermediate", "advanced"]),
      priorities: z.array(z.string().trim().min(1).max(40)).min(1).max(5)
    })
    .optional()
});

const replyDraftSchema = z.object({
  threadId: z.string().min(1),
  tone: z.string().max(60).optional().default("professional"),
  additionalInstructions: z.string().max(1000).optional().default(""),
  onboardingProfile: z
    .object({
      role: z.string().trim().min(1).max(80),
      primaryGoal: z.string().trim().min(1).max(240),
      experienceLevel: z.enum(["beginner", "intermediate", "advanced"]),
      priorities: z.array(z.string().trim().min(1).max(40)).min(1).max(5)
    })
    .optional()
});

const sendEmailSchema = z.object({
  to: recipientListSchema,
  subject: z.string().max(200),
  body: z.string().min(1).max(20000),
  threadId: z.string().min(1).optional()
});

const saveDraftSchema = z.object({
  to: recipientListSchema,
  subject: z.string().max(200),
  body: z.string().min(1).max(20000),
  threadId: z.string().min(1).optional()
});

const threadActionSchema = z.object({
  starred: z.boolean().optional(),
  trashed: z.boolean().optional()
});

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email"
];

function ensureGmailConfigured() {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REDIRECT_URI) {
    throw new HttpError(
      500,
      "Gmail OAuth is not configured",
      "Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REDIRECT_URI in backend .env"
    );
  }
}

function createOAuthClient() {
  ensureGmailConfigured();
  return new google.auth.OAuth2(
    env.GMAIL_CLIENT_ID,
    env.GMAIL_CLIENT_SECRET,
    env.GMAIL_REDIRECT_URI
  );
}

function buildOAuthState({ userId, organizationId }) {
  return Buffer.from(
    JSON.stringify({
      userId,
      organizationId,
      issuedAt: Date.now()
    }),
    "utf8"
  ).toString("base64url");
}

function parseOAuthState(state) {
  try {
    const decoded = Buffer.from(String(state || ""), "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!parsed.userId || !parsed.organizationId) {
      throw new Error("Missing OAuth state fields");
    }
    return parsed;
  } catch {
    throw new HttpError(400, "Invalid Gmail OAuth state");
  }
}

async function buildConnectUrl({ userId, organizationId }) {
  const oauth2Client = createOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    state: buildOAuthState({ userId, organizationId })
  });
}

async function connectAccountFromCode({ code, state }) {
  const oauth2Client = createOAuthClient();
  const oauthState = parseOAuthState(state);
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: "me" });

  const existing = await prisma.gmailAccount.findUnique({
    where: {
      userId_organizationId: {
        userId: oauthState.userId,
        organizationId: oauthState.organizationId
      }
    }
  });

  const expiryDate = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
  return prisma.gmailAccount.upsert({
    where: {
      userId_organizationId: {
        userId: oauthState.userId,
        organizationId: oauthState.organizationId
      }
    },
    update: {
      email: profile.data.emailAddress || existing?.email || "unknown@gmail.com",
      accessToken: tokens.access_token || existing?.accessToken || "",
      refreshToken: tokens.refresh_token || existing?.refreshToken || null,
      scope: tokens.scope || existing?.scope || null,
      tokenType: tokens.token_type || existing?.tokenType || null,
      expiryDate,
      historyId: profile.data.historyId || existing?.historyId || null
    },
    create: {
      userId: oauthState.userId,
      organizationId: oauthState.organizationId,
      email: profile.data.emailAddress || "unknown@gmail.com",
      displayName: null,
      accessToken: tokens.access_token || "",
      refreshToken: tokens.refresh_token || null,
      scope: tokens.scope || null,
      tokenType: tokens.token_type || null,
      expiryDate,
      historyId: profile.data.historyId || null
    }
  });
}

async function getConnectedAccount({ userId, organizationId }) {
  return prisma.gmailAccount.findUnique({
    where: {
      userId_organizationId: {
        userId,
        organizationId
      }
    }
  });
}

function isGmailReconnectError(err) {
  const message = String(
    err?.message ||
      err?.response?.data?.error_description ||
      err?.response?.data?.error ||
      err?.cause?.message ||
      ""
  ).toLowerCase();

  return (
    message.includes("invalid_grant") ||
    message.includes("token has been expired or revoked") ||
    message.includes("expired or revoked") ||
    (err?.status === 401 && message.includes("invalid credentials")) ||
    (err?.status === 403 && message.includes("scope"))
  );
}

function toReconnectError(err) {
  if (err instanceof HttpError) return err;

  if (isGmailReconnectError(err)) {
    return new HttpError(
      401,
      "Gmail needs to be reconnected",
      "Disconnect and reconnect Gmail to refresh your Gmail access."
    );
  }

  return err;
}

async function getAuthorizedGmailClient({ userId, organizationId }) {
  const account = await getConnectedAccount({ userId, organizationId });
  if (!account) {
    throw new HttpError(404, "No Gmail account connected");
  }

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken || undefined,
    expiry_date: account.expiryDate ? account.expiryDate.getTime() : undefined
  });

  oauth2Client.on("tokens", async (tokens) => {
    await prisma.gmailAccount.update({
      where: { id: account.id },
      data: {
        accessToken: tokens.access_token || account.accessToken,
        refreshToken: tokens.refresh_token || account.refreshToken,
        scope: tokens.scope || account.scope,
        tokenType: tokens.token_type || account.tokenType,
        expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : account.expiryDate
      }
    });
  });

  return {
    account,
    gmail: google.gmail({ version: "v1", auth: oauth2Client })
  };
}

function encodeBase64Url(value) {
  return Buffer.from(String(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  if (!value) return "";
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function flattenParts(parts, collector = []) {
  for (const part of parts || []) {
    collector.push(part);
    if (part.parts?.length) flattenParts(part.parts, collector);
  }
  return collector;
}

function getHeader(headers, name) {
  return (
    headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || null
  );
}

function extractBody(payload) {
  if (!payload) return "";

  if (payload.body?.data) {
    return decodeHtmlEntities(decodeBase64Url(payload.body.data));
  }

  const allParts = flattenParts(payload.parts || []);
  const textPart =
    allParts.find((part) => part.mimeType === "text/plain" && part.body?.data) ||
    allParts.find((part) => part.mimeType === "text/html" && part.body?.data);

  return textPart?.body?.data ? decodeHtmlEntities(decodeBase64Url(textPart.body.data)) : "";
}

function cleanEmailDisplayText(body) {
  let text = String(body || "");

  // Remove non-message HTML blocks before stripping tags, otherwise CSS/JS can
  // leak into the readable email body.
  text = text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*style[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, " ")
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, " ")
    .replace(/<\s*head[^>]*>[\s\S]*?<\s*\/\s*head\s*>/gi, " ")
    .replace(/<\s*noscript[^>]*>[\s\S]*?<\s*\/\s*noscript\s*>/gi, " ");

  // Convert simple HTML structure into readable line breaks before removing tags.
  text = text
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n\n")
    .replace(/<\s*p[^>]*>/gi, "")
    .replace(/<\/\s*div\s*>/gi, "\n")
    .replace(/<\s*div[^>]*>/gi, "")
    .replace(/<\/\s*li\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, " ");

  text = decodeHtmlEntities(text)
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ");

  // Trim common quoted reply/forwarded chains.
  const cutPatterns = [
    /\nOn .+wrote:\n/i,
    /\nFrom:\s.+\nSent:\s.+\n/i,
    /\n_{2,}\n/,
    /\nBegin forwarded message:\n/i
  ];

  for (const pattern of cutPatterns) {
    const match = pattern.exec(text);
    if (match) {
      text = text.slice(0, match.index);
      break;
    }
  }

  // Drop common signature delimiter if present.
  text = text.replace(/\n--\s*\n[\s\S]*$/m, "");

  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*[.#@]?[a-z0-9_-]+\s*\{[^}]*\}\s*$/gim, "")
    .replace(/^\s*[a-z-]+\s*:\s*[^;]+;\s*$/gim, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function mapThreadMessage(message) {
  const payload = message.payload || {};
  const cleanedBody = cleanEmailDisplayText(extractBody(payload));
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds || [],
    snippet: message.snippet || "",
    internalDate: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
    from: getHeader(payload.headers, "From"),
    to: getHeader(payload.headers, "To"),
    subject: getHeader(payload.headers, "Subject"),
    date: getHeader(payload.headers, "Date"),
    messageId: getHeader(payload.headers, "Message-Id"),
    inReplyTo: getHeader(payload.headers, "In-Reply-To"),
    references: getHeader(payload.headers, "References"),
    body: cleanedBody
  };
}

function mapThread(thread) {
  const messages = (thread.messages || []).map(mapThreadMessage);
  const first = messages[0] || {};
  const last = messages[messages.length - 1] || {};
  const labelIds = Array.from(
    new Set((thread.messages || []).flatMap((message) => message.labelIds || []))
  );
  return {
    id: thread.id,
    historyId: thread.historyId || null,
    snippet: thread.snippet || "",
    subject: first.subject || "(no subject)",
    participants: Array.from(
      new Set(messages.flatMap((message) => [message.from, message.to]).filter(Boolean))
    ),
    messageCount: messages.length,
    lastMessageAt: last.internalDate || null,
    isStarred: labelIds.includes("STARRED"),
    isInTrash: labelIds.includes("TRASH"),
    messages
  };
}

async function listThreads({ userId, organizationId, maxResults = 20, pageToken, query }) {
  const { gmail } = await getAuthorizedGmailClient({ userId, organizationId });
  const resp = await gmail.users.threads.list({
    userId: "me",
    maxResults,
    pageToken: pageToken || undefined,
    q: query || undefined
  });

  const threads = [];
  for (const item of resp.data.threads || []) {
    const detail = await gmail.users.threads.get({
      userId: "me",
      id: item.id,
      format: "full"
    });
    threads.push(mapThread(detail.data));
  }

  return {
    threads,
    nextPageToken: resp.data.nextPageToken || null,
    resultSizeEstimate: resp.data.resultSizeEstimate || threads.length
  };
}

async function listDrafts({ userId, organizationId, maxResults = 20 }) {
  const { gmail } = await getAuthorizedGmailClient({ userId, organizationId });
  const resp = await gmail.users.drafts.list({
    userId: "me",
    maxResults
  });

  const drafts = [];
  for (const item of resp.data.drafts || []) {
    const detail = await gmail.users.drafts.get({
      userId: "me",
      id: item.id,
      format: "full"
    });
    const message = mapThreadMessage(detail.data.message || {});
    drafts.push({
      id: detail.data.id || item.id,
      messageId: message.id || detail.data.message?.id || null,
      threadId: message.threadId || detail.data.message?.threadId || null,
      subject: message.subject || "(no subject)",
      to: message.to || "",
      snippet: detail.data.message?.snippet || message.snippet || "",
      body: message.body || "",
      lastMessageAt: message.internalDate || null
    });
  }

  return {
    drafts,
    resultSizeEstimate: resp.data.resultSizeEstimate || drafts.length
  };
}

async function getThread({ userId, organizationId, threadId }) {
  const { gmail } = await getAuthorizedGmailClient({ userId, organizationId });
  const resp = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full"
  });
  return mapThread(resp.data);
}

async function updateThreadStarredState({ userId, organizationId, threadId, starred }) {
  const { gmail } = await getAuthorizedGmailClient({ userId, organizationId });
  await gmail.users.threads.modify({
    userId: "me",
    id: threadId,
    requestBody: {
      addLabelIds: starred ? ["STARRED"] : [],
      removeLabelIds: starred ? [] : ["STARRED"]
    }
  });

  return getThread({ userId, organizationId, threadId });
}

async function updateThreadTrashState({ userId, organizationId, threadId, trashed }) {
  const { gmail } = await getAuthorizedGmailClient({ userId, organizationId });

  if (trashed) {
    await gmail.users.threads.trash({
      userId: "me",
      id: threadId
    });
  } else {
    await gmail.users.threads.untrash({
      userId: "me",
      id: threadId
    });
  }

  return getThread({ userId, organizationId, threadId });
}

function buildRawEmail({ to, subject, body, threadHeaders }) {
  const headers = [
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    `To: ${to.join(", ")}`,
    `Subject: ${subject}`
  ];

  if (threadHeaders?.messageId) {
    headers.push(`In-Reply-To: ${threadHeaders.messageId}`);
  }
  if (threadHeaders?.references) {
    headers.push(`References: ${threadHeaders.references}`);
  } else if (threadHeaders?.messageId) {
    headers.push(`References: ${threadHeaders.messageId}`);
  }

  return encodeBase64Url(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

async function getThreadHeadersForReply({ userId, organizationId, threadId }) {
  if (!threadId) return null;
  const thread = await getThread({ userId, organizationId, threadId });
  const last = thread.messages[thread.messages.length - 1];
  if (!last) return null;
  return {
    messageId: last.messageId || null,
    references: last.references || last.messageId || null
  };
}

function sanitizeEmailBody(body) {
  return String(body || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildOnboardingEmailContext(profile) {
  if (!profile) return null;

  return [
    "User onboarding profile:",
    `Role: ${profile.role}`,
    `Primary goal: ${profile.primaryGoal}`,
    `Experience level: ${profile.experienceLevel}`,
    `Priority features: ${profile.priorities.join(", ")}`
  ].join("\n");
}

async function generateComposeDraft({ to, subject, context, tone, onboardingProfile }) {
  const prompt = [
    "You are an email writing assistant.",
    "Write a polished email body only.",
    "Do not include placeholders, commentary, or markdown.",
    `Tone: ${tone || "professional"}.`,
    buildOnboardingEmailContext(onboardingProfile),
    to?.length ? `Recipients: ${to.join(", ")}.` : null,
    subject ? `Subject: ${subject}.` : null,
    context ? `Context: ${context}.` : null
  ]
    .filter(Boolean)
    .join("\n");

  return generateAssistantReply({
    messages: [
      {
        role: "system",
        content: "You write concise, clear emails that are ready to send."
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });
}

async function generateReplySuggestion({
  thread,
  tone,
  additionalInstructions,
  onboardingProfile
}) {
  const formattedMessages = thread.messages
    .slice(-8)
    .map((message) => {
      const body = sanitizeEmailBody(message.body || message.snippet);
      return [
        `From: ${message.from || "Unknown"}`,
        `To: ${message.to || "Unknown"}`,
        `Date: ${message.date || message.internalDate || "Unknown"}`,
        `Body: ${body || "(empty)"}`
      ].join("\n");
    })
    .join("\n\n---\n\n");

  const prompt = [
    "Write a reply email body only.",
    "Do not include a subject line.",
    "Do not use markdown.",
    `Tone: ${tone || "professional"}.`,
    buildOnboardingEmailContext(onboardingProfile),
    additionalInstructions ? `Additional instructions: ${additionalInstructions}.` : null,
    `Conversation subject: ${thread.subject || "(no subject)"}.`,
    "Recent thread context:",
    formattedMessages
  ]
    .filter(Boolean)
    .join("\n");

  return generateAssistantReply({
    messages: [
      {
        role: "system",
        content: "You are a helpful email reply assistant. Keep replies natural and ready to send."
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });
}

async function getActiveOrgIdForUser(userId) {
  const membership = await prisma.organizationMember.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" }
  });

  if (!membership) throw new HttpError(403, "No organization membership");

  return membership.organizationId;
}

async function resolveOrgId(req) {
  const userId = req.auth?.userId;
  if (!userId) throw new HttpError(401, "Unauthorized");

  if (req.auth?.organizationId) {
    const membership = await prisma.organizationMember.findFirst({
      where: { userId, organizationId: req.auth.organizationId }
    });
    if (!membership) throw new HttpError(403, "No organization membership");
    return req.auth.organizationId;
  }

  return getActiveOrgIdForUser(userId);
}

async function getConnectUrl(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const url = await buildConnectUrl({ userId, organizationId });
    res.json({ url });
  } catch (err) {
    next(err);
  }
}

async function oauthCallback(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    return res
      .status(400)
      .send(`<html><body><h2>Gmail connection failed</h2><p>${String(error)}</p></body></html>`);
  }

  try {
    await connectAccountFromCode({
      code: String(code || ""),
      state: String(state || "")
    });
    return res.send(
      "<html><body><h2>Gmail connected</h2><p>You can return to the app now.</p></body></html>"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res
      .status(400)
      .send(`<html><body><h2>Gmail connection failed</h2><p>${message}</p></body></html>`);
  }
}

async function getStatus(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const account = await getConnectedAccount({ userId, organizationId });

    res.json({
      connected: Boolean(account),
      account: account
        ? {
            id: account.id,
            email: account.email,
            displayName: account.displayName,
            updatedAt: account.updatedAt
          }
        : null
    });
  } catch (err) {
    next(err);
  }
}

async function getThreads(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = listThreadsSchema.parse(req.query);

    const result = await listThreads({
      userId,
      organizationId,
      maxResults: input.maxResults,
      pageToken: input.pageToken,
      query: input.q
    });

    res.json(result);
  } catch (err) {
    next(toReconnectError(err));
  }
}

async function getThreadDetail(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);

    const thread = await getThread({
      userId,
      organizationId,
      threadId: req.params.threadId
    });

    res.json({ thread });
  } catch (err) {
    next(toReconnectError(err));
  }
}

async function getDrafts(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const result = await listDrafts({
      userId,
      organizationId,
      maxResults: 20
    });

    res.json(result);
  } catch (err) {
    next(toReconnectError(err));
  }
}

async function createComposeDraft(req, res, next) {
  try {
    const input = composeDraftSchema.parse(req.body || {});
    const body = await generateComposeDraft(input);
    res.status(201).json({
      draft: {
        subject: input.subject,
        to: input.to,
        body
      }
    });
  } catch (err) {
    next(err);
  }
}

async function createReplyDraft(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = replyDraftSchema.parse(req.body || {});
    const thread = await getThread({
      userId,
      organizationId,
      threadId: input.threadId
    });
    const body = await generateReplySuggestion({
      thread,
      tone: input.tone,
      additionalInstructions: input.additionalInstructions,
      onboardingProfile: input.onboardingProfile
    });

    res.status(201).json({
      draft: {
        threadId: thread.id,
        subject: thread.subject,
        body,
        to: []
      }
    });
  } catch (err) {
    next(toReconnectError(err));
  }
}

async function sendEmail(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = sendEmailSchema.parse(req.body || {});
    const { gmail } = await getAuthorizedGmailClient({ userId, organizationId });
    const threadHeaders = await getThreadHeadersForReply({
      userId,
      organizationId,
      threadId: input.threadId
    });

    const raw = buildRawEmail({
      to: input.to,
      subject: input.subject,
      body: input.body,
      threadHeaders
    });

    const resp = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        threadId: input.threadId || undefined
      }
    });

    res.status(201).json({
      sent: true,
      messageId: resp.data.id || null,
      threadId: resp.data.threadId || input.threadId || null
    });
  } catch (err) {
    next(toReconnectError(err));
  }
}

async function saveDraft(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = saveDraftSchema.parse(req.body || {});
    const { gmail } = await getAuthorizedGmailClient({ userId, organizationId });
    const threadHeaders = await getThreadHeadersForReply({
      userId,
      organizationId,
      threadId: input.threadId
    });

    const raw = buildRawEmail({
      to: input.to,
      subject: input.subject,
      body: input.body,
      threadHeaders
    });

    const resp = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          threadId: input.threadId || undefined
        }
      }
    });

    res.status(201).json({
      saved: true,
      draftId: resp.data.id || null,
      messageId: resp.data.message?.id || null,
      threadId: resp.data.message?.threadId || input.threadId || null
    });
  } catch (err) {
    next(toReconnectError(err));
  }
}

async function updateThreadState(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = threadActionSchema.parse(req.body || {});
    const threadId = req.params.threadId;

    let thread;
    if (typeof input.starred === "boolean") {
      thread = await updateThreadStarredState({
        userId,
        organizationId,
        threadId,
        starred: input.starred
      });
    }

    if (typeof input.trashed === "boolean") {
      thread = await updateThreadTrashState({
        userId,
        organizationId,
        threadId,
        trashed: input.trashed
      });
    }

    if (!thread) {
      throw new HttpError(400, "No thread action provided");
    }

    res.json({ thread });
  } catch (err) {
    next(toReconnectError(err));
  }
}

async function disconnectGmail(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);

    await prisma.gmailAccount.deleteMany({
      where: { userId, organizationId }
    });

    res.json({ disconnected: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
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
};
