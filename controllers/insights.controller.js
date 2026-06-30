const { prisma } = require("../config/prisma");
const { HttpError } = require("../utils/httpError");
const { generateAssistantReply } = require("../utils/aiClient");

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

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function endOfToday() {
  const start = startOfToday();
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatMetricSummary(metrics) {
  return [
    `Conversations: ${metrics.conversationsTotal} total, ${metrics.conversationsLast7Days} in the last 7 days`,
    `Messages: ${metrics.messagesLast7Days} in the last 7 days`,
    `Favorites: ${metrics.favoritesTotal}`,
    `Vault notes: ${metrics.vaultNotesTotal} total, ${metrics.vaultNotesLast7Days} added in the last 7 days`,
    `Reminders: ${metrics.activeReminders} active, ${metrics.overdueReminders} overdue, ${metrics.dueTodayReminders} due today, ${metrics.completedRemindersLast7Days} completed in the last 7 days`,
    `Gmail connected: ${metrics.gmailConnected ? "yes" : "no"}`
  ].join("\n");
}

function deriveMomentum(metrics) {
  if (metrics.conversationsLast7Days >= 6 || metrics.completedRemindersLast7Days >= 4) {
    return "High";
  }
  if (metrics.conversationsLast7Days >= 2 || metrics.vaultNotesLast7Days >= 1) {
    return "Building";
  }
  return "Quiet";
}

function deriveNextBestAction(metrics) {
  if (metrics.overdueReminders > 0) {
    return "Open Smart Reminders and reschedule or complete your overdue items first.";
  }
  if (metrics.conversationsLast7Days >= 4 && metrics.vaultNotesTotal < 2) {
    return "Save the most important recent chat takeaway into the Personal Knowledge Vault.";
  }
  if (metrics.conversationsLast7Days >= 3 && metrics.activeReminders === 0) {
    return "Turn your next planned task into a Smart Reminder so the assistant helps you follow through.";
  }
  if (metrics.gmailConnected && metrics.messagesLast7Days > 0) {
    return "Check Smart Inbox next and handle your highest-priority email thread while momentum is fresh.";
  }
  return "Start one focused chat, then save the key result to Vault or turn it into a reminder before you leave.";
}

function buildStrengths(metrics) {
  const strengths = [];

  if (metrics.completedRemindersLast7Days >= 2) {
    strengths.push("You are completing reminders consistently, which shows strong follow-through.");
  }
  if (metrics.vaultNotesLast7Days >= 2) {
    strengths.push("You are capturing knowledge in the vault, so useful context is becoming reusable.");
  }
  if (metrics.favoritesTotal >= 2) {
    strengths.push("You are saving strong assistant outputs, which makes repeat work faster.");
  }
  if (metrics.gmailConnected) {
    strengths.push("Your Gmail integration is ready, so communication workflows can stay inside the app.");
  }
  if (metrics.conversationsLast7Days >= 3) {
    strengths.push("You are engaging with the assistant regularly, which gives the workspace enough activity to personalize around.");
  }

  if (!strengths.length) {
    strengths.push("Your workspace is set up and ready; the biggest upside now comes from building a steadier weekly habit.");
  }

  return strengths.slice(0, 2);
}

function buildWatchouts(metrics) {
  const watchouts = [];

  if (metrics.overdueReminders > 0) {
    watchouts.push("Overdue reminders are building up, which can reduce trust in the planning system.");
  }
  if (metrics.conversationsTotal >= 4 && metrics.vaultNotesTotal === 0) {
    watchouts.push("Important ideas may be getting lost because chat activity is high but vault usage is still low.");
  }
  if (metrics.conversationsLast7Days >= 4 && metrics.activeReminders === 0) {
    watchouts.push("Plans are being discussed in chat, but not enough of them are turning into reminders.");
  }
  if (!metrics.gmailConnected) {
    watchouts.push("Email remains outside the workflow, so Smart Inbox triage is not helping you yet.");
  }

  if (!watchouts.length) {
    watchouts.push("No major workflow risk stands out right now; the main opportunity is staying consistent across features.");
  }

  return watchouts.slice(0, 2);
}

function buildModuleUsage(metrics) {
  return [
    {
      name: "Chat",
      value: metrics.conversationsLast7Days,
      status:
        metrics.conversationsLast7Days >= 5
          ? "Strong"
          : metrics.conversationsLast7Days >= 2
              ? "Active"
              : "Light"
    },
    {
      name: "Reminders",
      value: metrics.activeReminders + metrics.completedRemindersLast7Days,
      status:
        metrics.overdueReminders > 0
          ? "Needs attention"
          : metrics.completedRemindersLast7Days >= 2
              ? "Healthy"
              : "Light"
    },
    {
      name: "Vault",
      value: metrics.vaultNotesTotal,
      status:
        metrics.vaultNotesTotal >= 4
          ? "Growing"
          : metrics.vaultNotesTotal >= 1
              ? "Started"
              : "Empty"
    },
    {
      name: "Email",
      value: metrics.gmailConnected ? 1 : 0,
      status: metrics.gmailConnected ? "Connected" : "Not linked"
    }
  ];
}

function buildHeuristicTips(metrics) {
  const tips = [];

  if (metrics.overdueReminders > 0) {
    tips.push(
      `You have ${metrics.overdueReminders} overdue reminder${metrics.overdueReminders === 1 ? "" : "s"}. Reschedule or complete them first to reduce friction.`
    );
  }

  if (metrics.conversationsTotal >= 4 && metrics.vaultNotesTotal === 0) {
    tips.push(
      "You are using chat actively. Save repeated ideas or decisions to the Personal Knowledge Vault so they stay reusable."
    );
  }

  if (metrics.conversationsLast7Days >= 5 && metrics.activeReminders === 0) {
    tips.push(
      "You are planning through chat often but not using reminders yet. Convert next actions into Smart Reminders to improve follow-through."
    );
  }

  if (metrics.vaultNotesTotal >= 3 && metrics.favoritesTotal === 0) {
    tips.push(
      "Your vault is growing. Star your best chat answers too, so both notes and assistant outputs are easy to revisit."
    );
  }

  if (metrics.gmailConnected) {
    tips.push(
      "Use Smart Inbox with triage before drafting replies so high-priority messages get handled first."
    );
  } else {
    tips.push(
      "Connect Gmail when ready to unlock Smart Inbox triage and AI-assisted email drafting inside the same workspace."
    );
  }

  if (!tips.length) {
    tips.push(
      "Your workspace habits look balanced. Keep pairing reminders with vault notes so ideas turn into completed actions."
    );
  }

  return tips.slice(0, 3);
}

function deriveFocusArea(metrics) {
  if (metrics.overdueReminders > 0) return "Follow-through";
  if (metrics.conversationsLast7Days >= 4 && metrics.vaultNotesTotal < 2) {
    return "Knowledge capture";
  }
  if (metrics.gmailConnected) return "Communication";
  if (metrics.activeReminders === 0 && metrics.conversationsLast7Days >= 3) {
    return "Planning";
  }
  return "Consistency";
}

function calculateScore(metrics) {
  let score = 56;
  score += Math.min(metrics.completedRemindersLast7Days * 5, 15);
  score += Math.min(metrics.vaultNotesLast7Days * 4, 12);
  score += Math.min(metrics.favoritesTotal * 2, 8);
  score += metrics.gmailConnected ? 6 : 0;
  score += metrics.conversationsLast7Days > 0 ? 6 : -8;
  score -= Math.min(metrics.overdueReminders * 7, 24);
  return clamp(Math.round(score), 28, 96);
}

async function generateAiInsights(metrics) {
  const fallbackSummary =
    `Your strongest opportunity right now is ${deriveFocusArea(metrics).toLowerCase()}, with the biggest win coming from turning more activity into consistent follow-through.`;
  const fallbackTips = buildHeuristicTips(metrics);

  try {
    const answer = await generateAssistantReply({
      messages: [
        {
          role: "system",
          content:
            "You are an app usage insights assistant. Respond in valid JSON only with keys summary and tips. Summary must be one sentence. Tips must be an array of exactly 3 short practical strings. Do not include markdown."
        },
        {
          role: "user",
          content: `Create personalized productivity insights from these app metrics:\n${formatMetricSummary(metrics)}`
        }
      ]
    });

    const parsed = JSON.parse(answer);
    const summary = String(parsed.summary || "").trim() || fallbackSummary;
    const tips = Array.isArray(parsed.tips)
      ? parsed.tips.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3)
      : [];

    return {
      summary,
      tips: tips.length ? tips : fallbackTips
    };
  } catch (_) {
    return {
      summary: fallbackSummary,
      tips: fallbackTips
    };
  }
}

async function getAppInsights(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);

    const todayStart = startOfToday();
    const todayEnd = endOfToday();
    const last7Days = daysAgo(7);

    const [
      conversationsTotal,
      conversationsLast7Days,
      messagesLast7Days,
      favoritesTotal,
      vaultNotesTotal,
      vaultNotesLast7Days,
      activeReminders,
      overdueReminders,
      dueTodayReminders,
      completedRemindersLast7Days,
      gmailAccount
    ] = await Promise.all([
      prisma.conversation.count({ where: { organizationId, userId } }),
      prisma.conversation.count({
        where: { organizationId, userId, updatedAt: { gte: last7Days } }
      }),
      prisma.message.count({
        where: { userId, createdAt: { gte: last7Days } }
      }),
      prisma.favorite.count({ where: { organizationId, userId } }),
      prisma.knowledgeNote.count({ where: { organizationId, userId } }),
      prisma.knowledgeNote.count({
        where: { organizationId, userId, createdAt: { gte: last7Days } }
      }),
      prisma.reminder.count({
        where: { organizationId, userId, status: "ACTIVE" }
      }),
      prisma.reminder.count({
        where: {
          organizationId,
          userId,
          status: "ACTIVE",
          dueAt: { lt: todayStart }
        }
      }),
      prisma.reminder.count({
        where: {
          organizationId,
          userId,
          status: "ACTIVE",
          dueAt: { gte: todayStart, lt: todayEnd }
        }
      }),
      prisma.reminder.count({
        where: {
          organizationId,
          userId,
          status: "COMPLETED",
          completedAt: { gte: last7Days }
        }
      }),
      prisma.gmailAccount.findUnique({
        where: {
          userId_organizationId: {
            userId,
            organizationId
          }
        },
        select: {
          email: true,
          updatedAt: true
        }
      })
    ]);

    const metrics = {
      conversationsTotal,
      conversationsLast7Days,
      messagesLast7Days,
      favoritesTotal,
      vaultNotesTotal,
      vaultNotesLast7Days,
      activeReminders,
      overdueReminders,
      dueTodayReminders,
      completedRemindersLast7Days,
      gmailConnected: Boolean(gmailAccount)
    };

    const aiInsights = await generateAiInsights(metrics);

    res.json({
      insights: {
        score: calculateScore(metrics),
        focusArea: deriveFocusArea(metrics),
        momentum: deriveMomentum(metrics),
        summary: aiInsights.summary,
        tips: aiInsights.tips,
        nextBestAction: deriveNextBestAction(metrics),
        strengths: buildStrengths(metrics),
        watchouts: buildWatchouts(metrics),
        moduleUsage: buildModuleUsage(metrics),
        metrics: {
          ...metrics,
          gmailAccountEmail: gmailAccount?.email || null,
          gmailUpdatedAt: gmailAccount?.updatedAt || null
        }
      }
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAppInsights
};
