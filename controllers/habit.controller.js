const { z } = require("zod");

const { prisma } = require("../config/prisma");
const { HttpError } = require("../utils/httpError");
const { generateAssistantReply } = require("../utils/aiClient");

const frequencyValues = ["DAILY", "WEEKLY"];

const createHabitSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional().default(""),
  category: z.string().trim().max(80).optional().default("General"),
  targetFrequency: z.enum(frequencyValues).optional().default("DAILY"),
  reminderTime: z.string().trim().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional().or(z.literal("")),
  startDate: z.coerce.date().optional().default(() => new Date())
});

const updateHabitSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  category: z.string().trim().max(80).optional(),
  targetFrequency: z.enum(frequencyValues).optional(),
  reminderTime: z.string().trim().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional().or(z.literal("")),
  startDate: z.coerce.date().optional(),
  isActive: z.boolean().optional()
});

const completeHabitSchema = z.object({
  date: z.coerce.date().optional().default(() => new Date()),
  notes: z.string().trim().max(1000).optional().default(""),
  completed: z.boolean().optional().default(true)
});

const coachSchema = z.object({
  habitId: z.string().trim().min(1)
});

function requireUser(req) {
  const userId = req.auth?.userId;
  if (!userId) throw new HttpError(401, "Unauthorized");
  return userId;
}

function startOfUtcDay(value = new Date()) {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function daysBetween(start, end) {
  return Math.floor((startOfUtcDay(end).getTime() - startOfUtcDay(start).getTime()) / 86400000);
}

function weekKey(date) {
  const day = startOfUtcDay(date);
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((day - yearStart) / 86400000) + 1) / 7);
  return `${day.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

function previousWeekKey(key) {
  const [year, week] = key.split("-").map(Number);
  const approx = new Date(Date.UTC(year, 0, 1 + (week - 2) * 7));
  return weekKey(approx);
}

function formatDateKey(date) {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}

function mapHabit(habit, today = new Date()) {
  const logs = habit.logs || [];
  const todayKey = formatDateKey(today);
  const completedToday = logs.some((log) => formatDateKey(log.date) === todayKey && log.completed);
  return {
    id: habit.id,
    userId: habit.userId,
    name: habit.name,
    description: habit.description,
    category: habit.category,
    targetFrequency: habit.targetFrequency,
    reminderTime: habit.reminderTime,
    startDate: habit.startDate,
    isActive: habit.isActive,
    createdAt: habit.createdAt,
    updatedAt: habit.updatedAt,
    completedToday,
    stats: habit.stats
      ? {
          currentStreak: habit.stats.currentStreak,
          longestStreak: habit.stats.longestStreak,
          completionRate: habit.stats.completionRate,
          totalCompleted: habit.stats.totalCompleted,
          updatedAt: habit.stats.updatedAt
        }
      : {
          currentStreak: 0,
          longestStreak: 0,
          completionRate: 0,
          totalCompleted: 0,
          updatedAt: null
        },
    logs: logs.map(mapLog)
  };
}

function mapLog(log) {
  return {
    id: log.id,
    habitId: log.habitId,
    date: log.date,
    completed: log.completed,
    notes: log.notes,
    createdAt: log.createdAt
  };
}

async function findHabitForUser({ habitId, userId, includeLogs = false }) {
  const habit = await prisma.habit.findFirst({
    where: { id: habitId, userId },
    include: {
      stats: true,
      logs: includeLogs
        ? { orderBy: { date: "desc" } }
        : { where: { date: startOfUtcDay() }, take: 1 }
    }
  });
  if (!habit) throw new HttpError(404, "Habit not found");
  return habit;
}

async function recalculateHabitStats(tx, habitId) {
  const habit = await tx.habit.findUnique({ where: { id: habitId } });
  if (!habit) throw new HttpError(404, "Habit not found");

  const completedLogs = await tx.habitLog.findMany({
    where: { habitId, completed: true },
    orderBy: { date: "asc" }
  });

  const totalCompleted = completedLogs.length;
  const today = startOfUtcDay();
  const startDate = startOfUtcDay(habit.startDate);
  const expected = habit.targetFrequency === "WEEKLY"
    ? Math.max(1, new Set(Array.from({ length: Math.max(0, daysBetween(startDate, today)) + 1 }, (_, index) => weekKey(addDays(startDate, index)))).size)
    : Math.max(1, daysBetween(startDate, today) + 1);
  const completionRate = Math.min(100, Math.round((totalCompleted / expected) * 100));

  let currentStreak = 0;
  let longestStreak = 0;

  if (habit.targetFrequency === "WEEKLY") {
    const weeks = new Set(completedLogs.map((log) => weekKey(log.date)));
    let cursor = weekKey(today);
    while (weeks.has(cursor)) {
      currentStreak += 1;
      cursor = previousWeekKey(cursor);
    }

    const orderedWeeks = Array.from(weeks).sort();
    let previous = null;
    let run = 0;
    for (const key of orderedWeeks) {
      if (previous && previousWeekKey(key) === previous) run += 1;
      else run = 1;
      longestStreak = Math.max(longestStreak, run);
      previous = key;
    }
  } else {
    const days = new Set(completedLogs.map((log) => formatDateKey(log.date)));
    let cursor = today;
    while (days.has(formatDateKey(cursor))) {
      currentStreak += 1;
      cursor = addDays(cursor, -1);
    }

    let previous = null;
    let run = 0;
    for (const log of completedLogs) {
      const day = startOfUtcDay(log.date);
      if (previous && daysBetween(previous, day) === 1) run += 1;
      else run = 1;
      longestStreak = Math.max(longestStreak, run);
      previous = day;
    }
  }

  return tx.habitStats.upsert({
    where: { habitId },
    create: { habitId, currentStreak, longestStreak, completionRate, totalCompleted },
    update: { currentStreak, longestStreak, completionRate, totalCompleted }
  });
}

function buildNudge(habit, today = new Date()) {
  const logs = habit.logs || [];
  const todayKey = formatDateKey(today);
  const yesterdayKey = formatDateKey(addDays(today, -1));
  const completedToday = logs.some((log) => formatDateKey(log.date) === todayKey && log.completed);
  const missedYesterday = !logs.some((log) => formatDateKey(log.date) === yesterdayKey && log.completed);

  if (completedToday) {
    return `Nice work. ${habit.name} is already completed today.`;
  }
  if (missedYesterday) {
    return `You missed ${habit.name} yesterday. Let's restart your streak today.`;
  }
  if (habit.reminderTime) {
    return `You usually planned ${habit.name} around ${habit.reminderTime}. Don't forget today's progress.`;
  }
  return `Small steps count. Complete ${habit.name} today to keep momentum.`;
}

function dateRangeStats(habits, days) {
  const today = startOfUtcDay();
  const start = addDays(today, -(days - 1));
  const activeHabits = habits.filter((habit) => habit.isActive);
  const expected = activeHabits.length * days;
  if (!expected) return 0;
  let completed = 0;
  for (const habit of activeHabits) {
    for (const log of habit.logs || []) {
      const day = startOfUtcDay(log.date);
      if (log.completed && day >= start && day <= today) completed += 1;
    }
  }
  return Math.round((completed / expected) * 100);
}

async function listHabits(req, res, next) {
  try {
    const userId = requireUser(req);
    const habits = await prisma.habit.findMany({
      where: { userId, isActive: req.query.includeInactive === "true" ? undefined : true },
      orderBy: { createdAt: "desc" },
      include: { stats: true, logs: { orderBy: { date: "desc" }, take: 45 } }
    });
    res.json({ habits: habits.map((habit) => ({ ...mapHabit(habit), nudge: buildNudge(habit) })) });
  } catch (err) {
    next(err);
  }
}

async function createHabit(req, res, next) {
  try {
    const userId = requireUser(req);
    const input = createHabitSchema.parse(req.body || {});
    const habit = await prisma.$transaction(async (tx) => {
      const created = await tx.habit.create({
        data: {
          userId,
          name: input.name,
          description: input.description || null,
          category: input.category || "General",
          targetFrequency: input.targetFrequency,
          reminderTime: input.reminderTime || null,
          startDate: startOfUtcDay(input.startDate)
        }
      });
      await tx.habitStats.create({ data: { habitId: created.id } });
      return tx.habit.findUnique({
        where: { id: created.id },
        include: { stats: true, logs: true }
      });
    });
    res.status(201).json({ habit: mapHabit(habit) });
  } catch (err) {
    next(err);
  }
}

async function getHabit(req, res, next) {
  try {
    const userId = requireUser(req);
    const habit = await findHabitForUser({ habitId: req.params.id, userId, includeLogs: true });
    res.json({ habit: { ...mapHabit(habit), nudge: buildNudge(habit) } });
  } catch (err) {
    next(err);
  }
}

async function updateHabit(req, res, next) {
  try {
    const userId = requireUser(req);
    await findHabitForUser({ habitId: req.params.id, userId });
    const input = updateHabitSchema.parse(req.body || {});
    const habit = await prisma.habit.update({
      where: { id: req.params.id },
      data: {
        ...("name" in input ? { name: input.name } : {}),
        ...("description" in input ? { description: input.description || null } : {}),
        ...("category" in input ? { category: input.category || "General" } : {}),
        ...("targetFrequency" in input ? { targetFrequency: input.targetFrequency } : {}),
        ...("reminderTime" in input ? { reminderTime: input.reminderTime || null } : {}),
        ...("startDate" in input ? { startDate: startOfUtcDay(input.startDate) } : {}),
        ...("isActive" in input ? { isActive: input.isActive } : {})
      },
      include: { stats: true, logs: { orderBy: { date: "desc" }, take: 45 } }
    });
    await prisma.$transaction((tx) => recalculateHabitStats(tx, habit.id));
    const updated = await findHabitForUser({ habitId: req.params.id, userId, includeLogs: true });
    res.json({ habit: mapHabit(updated) });
  } catch (err) {
    next(err);
  }
}

async function deleteHabit(req, res, next) {
  try {
    const userId = requireUser(req);
    await findHabitForUser({ habitId: req.params.id, userId });
    await prisma.habit.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ deleted: true, habitId: req.params.id });
  } catch (err) {
    next(err);
  }
}

async function completeHabit(req, res, next) {
  try {
    const userId = requireUser(req);
    const input = completeHabitSchema.parse(req.body || {});
    const habit = await findHabitForUser({ habitId: req.params.id, userId });
    if (!habit.isActive) throw new HttpError(400, "Cannot complete an inactive habit");
    const date = startOfUtcDay(input.date);

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.habitLog.findUnique({
        where: { habitId_date: { habitId: habit.id, date } }
      });
      if (existing?.completed) throw new HttpError(409, "Habit already completed for this date");

      const log = existing
        ? await tx.habitLog.update({
            where: { id: existing.id },
            data: { completed: input.completed, notes: input.notes || null }
          })
        : await tx.habitLog.create({
            data: {
              habitId: habit.id,
              date,
              completed: input.completed,
              notes: input.notes || null
            }
          });

      const stats = await recalculateHabitStats(tx, habit.id);
      return { log, stats };
    });

    const updated = await findHabitForUser({ habitId: habit.id, userId, includeLogs: true });
    res.json({ log: mapLog(result.log), stats: result.stats, habit: mapHabit(updated) });
  } catch (err) {
    next(err);
  }
}

async function dashboard(req, res, next) {
  try {
    const userId = requireUser(req);
    const habits = await prisma.habit.findMany({
      where: { userId, isActive: true },
      include: { stats: true, logs: { orderBy: { date: "desc" } } }
    });
    const todayKey = formatDateKey();
    const completedToday = habits.filter((habit) =>
      (habit.logs || []).some((log) => formatDateKey(log.date) === todayKey && log.completed)
    ).length;
    const longestStreak = habits.reduce((max, habit) => Math.max(max, habit.stats?.longestStreak || 0), 0);
    const activeStreaks = habits.filter((habit) => (habit.stats?.currentStreak || 0) > 0).length;
    const completionRate = habits.length
      ? Math.round(habits.reduce((sum, habit) => sum + (habit.stats?.completionRate || 0), 0) / habits.length)
      : 0;

    res.json({
      totalHabits: habits.length,
      completedToday,
      activeStreaks,
      longestStreak,
      completionRate,
      weeklyCompletionPercentage: dateRangeStats(habits, 7),
      monthlyCompletionPercentage: dateRangeStats(habits, 30)
    });
  } catch (err) {
    next(err);
  }
}

async function coach(req, res, next) {
  try {
    const userId = requireUser(req);
    const input = coachSchema.parse(req.body || {});
    const habit = await findHabitForUser({ habitId: input.habitId, userId, includeLogs: true });
    const stats = habit.stats || { currentStreak: 0, longestStreak: 0, completionRate: 0, totalCompleted: 0 };
    const completed = (habit.logs || []).filter((log) => log.completed).length;
    const missedDays = Math.max(0, daysBetween(habit.startDate, new Date()) + 1 - completed);
    const recent = (habit.logs || []).slice(0, 14).map((log) => `${formatDateKey(log.date)}:${log.completed ? "done" : "missed"}`).join(", ");

    const fallback = buildCoachFallback({ habit, stats, missedDays });
    let message = fallback;
    try {
      message = await generateAssistantReply({
        messages: [
          {
            role: "system",
            content: "You are a concise habit coach. Give motivation, positive reinforcement, one practical suggestion, and recovery plan if there are missed days. Keep it under 90 words."
          },
          {
            role: "user",
            content: [
              `Habit: ${habit.name}`,
              `Description: ${habit.description || ""}`,
              `Category: ${habit.category || "General"}`,
              `Frequency: ${habit.targetFrequency}`,
              `Current streak: ${stats.currentStreak}`,
              `Longest streak: ${stats.longestStreak}`,
              `Completion rate: ${stats.completionRate}%`,
              `Total completed: ${stats.totalCompleted}`,
              `Estimated missed days: ${missedDays}`,
              `Recent history: ${recent || "none"}`
            ].join("\n")
          }
        ]
      });
    } catch (_) {
      message = fallback;
    }

    res.json({ message, nudge: buildNudge(habit), stats });
  } catch (err) {
    next(err);
  }
}

function buildCoachFallback({ habit, stats, missedDays }) {
  if (stats.currentStreak >= 7) {
    return `Great work! You maintained ${habit.name} for ${stats.currentStreak} straight periods. To improve further, make the next step slightly more challenging while keeping it realistic.`;
  }
  if (missedDays > 0) {
    return `You have made progress with ${habit.name}, and one missed day does not erase it. Restart today with a smaller version of the habit, then rebuild your streak one day at a time.`;
  }
  return `Nice start with ${habit.name}. Keep it visible, pair it with an existing routine, and mark it complete as soon as you finish to build momentum.`;
}

async function nudges(req, res, next) {
  try {
    const userId = requireUser(req);
    const habits = await prisma.habit.findMany({
      where: { userId, isActive: true },
      include: { stats: true, logs: { orderBy: { date: "desc" }, take: 14 } }
    });
    res.json({ nudges: habits.map((habit) => ({ habitId: habit.id, habitName: habit.name, message: buildNudge(habit) })) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listHabits,
  createHabit,
  getHabit,
  updateHabit,
  deleteHabit,
  completeHabit,
  dashboard,
  coach,
  nudges
};
