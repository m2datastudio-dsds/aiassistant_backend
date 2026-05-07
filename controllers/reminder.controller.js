const { z } = require("zod");

const { prisma } = require("../config/prisma");
const { HttpError } = require("../utils/httpError");
const { generateAssistantReply } = require("../utils/aiClient");

const recurrenceValues = ["NONE", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

const listRemindersSchema = z.object({
  status: z.enum(["ACTIVE", "COMPLETED", "CANCELLED", "ALL"]).optional().default("ACTIVE"),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(0).optional().default(0),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(20)
});

const createReminderSchema = z.object({
  title: z.string().trim().min(1).max(160),
  notes: z.string().trim().max(1000).optional().default(""),
  dueAt: z.coerce.date(),
  timezone: z.string().trim().max(80).optional().default(""),
  recurrence: z.enum(recurrenceValues).optional().default("NONE"),
  notificationId: z.string().trim().max(160).optional().default("")
});

const aiReminderSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  timezone: z.string().trim().max(80).optional().default("Asia/Kolkata"),
  onboardingProfile: z
    .object({
      role: z.string().trim().min(1).max(80),
      primaryGoal: z.string().trim().min(1).max(240),
      experienceLevel: z.enum(["beginner", "intermediate", "advanced"]),
      priorities: z.array(z.string().trim().min(1).max(40)).min(1).max(5)
    })
    .optional()
});

const updateReminderSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  notes: z.string().trim().max(1000).optional(),
  dueAt: z.coerce.date().optional(),
  timezone: z.string().trim().max(80).optional(),
  recurrence: z.enum(recurrenceValues).optional(),
  notificationId: z.string().trim().max(160).optional(),
  status: z.enum(["ACTIVE", "COMPLETED", "CANCELLED"]).optional()
});

const dueRemindersSchema = z.object({
  before: z.coerce.date().optional().default(() => new Date())
});

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

function mapReminder(reminder) {
  return {
    id: reminder.id,
    title: reminder.title,
    notes: reminder.notes,
    dueAt: reminder.dueAt,
    timezone: reminder.timezone,
    status: reminder.status,
    recurrence: reminder.recurrence,
    notificationId: reminder.notificationId,
    createdAt: reminder.createdAt,
    updatedAt: reminder.updatedAt,
    completedAt: reminder.completedAt
  };
}

function ensureFutureDueAt(dueAt) {
  if (dueAt <= new Date()) {
    throw new HttpError(400, "Reminder time must be in the future");
  }
}

function normalizeTimezone(timezone) {
  if (timezone === "Asia/Calcutta") return "Asia/Kolkata";
  return timezone || null;
}

async function ensureReminder({ id, organizationId, userId }) {
  const reminder = await prisma.reminder.findFirst({
    where: { id, organizationId, userId }
  });

  if (!reminder) throw new HttpError(404, "Reminder not found");
  return reminder;
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function buildOnboardingReminderContext(profile) {
  if (!profile) return null;

  return [
    "User onboarding profile:",
    `Role: ${profile.role}`,
    `Primary goal: ${profile.primaryGoal}`,
    `Experience level: ${profile.experienceLevel}`,
    `Priority features: ${profile.priorities.join(", ")}`
  ].join("\n");
}

function getZonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeTimezone(timezone) || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function getTimezoneOffsetMs(date, timezone) {
  const zoned = getZonedParts(date, timezone);
  const asUtc = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second
  );
  return asUtc - date.getTime();
}

function zonedDateTimeToUtc({ year, month, day, hour, minute, second = 0 }, timezone) {
  const baseUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = getTimezoneOffsetMs(new Date(baseUtc), timezone);
  return new Date(baseUtc - offset);
}

function extractTimeFromText(text) {
  const match = String(text || "")
    .toLowerCase()
    .match(/\b(\d{1,2})(?::|\.?)(\d{2})?\s*(am|pm)?\b/);

  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] || "0");
  const meridiem = match[3];

  if (Number.isNaN(hour) || Number.isNaN(minute) || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am") {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }
  } else if (hour > 23) {
    return null;
  }

  return { hour, minute };
}

function inferRecurrenceFromText(text) {
  const value = String(text || "").toLowerCase();
  if (/\b(daily|every day|everyday)\b/.test(value)) return "DAILY";
  if (/\bweekly|every week\b/.test(value)) return "WEEKLY";
  if (/\bmonthly|every month\b/.test(value)) return "MONTHLY";
  if (/\byearly|annually|every year\b/.test(value)) return "YEARLY";
  return "NONE";
}

function inferTitleFromReminderText(text, recurrence) {
  const cleaned = String(text || "")
    .replace(/\b(remind me|set a reminder|set reminder|remember to)\b/gi, "")
    .replace(/\b(daily|every day|everyday|weekly|every week|monthly|every month|yearly|every year|annually)\b/gi, "")
    .replace(/\b(today|tomorrow)\b/gi, "")
    .replace(/\bat\b/gi, "")
    .replace(/\b\d{1,2}(?::|\.?)\d{0,2}\s*(am|pm)?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned) return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return recurrence === "DAILY" ? "Daily reminder" : "Reminder";
}

function alignParsedReminderToTimezone({ parsed, text, timezone }) {
  const normalizedTimezone = normalizeTimezone(timezone) || "UTC";
  const time = extractTimeFromText(text);
  const recurrence = inferRecurrenceFromText(text);

  if (!time && recurrence === "NONE") {
    return parsed;
  }

  let nextParsed = { ...parsed };

  if (time) {
    const localDate = getZonedParts(parsed.dueAt, normalizedTimezone);
    const dueAt = zonedDateTimeToUtc(
      {
        year: localDate.year,
        month: localDate.month,
        day: localDate.day,
        hour: time.hour,
        minute: time.minute,
        second: 0
      },
      normalizedTimezone
    );
    nextParsed = { ...nextParsed, dueAt };
  }

  if (recurrence !== "NONE") {
    nextParsed = { ...nextParsed, recurrence };
  }

  if (nextParsed.recurrence === "DAILY" && nextParsed.dueAt <= new Date()) {
    nextParsed = {
      ...nextParsed,
      dueAt: new Date(nextParsed.dueAt.getTime() + 24 * 60 * 60 * 1000)
    };
  }

  return nextParsed;
}

function tryDirectReminderParse({ text, timezone }) {
  const normalizedTimezone = normalizeTimezone(timezone) || "UTC";
  const time = extractTimeFromText(text);
  const recurrence = inferRecurrenceFromText(text);
  if (!time) return null;

  const now = new Date();
  const localNow = getZonedParts(now, normalizedTimezone);
  let dueAt = zonedDateTimeToUtc(
    {
      year: localNow.year,
      month: localNow.month,
      day: localNow.day,
      hour: time.hour,
      minute: time.minute,
      second: 0
    },
    normalizedTimezone
  );

  const lowerText = String(text || "").toLowerCase();
  const hasTomorrow = /\btomorrow\b/.test(lowerText);
  const hasToday = /\btoday\b/.test(lowerText);

  if (hasTomorrow) {
    dueAt = new Date(dueAt.getTime() + 24 * 60 * 60 * 1000);
  } else if (!hasToday && dueAt <= now) {
    dueAt = new Date(dueAt.getTime() + 24 * 60 * 60 * 1000);
  }

  return createReminderSchema.parse({
    title: inferTitleFromReminderText(text, recurrence),
    notes: "",
    dueAt,
    timezone: normalizedTimezone,
    recurrence
  });
}

async function parseReminderWithAi({ text, timezone, onboardingProfile }) {
  const now = new Date();
  const prompt = [
    "Parse the user's reminder request into strict JSON only.",
    "Return keys: title, notes, dueAt, recurrence.",
    "dueAt must be an ISO-8601 datetime string with timezone if possible.",
    `Current server time: ${now.toISOString()}.`,
    `User timezone: ${timezone || "unknown"}.`,
    buildOnboardingReminderContext(onboardingProfile),
    "recurrence must be one of NONE, DAILY, WEEKLY, MONTHLY, YEARLY.",
    `Request: ${text}`
  ].join("\n");

  const reply = await generateAssistantReply({
    messages: [
      {
        role: "system",
        content: "You convert natural language reminders into valid JSON. Do not include markdown."
      },
      { role: "user", content: prompt }
    ]
  });

  try {
    const parsed = extractJsonObject(reply);
    const reminder = createReminderSchema.parse({
      title: parsed.title,
      notes: parsed.notes || "",
      dueAt: parsed.dueAt,
      timezone,
      recurrence: recurrenceValues.includes(parsed.recurrence) ? parsed.recurrence : "NONE"
    });
    return alignParsedReminderToTimezone({ parsed: reminder, text, timezone });
  } catch (err) {
    const fallback = tryDirectReminderParse({ text, timezone });
    if (fallback) return fallback;
    throw new HttpError(
      422,
      "Could not understand reminder time",
      "Try a clearer reminder, for example: remind me tomorrow at 9am to call Priya"
    );
  }
}

async function listReminders(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = listRemindersSchema.parse(req.query || {});
    const skip = input.page * input.pageSize;

    const where = {
        organizationId,
        userId,
        ...(input.status === "ALL" ? {} : { status: input.status }),
        ...(input.q
          ? {
              OR: [
                { title: { contains: input.q, mode: "insensitive" } },
                { notes: { contains: input.q, mode: "insensitive" } }
              ]
            }
          : {})
      };

    const [reminders, total] = await Promise.all([
      prisma.reminder.findMany({
        where,
        orderBy: [{ status: "asc" }, { dueAt: "asc" }],
        take: input.pageSize,
        skip
      }),
      prisma.reminder.count({ where })
    ]);

    res.json({
      reminders: reminders.map(mapReminder),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total,
        hasMore: skip + reminders.length < total
      }
    });
  } catch (err) {
    next(err);
  }
}

async function listDueReminders(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = dueRemindersSchema.parse(req.query || {});

    const reminders = await prisma.reminder.findMany({
      where: {
        organizationId,
        userId,
        status: "ACTIVE",
        dueAt: { lte: input.before }
      },
      orderBy: { dueAt: "asc" },
      take: 50
    });

    res.json({
      reminders: reminders.map(mapReminder),
      notificationReady: true
    });
  } catch (err) {
    next(err);
  }
}

async function createReminder(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = createReminderSchema.parse(req.body || {});
    ensureFutureDueAt(input.dueAt);

    const reminder = await prisma.reminder.create({
      data: {
        organizationId,
        userId,
        title: input.title,
        notes: input.notes || null,
        dueAt: input.dueAt,
        timezone: normalizeTimezone(input.timezone),
        recurrence: input.recurrence,
        notificationId: input.notificationId || null
      }
    });

    res.status(201).json({ reminder: mapReminder(reminder) });
  } catch (err) {
    next(err);
  }
}

async function createReminderFromAi(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = aiReminderSchema.parse(req.body || {});
    const parsed = await parseReminderWithAi(input);
    ensureFutureDueAt(parsed.dueAt);

    const reminder = await prisma.reminder.create({
      data: {
        organizationId,
        userId,
        title: parsed.title,
        notes: parsed.notes || null,
        dueAt: parsed.dueAt,
        timezone: normalizeTimezone(parsed.timezone || input.timezone),
        recurrence: parsed.recurrence,
        notificationId: parsed.notificationId || null
      }
    });

    res.status(201).json({ reminder: mapReminder(reminder), parsed });
  } catch (err) {
    next(err);
  }
}

async function updateReminder(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = updateReminderSchema.parse(req.body || {});
    if (input.dueAt) ensureFutureDueAt(input.dueAt);

    await ensureReminder({ id: req.params.id, organizationId, userId });

    const reminder = await prisma.reminder.update({
      where: { id: req.params.id },
      data: {
        ...("title" in input ? { title: input.title } : {}),
        ...("notes" in input ? { notes: input.notes || null } : {}),
        ...("dueAt" in input ? { dueAt: input.dueAt } : {}),
        ...("timezone" in input ? { timezone: normalizeTimezone(input.timezone) } : {}),
        ...("recurrence" in input ? { recurrence: input.recurrence } : {}),
        ...("notificationId" in input ? { notificationId: input.notificationId || null } : {}),
        ...("status" in input
          ? {
              status: input.status,
              completedAt: input.status === "COMPLETED" ? new Date() : null
            }
          : {})
      }
    });

    res.json({ reminder: mapReminder(reminder) });
  } catch (err) {
    next(err);
  }
}

async function completeReminder(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const current = await ensureReminder({ id: req.params.id, organizationId, userId });

    if (current.recurrence !== "NONE") {
      const nextDueAt = new Date(current.dueAt);
      if (current.recurrence === "DAILY") nextDueAt.setDate(nextDueAt.getDate() + 1);
      if (current.recurrence === "WEEKLY") nextDueAt.setDate(nextDueAt.getDate() + 7);
      if (current.recurrence === "MONTHLY") nextDueAt.setMonth(nextDueAt.getMonth() + 1);
      if (current.recurrence === "YEARLY") nextDueAt.setFullYear(nextDueAt.getFullYear() + 1);

      const reminder = await prisma.reminder.update({
        where: { id: current.id },
        data: { dueAt: nextDueAt, status: "ACTIVE", completedAt: null }
      });
      return res.json({ reminder: mapReminder(reminder), rescheduled: true });
    }

    const reminder = await prisma.reminder.update({
      where: { id: current.id },
      data: { status: "COMPLETED", completedAt: new Date() }
    });

    return res.json({ reminder: mapReminder(reminder), rescheduled: false });
  } catch (err) {
    next(err);
  }
}

async function deleteReminder(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    await ensureReminder({ id: req.params.id, organizationId, userId });

    await prisma.reminder.delete({ where: { id: req.params.id } });
    res.json({ deleted: true, reminderId: req.params.id });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listReminders,
  listDueReminders,
  createReminder,
  createReminderFromAi,
  updateReminder,
  completeReminder,
  deleteReminder
};
