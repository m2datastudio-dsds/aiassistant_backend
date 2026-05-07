const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { z } = require("zod");

const { prisma } = require("../config/prisma");
const { env } = require("../config/env");
const { HttpError } = require("../utils/httpError");
const { slugify } = require("../utils/slug");

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  fullName: z.string().min(1).optional(),
  organizationName: z.string().min(2)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const switchOrgSchema = z.object({
  organizationId: z.string().min(1)
});

function signAccessToken(userId, organizationId) {
  return jwt.sign({ userId, organizationId }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}

function buildRefreshToken() {
  return crypto.randomBytes(48).toString("hex");
}

function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function refreshExpiryDate() {
  const d = new Date();
  d.setDate(d.getDate() + env.REFRESH_TOKEN_EXPIRES_DAYS);
  return d;
}

async function issueTokens(userId, organizationId) {
  const accessToken = signAccessToken(userId, organizationId);
  const refreshToken = buildRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshExpiryDate()
    }
  });
  return { accessToken, refreshToken };
}

async function listOrganizations(userId) {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId },
    include: { organization: true },
    orderBy: { createdAt: "asc" }
  });
  return memberships.map((m) => ({
    id: m.organization.id,
    name: m.organization.name,
    slug: m.organization.slug,
    role: m.role
  }));
}

async function register(req, res, next) {
  try {
    const input = registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new HttpError(409, "Email already registered");

    const passwordHash = await bcrypt.hash(input.password, 10);
    const baseSlug = slugify(input.organizationName) || "org";
    const slug = `${baseSlug}-${Math.random().toString(16).slice(2, 8)}`;

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          fullName: input.fullName || null
        }
      });

      const org = await tx.organization.create({
        data: {
          name: input.organizationName,
          slug
        }
      });

      await tx.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: user.id,
          role: "OWNER"
        }
      });

      return { user, org };
    });

    const organizations = await listOrganizations(result.user.id);
    const activeOrg = organizations[0] || null;
    const tokens = await issueTokens(result.user.id, activeOrg?.id || null);

    res.status(201).json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: { id: result.user.id, email: result.user.email, fullName: result.user.fullName },
      organization: { id: result.org.id, name: result.org.name, slug: result.org.slug },
      organizations
    });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const input = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user) throw new HttpError(401, "Invalid credentials");

    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) throw new HttpError(401, "Invalid credentials");

    const organizations = await listOrganizations(user.id);
    const activeOrg = organizations[0] || null;
    const tokens = await issueTokens(user.id, activeOrg?.id || null);

    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: { id: user.id, email: user.email, fullName: user.fullName },
      organization: activeOrg
        ? { id: activeOrg.id, name: activeOrg.name, slug: activeOrg.slug, role: activeOrg.role }
        : null,
      organizations
    });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, fullName: true, createdAt: true }
    });
    if (!user) throw new HttpError(401, "Unauthorized");

    const organizations = await listOrganizations(userId);
    const selected = req.auth?.organizationId
      ? organizations.find((o) => o.id === req.auth.organizationId)
      : organizations[0];

    res.json({
      user,
      organization: selected || null,
      organizations
    });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const input = refreshSchema.parse(req.body);
    const tokenHash = hashRefreshToken(input.refreshToken);
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash }
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new HttpError(401, "Invalid refresh token");
    }

    const organizations = await listOrganizations(stored.userId);
    const activeOrg = organizations[0] || null;

    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() }
    });

    const tokens = await issueTokens(stored.userId, activeOrg?.id || null);
    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      organization: activeOrg || null,
      organizations
    });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const input = refreshSchema.parse(req.body);
    const tokenHash = hashRefreshToken(input.refreshToken);
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function switchOrganization(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const input = switchOrgSchema.parse(req.body);

    const membership = await prisma.organizationMember.findFirst({
      where: { userId, organizationId: input.organizationId },
      include: { organization: true }
    });
    if (!membership) throw new HttpError(403, "Not a member of this organization");

    const accessToken = signAccessToken(userId, input.organizationId);
    res.json({
      accessToken,
      organization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
        role: membership.role
      }
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, me, refresh, logout, switchOrganization };

