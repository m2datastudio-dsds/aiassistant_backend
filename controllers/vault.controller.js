const { z } = require("zod");

const { prisma } = require("../config/prisma");
const { HttpError } = require("../utils/httpError");
const { generateAssistantReply } = require("../utils/aiClient");

const noteSchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(8000),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional().default([])
});

const listNotesSchema = z.object({
  q: z.string().trim().max(120).optional()
});

const askVaultSchema = z.object({
  question: z.string().trim().min(1).max(1000)
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

function mapNote(note) {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    tags: note.tags || [],
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  };
}

function scoreNote(note, question) {
  const text = `${note.title} ${note.content} ${(note.tags || []).join(" ")}`.toLowerCase();
  const terms = String(question || "")
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2);

  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 3;
  }
  return score;
}

function matchesVaultQuery(note, query) {
  const value = String(query || "").trim().toLowerCase();
  if (!value) return true;

  const haystack = `${note.title} ${note.content}`.toLowerCase();
  if (haystack.includes(value)) return true;

  return (note.tags || []).some((tag) => String(tag || "").toLowerCase().includes(value));
}

async function listNotes(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = listNotesSchema.parse(req.query || {});

    const allNotes = await prisma.knowledgeNote.findMany({
      where: {
        organizationId,
        userId
      },
      orderBy: { updatedAt: "desc" }
    });

    const notes = input.q
      ? allNotes.filter((note) => matchesVaultQuery(note, input.q))
      : allNotes;

    res.json({ notes: notes.map(mapNote) });
  } catch (err) {
    next(err);
  }
}

async function createNote(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = noteSchema.parse(req.body || {});

    const note = await prisma.knowledgeNote.create({
      data: {
        organizationId,
        userId,
        title: input.title,
        content: input.content,
        tags: input.tags
      }
    });

    res.status(201).json({ note: mapNote(note) });
  } catch (err) {
    next(err);
  }
}

async function deleteNote(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);

    const note = await prisma.knowledgeNote.findFirst({
      where: {
        id: req.params.id,
        organizationId,
        userId
      }
    });

    if (!note) throw new HttpError(404, "Note not found");

    await prisma.knowledgeNote.delete({
      where: { id: note.id }
    });

    res.json({ deleted: true, noteId: note.id });
  } catch (err) {
    next(err);
  }
}

async function askVault(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = askVaultSchema.parse(req.body || {});

    const notes = await prisma.knowledgeNote.findMany({
      where: { organizationId, userId },
      orderBy: { updatedAt: "desc" },
      take: 50
    });

    if (!notes.length) {
      return res.json({
        answer: "Your knowledge vault is empty. Save a few personal notes first, then ask me to retrieve them.",
        matches: []
      });
    }

    const ranked = notes
      .map((note) => ({ note, score: scoreNote(note, input.question) }))
      .sort((a, b) => b.score - a.score || new Date(b.note.updatedAt) - new Date(a.note.updatedAt))
      .filter(({ score }) => score > 0)
      .slice(0, 6);

    if (!ranked.length) {
      return res.json({
        answer:
          "I could not find any relevant notes in your knowledge vault for that question. Try using a keyword from your saved title, content, or tags.",
        matches: []
      });
    }

    const matches = ranked.map(({ note }) => mapNote(note));
    const context = ranked
      .map(({ note }, index) =>
        [
          `Note ${index + 1}: ${note.title}`,
          note.tags?.length ? `Tags: ${note.tags.join(", ")}` : null,
          `Content: ${note.content}`
        ]
          .filter(Boolean)
          .join("\n")
      )
      .join("\n\n---\n\n");

    const answer = await generateAssistantReply({
      messages: [
        {
          role: "system",
          content:
            "You answer using the user's personal knowledge vault notes only. Be concise, specific, and say clearly if the vault notes do not contain enough information. Do not invent facts."
        },
        {
          role: "user",
          content: `Question: ${input.question}\n\nKnowledge vault notes:\n${context}`
        }
      ]
    });

    res.json({ answer, matches });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listNotes,
  createNote,
  deleteNote,
  askVault
};
