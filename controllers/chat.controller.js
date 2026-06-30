const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { HttpError } = require("../utils/httpError");
const { generateAssistantReply } = require("../utils/aiClient");

// ================= VALIDATION =================

const createConversationSchema = z.object({
  title: z.string().min(1).max(120).optional()
});

const locationContextSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMeters: z.number().min(0).max(100000).optional(),
    capturedAt: z.string().trim().max(80).optional()
  })
  .optional();

const sendMessageSchema = z.object({
  conversationId: z.string().min(1).optional(),
  message: z.string().min(1),
  title: z.string().min(1).max(120).optional(),
  preferredLanguage: z.string().trim().min(2).max(20).optional(),
  onboardingProfile: z
    .object({
      role: z.string().trim().min(1).max(80),
      primaryGoal: z.string().trim().min(1).max(240),
      experienceLevel: z.enum(["beginner", "intermediate", "advanced"]),
      priorities: z.array(z.string().trim().min(1).max(40)).min(1).max(5)
    })
    .optional(),
  locationContext: locationContextSchema,
  incognito: z.boolean().optional().default(false),
  history: z
    .array(
      z.object({
        role: z.enum(["USER", "ASSISTANT"]),
        content: z.string().min(1)
      })
    )
    .max(30)
    .optional()
});

const listConversationsSchema = z.object({
  q: z.string().trim().max(120).optional()
});

const regenerateResponseSchema = z.object({
  conversationId: z.string().min(1),
  assistantMessageId: z.string().min(1).optional(),
  preferredLanguage: z.string().trim().min(2).max(20).optional(),
  onboardingProfile: z
    .object({
      role: z.string().trim().min(1).max(80),
      primaryGoal: z.string().trim().min(1).max(240),
      experienceLevel: z.enum(["beginner", "intermediate", "advanced"]),
      priorities: z.array(z.string().trim().min(1).max(40)).min(1).max(5)
    })
    .optional(),
  locationContext: locationContextSchema
});

const editAndResendSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  message: z.string().min(1),
  preferredLanguage: z.string().trim().min(2).max(20).optional(),
  onboardingProfile: z
    .object({
      role: z.string().trim().min(1).max(80),
      primaryGoal: z.string().trim().min(1).max(240),
      experienceLevel: z.enum(["beginner", "intermediate", "advanced"]),
      priorities: z.array(z.string().trim().min(1).max(40)).min(1).max(5)
    })
    .optional(),
  locationContext: locationContextSchema
});

const quickActionSchema = z.object({
  conversationId: z.string().min(1).optional(),
  action: z.enum(["email", "reminder", "explain", "translate", "voice"]),
  text: z.string().trim().max(4000).optional().default(""),
  preferredLanguage: z.string().trim().min(2).max(20).optional(),
  onboardingProfile: z
    .object({
      role: z.string().trim().min(1).max(80),
      primaryGoal: z.string().trim().min(1).max(240),
      experienceLevel: z.enum(["beginner", "intermediate", "advanced"]),
      priorities: z.array(z.string().trim().min(1).max(40)).min(1).max(5)
    })
    .optional(),
  locationContext: locationContextSchema,
  incognito: z.boolean().optional().default(false),
  history: z
    .array(
      z.object({
        role: z.enum(["USER", "ASSISTANT"]),
        content: z.string().min(1)
      })
    )
    .max(30)
    .optional()
});

const onboardingSchema = z.object({
  role: z.string().trim().min(1).max(80),
  primaryGoal: z.string().trim().min(1).max(240),
  experienceLevel: z.enum(["beginner", "intermediate", "advanced"]),
  priorities: z.array(z.string().trim().min(1).max(40)).min(1).max(5),
  preferredLanguage: z.string().trim().min(2).max(20).optional()
});

const updateConversationTitleSchema = z.object({
  title: z.string().trim().min(1).max(120)
});

const createFavoriteSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1)
});

// ================= HELPER =================

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

function toAiMessages(messages) {
  return messages.map((m) => ({
    role:
      m.role === "USER"
        ? "user"
        : m.role === "ASSISTANT"
        ? "assistant"
        : "system",
    content: m.content
  }));
}

function buildConversationTitle({ title, message }) {
  const cleanedTitle = String(title || "").trim();
  if (cleanedTitle && cleanedTitle.toLowerCase() !== "new chat") {
    return cleanedTitle.slice(0, 120);
  }

  const cleanedMessage = String(message || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanedMessage) return null;
  return cleanedMessage.length > 60 ? `${cleanedMessage.slice(0, 57)}...` : cleanedMessage;
}

function buildQuickActionPrompt({ action, text }) {
  const value = String(text || "").trim();

  switch (action) {
    case "email":
      return value
        ? `Write a professional email about: ${value}`
        : "Write a professional email";
    case "reminder":
      return value
        ? `Set a reminder for: ${value}`
        : "Set a reminder for tomorrow";
    case "explain":
      return value
        ? `Explain this topic simply: ${value}`
        : "Explain this topic simply";
    case "translate":
      return value
        ? `Translate this text: ${value}`
        : "Translate this text";
    case "voice":
      return value
        ? `Start voice assistant and help with: ${value}`
        : "Start voice assistant";
    default:
      return value;
  }
}

function buildFavoriteTitle({ message, conversationTitle }) {
  const snippet = String(message.content || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!snippet) {
    return String(conversationTitle || "").trim() ||
      (message.role === "USER" ? "Saved prompt" : "Saved response");
  }

  return snippet.length > 60 ? `${snippet.slice(0, 57)}...` : snippet;
}

function mapFavorite(favorite) {
  return {
    id: favorite.id,
    conversationId: favorite.conversationId,
    messageId: favorite.messageId,
    kind: favorite.kind,
    title: favorite.title,
    content: favorite.content,
    createdAt: favorite.createdAt,
    updatedAt: favorite.updatedAt
  };
}

async function ensureConversation({ conversationId, organizationId, userId }) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId, userId }
  });

  if (!conversation) {
    throw new HttpError(404, "Conversation not found");
  }

  return conversation;
}

async function ensureConversationMessage({ messageId, conversationId }) {
  const message = await prisma.message.findFirst({
    where: { id: messageId, conversationId }
  });

  if (!message) {
    throw new HttpError(404, "Message not found");
  }

  return message;
}

function detectLanguageFromText(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  if (/[\u0B80-\u0BFF]/.test(value)) return "ta";
  if (/[\u0900-\u097F]/.test(value)) return "hi";
  if (/[\u0600-\u06FF]/.test(value)) return "ar";
  if (/[¿¡]|[áéíóúñ]/i.test(value)) return "es";
  return "en";
}

function normalizeLanguageName(languageCode) {
  const code = String(languageCode || "").trim().toLowerCase();
  if (!code) return null;
  if (code === "auto" || code === "detect" || code === "system") return null;
  if (code.startsWith("ta")) return "Tamil";
  if (code.startsWith("hi")) return "Hindi";
  if (code.startsWith("es")) return "Spanish";
  if (code.startsWith("ar")) return "Arabic";
  if (code.startsWith("en")) return "English";
  return code;
}

function inferPreferredLanguage(messages, preferredLanguage) {
  const explicit = normalizeLanguageName(preferredLanguage);
  if (explicit) return explicit;

  for (const message of [...messages].reverse()) {
    if (message.role !== "USER") continue;
    const detected = normalizeLanguageName(detectLanguageFromText(message.content));
    if (detected) return detected;
  }

  return "English";
}

function buildOnboardingContext(profile) {
  if (!profile) return null;

  return [
    "User onboarding profile:",
    `Role: ${profile.role}`,
    `Primary goal: ${profile.primaryGoal}`,
    `Experience level: ${profile.experienceLevel}`,
    `Priority features: ${profile.priorities.join(", ")}`
  ].join("\n");
}

function buildLocationContext(locationContext) {
  if (!locationContext) return null;

  const accuracy = Number.isFinite(locationContext.accuracyMeters)
    ? `Accuracy: about ${Math.round(locationContext.accuracyMeters)} meters`
    : null;

  return [
    "User location context:",
    `Latitude: ${locationContext.latitude}`,
    `Longitude: ${locationContext.longitude}`,
    accuracy,
    locationContext.capturedAt ? `Captured at: ${locationContext.capturedAt}` : null,
    "These coordinates are already the user's current location.",
    "When the user asks for something near me, around me, nearby, local, or based on current location, do not ask for their city, zip code, or coordinates again.",
    "Use the coordinates as the available location context. If exact live business listings, ratings, opening hours, or routes are needed and no maps/search tool is available, clearly say that live map search is not connected yet and give practical next steps or search terms.",
    "Do not mention exact coordinates unless useful."
  ]
    .filter(Boolean)
    .join("\n");
}

function getLatestUserText(messages) {
  for (const message of [...messages].reverse()) {
    if (message.role === "USER") return String(message.content || "");
  }
  return "";
}

function inferNearbyPlaceRequest(text) {
  const value = String(text || "").toLowerCase();
  const isNearby = /\b(near me|nearby|around me|current location|my location|closest|nearest)\b/.test(value);
  if (!isNearby) return null;

  const mappings = [
    {
      pattern: /\b(hospital|hospitals|clinic|clinics|medical|emergency)\b/,
      type: "hospital",
      keyword: "hospital",
      osmSelectors: [
        { key: "amenity", value: "hospital" },
        { key: "amenity", value: "clinic" }
      ]
    },
    {
      pattern: /\b(pharmacy|pharmacies|chemist|medical store)\b/,
      type: "pharmacy",
      keyword: "pharmacy",
      osmSelectors: [
        { key: "amenity", value: "pharmacy" },
        { key: "shop", value: "chemist" }
      ]
    },
    {
      pattern: /\b(restaurant|restaurants|food|dinner|lunch)\b/,
      type: "restaurant",
      keyword: "restaurant",
      osmSelectors: [
        { key: "amenity", value: "restaurant" },
        { key: "amenity", value: "fast_food" },
        { key: "amenity", value: "food_court" }
      ]
    },
    {
      pattern: /\b(cafe|cafes|coffee|coffee shop)\b/,
      type: "cafe",
      keyword: "cafe",
      osmSelectors: [
        { key: "amenity", value: "cafe" },
        { key: "shop", value: "coffee" }
      ]
    },
    {
      pattern: /\b(atm|cash machine)\b/,
      type: "atm",
      keyword: "atm",
      osmSelectors: [{ key: "amenity", value: "atm" }]
    },
    {
      pattern: /\b(bank|banks)\b/,
      type: "bank",
      keyword: "bank",
      osmSelectors: [
        { key: "amenity", value: "bank" },
        { key: "office", value: "financial" }
      ]
    },
    {
      pattern: /\b(gas|petrol|fuel)\b/,
      type: "gas_station",
      keyword: "gas station",
      osmSelectors: [{ key: "amenity", value: "fuel" }]
    },
    {
      pattern: /\b(police)\b/,
      type: "police",
      keyword: "police",
      osmSelectors: [{ key: "amenity", value: "police" }]
    },
    {
      pattern: /\b(hotel|hotels|stay)\b/,
      type: "lodging",
      keyword: "hotel",
      osmSelectors: [
        { key: "tourism", value: "hotel" },
        { key: "tourism", value: "guest_house" },
        { key: "tourism", value: "hostel" },
        { key: "tourism", value: "motel" }
      ]
    }
  ];

  return mappings.find((item) => item.pattern.test(value)) || {
    type: "point_of_interest",
    keyword: "nearby places",
    osmSelectors: [
      { key: "amenity" },
      { key: "shop" },
      { key: "tourism" }
    ]
  };
}

function buildOsmAddress(tags = {}) {
  const line1 = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  const locality = [
    tags["addr:suburb"],
    tags["addr:city"] || tags["addr:town"] || tags["addr:village"],
    tags["addr:state"]
  ]
    .filter(Boolean)
    .join(", ");

  const parts = [line1, locality].filter(Boolean);
  if (parts.length) return parts.join(", ");

  return (
    tags["addr:full"] ||
    tags["contact:street"] ||
    tags["addr:place"] ||
    null
  );
}

function getOsmCoordinates(element) {
  const latitude = Number.isFinite(element?.lat)
    ? element.lat
    : Number.isFinite(element?.center?.lat)
    ? element.center.lat
    : null;
  const longitude = Number.isFinite(element?.lon)
    ? element.lon
    : Number.isFinite(element?.center?.lon)
    ? element.center.lon
    : null;

  return { latitude, longitude };
}

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(earthRadius * c);
}

function looksTooGenericName(name, keyword) {
  const normalized = String(name || "").trim().toLowerCase();
  const generic = new Set([
    "hospital",
    "pharmacy",
    "restaurant",
    "cafe",
    "atm",
    "bank",
    "gas station",
    "police",
    "hotel",
    "nearby places"
  ]);
  return !normalized || generic.has(normalized) || normalized === String(keyword || "").trim().toLowerCase();
}

async function fetchNearbyPlacesFromOsm({ request, locationContext }) {
  const radius = request.keyword === "nearby places" ? 2500 : 5000;
  const selectorBlocks = request.osmSelectors.flatMap(({ key, value }) => {
    const filter = value ? `["${key}"="${value}"]` : `["${key}"]`;
    return [
      `node(around:${radius},${locationContext.latitude},${locationContext.longitude})${filter};`,
      `way(around:${radius},${locationContext.latitude},${locationContext.longitude})${filter};`,
      `relation(around:${radius},${locationContext.latitude},${locationContext.longitude})${filter};`
    ];
  });

  const query = `
[out:json][timeout:12];
(
  ${selectorBlocks.join("\n  ")}
);
out center 8;
`;

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "User-Agent": "ai-assistant-mobile/1.0"
    },
    body: query
  });

  if (!response.ok) return null;
  const data = await response.json();
  if (!Array.isArray(data.elements) || data.elements.length === 0) return null;

  const seen = new Set();
  const results = [];

  for (const element of data.elements) {
    const tags = element.tags || {};
    const { latitude, longitude } = getOsmCoordinates(element);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    const name =
      tags.name ||
      tags.brand ||
      tags.operator ||
      `${request.keyword[0].toUpperCase()}${request.keyword.slice(1)}`;
    const address = buildOsmAddress(tags);
    const distanceMeters = haversineDistanceMeters(
      locationContext.latitude,
      locationContext.longitude,
      latitude,
      longitude
    );
    const genericName = looksTooGenericName(name, request.keyword);
    if (genericName && !address) continue;

    const dedupeKey = `${name}|${address || ""}|${latitude || ""}|${longitude || ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    results.push({
      name,
      address,
      latitude,
      longitude,
      distanceMeters,
      genericName
    });
  }

  if (!results.length) return null;

  results.sort((a, b) => {
    if (a.genericName != b.genericName) return a.genericName ? 1 : -1;
    if ((a.distanceMeters || 0) != (b.distanceMeters || 0)) {
      return (a.distanceMeters || 0) - (b.distanceMeters || 0);
    }
    if (!!a.address != !!b.address) return a.address ? -1 : 1;
    return 0;
  });

  return {
    source: "OpenStreetMap",
    keyword: request.keyword,
    results: results.slice(0, 6).map(({ genericName, ...place }) => place)
  };
}

async function fetchNearbyPlacesFromGoogle({ request, locationContext }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({
    key: apiKey,
    location: `${locationContext.latitude},${locationContext.longitude}`,
    radius: "5000",
    type: request.type,
    keyword: request.keyword
  });

  const response = await fetch(
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params.toString()}`
  );

  if (!response.ok) return null;
  const data = await response.json();
  if (!Array.isArray(data.results) || data.results.length === 0) return null;

  return {
    source: "Google Places",
    keyword: request.keyword,
    results: data.results.slice(0, 6).map((place) => ({
      name: place.name,
      address: place.vicinity,
      rating: place.rating,
      userRatingsTotal: place.user_ratings_total,
      openNow: place.opening_hours?.open_now,
      latitude: place.geometry?.location?.lat,
      longitude: place.geometry?.location?.lng,
      distanceMeters:
        Number.isFinite(place.geometry?.location?.lat) &&
        Number.isFinite(place.geometry?.location?.lng)
          ? haversineDistanceMeters(
              locationContext.latitude,
              locationContext.longitude,
              place.geometry.location.lat,
              place.geometry.location.lng
            )
          : null
    }))
  };
}

async function fetchNearbyPlaces({ text, locationContext }) {
  const request = inferNearbyPlaceRequest(text);
  if (!request || !locationContext) return null;

  try {
    const freeResults = await fetchNearbyPlacesFromOsm({
      request,
      locationContext
    });
    if (freeResults) return freeResults;
  } catch (_) {
    // Fall back to Google only if a key is configured.
  }

  try {
    return await fetchNearbyPlacesFromGoogle({
      request,
      locationContext
    });
  } catch (_) {
    return null;
  }
}

function buildNearbyPlacesContext(nearbyPlaces) {
  if (!nearbyPlaces?.results?.length) return null;

  return [
    `Live nearby place results from ${nearbyPlaces.source} for "${nearbyPlaces.keyword}":`,
    ...nearbyPlaces.results.map((place, index) => {
      const parts = [
        `${index + 1}. ${place.name}`,
        place.address ? `Address: ${place.address}` : null,
        Number.isFinite(place.rating)
          ? `Rating: ${place.rating}${place.userRatingsTotal ? ` (${place.userRatingsTotal} reviews)` : ""}`
          : null,
        typeof place.openNow === "boolean"
          ? `Open now: ${place.openNow ? "yes" : "no"}`
          : null,
        Number.isFinite(place.distanceMeters)
          ? `Distance: ${place.distanceMeters} m`
          : null,
        Number.isFinite(place.latitude) && Number.isFinite(place.longitude)
          ? `Coordinates: ${place.latitude}, ${place.longitude}`
          : null
      ];
      return parts.filter(Boolean).join(" | ");
    }),
    "If a field like ratings or open-now status is missing, do not invent it.",
    "Use these live results directly. Do not say live map search is unavailable."
  ].join("\n");
}

function formatNearbyPlacesReply(nearbyPlaces) {
  if (!nearbyPlaces?.results?.length) return null;

  const title = `Nearby ${nearbyPlaces.keyword} places from ${nearbyPlaces.source}:`;
  const lines = nearbyPlaces.results.map((place, index) => {
    const parts = [`${index + 1}. ${place.name}`];
    if (place.address) parts.push(`Address: ${place.address}`);
    if (Number.isFinite(place.rating)) {
      parts.push(
        `Rating: ${place.rating}${place.userRatingsTotal ? ` (${place.userRatingsTotal} reviews)` : ""}`
      );
    }
    if (typeof place.openNow === "boolean") {
      parts.push(`Open now: ${place.openNow ? "yes" : "no"}`);
    }
    if (Number.isFinite(place.distanceMeters)) {
      parts.push(`Distance: ${place.distanceMeters} m`);
    }
    if (Number.isFinite(place.latitude) && Number.isFinite(place.longitude)) {
      parts.push(`Coordinates: ${place.latitude}, ${place.longitude}`);
    }
    return parts.join(" | ");
  });

  return [title, ...lines].join("\n");
}

async function generateReplyText({ messages, preferredLanguage, onboardingProfile, locationContext }) {
  const latestUserText = getLatestUserText(messages);
  const nearbyRequest = inferNearbyPlaceRequest(latestUserText);
  const responseLanguage = inferPreferredLanguage(messages, preferredLanguage);
  const explicitLanguage = normalizeLanguageName(preferredLanguage);
  const onboardingContext = buildOnboardingContext(onboardingProfile);
  const locationInstructions = buildLocationContext(locationContext);
  const nearbyPlaces = await fetchNearbyPlaces({
    text: latestUserText,
    locationContext
  });
  const nearbyPlacesContext = buildNearbyPlacesContext(nearbyPlaces);

  if (nearbyRequest && nearbyPlaces?.results?.length) {
    return formatNearbyPlacesReply(nearbyPlaces);
  }

  if (nearbyRequest && locationContext && !nearbyPlaces?.results?.length) {
    return [
      `I could not fetch live nearby ${nearbyRequest.keyword} places from the connected place service right now.`,
      "Please try again in a moment or search with a more specific type like hospital, cafe, ATM, pharmacy, or hotel.",
      "I am intentionally not guessing nearby area names because you asked for actual nearby places."
    ].join("\n");
  }

  return generateAssistantReply({
    messages: [
      {
        role: "system",
        content: explicitLanguage
          ? `Respond only in ${responseLanguage}. Do not mix languages. If the user writes in another language, still answer fully in ${responseLanguage} unless they explicitly ask for translation or ask you to switch languages. Keep technical terms like product names or library names only when necessary, but explain everything else in ${responseLanguage}.`
          : `Detect the user's language from the latest relevant message and respond fully in that same language. Do not mix languages unless the user explicitly asks for translation or bilingual output.`
      },
      ...(onboardingContext
        ? [
            {
              role: "system",
              content: `${onboardingContext}\nUse this profile to tailor the reply, examples, level of detail, and recommended actions across chat, email, reminders, voice, and translation features.`
            }
          ]
        : []),
      ...(locationInstructions
        ? [
            {
              role: "system",
              content: locationInstructions
            }
          ]
        : []),
      ...(nearbyPlacesContext
        ? [
            {
              role: "system",
              content: nearbyPlacesContext
            }
          ]
        : []),
      ...toAiMessages(messages)
    ]
  });
}

async function generateAndSaveReply({ conversationId, preferredLanguage, onboardingProfile, locationContext }) {
  const history = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    take: 30
  });

  const assistantText = await generateReplyText({
    messages: history,
    preferredLanguage,
    onboardingProfile,
    locationContext
  });

  const assistantMsg = await prisma.message.create({
    data: {
      conversationId,
      role: "ASSISTANT",
      content: assistantText
    }
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() }
  });

  return assistantMsg;
}

// ================= CONTROLLERS =================

// 1. List all conversations
async function listConversations(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = listConversationsSchema.parse(req.query || {});
    const query = input.q || "";

    const conversations = await prisma.conversation.findMany({
      where: {
        organizationId,
        userId,
        ...(query
          ? {
              OR: [
                { title: { contains: query, mode: "insensitive" } },
                { messages: { some: { content: { contains: query, mode: "insensitive" } } } }
              ]
            }
          : {})
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true
      }
    });

    res.json({ conversations });
  } catch (err) {
    next(err);
  }
}

// 2. Get single conversation with messages
async function getConversation(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const { id } = req.params;

    const conversation = await prisma.conversation.findFirst({
      where: { id, organizationId, userId },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            role: true,
            content: true,
            createdAt: true
          }
        }
      }
    });

    if (!conversation) {
      throw new HttpError(404, "Conversation not found");
    }

    res.json({ conversation });
  } catch (err) {
    next(err);
  }
}

// 3. Create new conversation
async function createConversation(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);

    const input = createConversationSchema.parse(req.body || {});

    const conversation = await prisma.conversation.create({
      data: {
        organizationId,
        userId,
        title: input.title || null
      },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true
      }
    });

    res.status(201).json({ conversation });
  } catch (err) {
    next(err);
  }
}

async function createFavorite(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = createFavoriteSchema.parse(req.body || {});

    const conversation = await ensureConversation({
      conversationId: input.conversationId,
      organizationId,
      userId
    });
    const message = await ensureConversationMessage({
      messageId: input.messageId,
      conversationId: input.conversationId
    });

    const favorite = await prisma.favorite.upsert({
      where: {
        userId_messageId: {
          userId,
          messageId: input.messageId
        }
      },
      update: {
        kind: message.role === "USER" ? "PROMPT" : "RESPONSE",
        title: buildFavoriteTitle({
          message,
          conversationTitle: conversation.title
        }),
        content: message.content,
        updatedAt: new Date()
      },
      create: {
        organizationId,
        userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        kind: message.role === "USER" ? "PROMPT" : "RESPONSE",
        title: buildFavoriteTitle({
          message,
          conversationTitle: conversation.title
        }),
        content: message.content
      },
      select: {
        id: true,
        conversationId: true,
        messageId: true,
        kind: true,
        title: true,
        content: true,
        createdAt: true,
        updatedAt: true
      }
    });

    res.status(201).json({ favorite: mapFavorite(favorite) });
  } catch (err) {
    next(err);
  }
}

// 4. Rename conversation
async function updateConversationTitle(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const { id } = req.params;
    const input = updateConversationTitleSchema.parse(req.body || {});

    await ensureConversation({ conversationId: id, organizationId, userId });

    const conversation = await prisma.conversation.update({
      where: { id },
      data: {
        title: input.title,
        updatedAt: new Date()
      },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true
      }
    });

    res.json({ conversation });
  } catch (err) {
    next(err);
  }
}

async function listFavorites(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);

    const favorites = await prisma.favorite.findMany({
      where: { organizationId, userId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        conversationId: true,
        messageId: true,
        kind: true,
        title: true,
        content: true,
        createdAt: true,
        updatedAt: true
      }
    });

    res.json({ favorites: favorites.map(mapFavorite) });
  } catch (err) {
    next(err);
  }
}

// 5. Delete conversation and all messages
async function deleteConversation(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const { id } = req.params;

    await ensureConversation({ conversationId: id, organizationId, userId });

    await prisma.conversation.delete({
      where: { id }
    });

    res.json({ deleted: true, conversationId: id });
  } catch (err) {
    next(err);
  }
}

async function deleteFavorite(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);

    const favorite = await prisma.favorite.findFirst({
      where: {
        id: req.params.id,
        organizationId,
        userId
      }
    });

    if (!favorite) {
      throw new HttpError(404, "Favorite not found");
    }

    await prisma.favorite.delete({
      where: { id: favorite.id }
    });

    res.json({ deleted: true, favoriteId: favorite.id });
  } catch (err) {
    next(err);
  }
}

// 6. Send message + get AI reply
async function sendMessage(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);

    const input = sendMessageSchema.parse(req.body);

    if (input.incognito) {
      const now = new Date().toISOString();
      const history = (input.history || []).map((message) => ({
        role: message.role,
        content: message.content
      }));
      const userMessage = {
        role: "USER",
        content: input.message
      };
      const assistantText = await generateReplyText({
        messages: [...history, userMessage],
        preferredLanguage: input.preferredLanguage,
        onboardingProfile: input.onboardingProfile,
        locationContext: input.locationContext
      });

      return res.status(201).json({
        incognito: true,
        conversationId: null,
        conversationTitle: "Incognito chat",
        message: {
          id: `incognito-user-${Date.now()}`,
          role: "USER",
          content: input.message,
          createdAt: now
        },
        reply: {
          id: `incognito-assistant-${Date.now()}`,
          role: "ASSISTANT",
          content: assistantText,
          createdAt: now
        }
      });
    }

    // ================= STEP 1: Conversation =================
    let conversationId = input.conversationId;

    if (conversationId) {
      await ensureConversation({ conversationId, organizationId, userId });
    } else {
      const conversation = await prisma.conversation.create({
        data: {
          organizationId,
          userId,
          title: buildConversationTitle({
            title: input.title,
            message: input.message
          })
        }
      });

      conversationId = conversation.id;
    }

    // ================= STEP 2: Save USER message =================
    const userMsg = await prisma.message.create({
      data: {
        conversationId,
        userId,
        role: "USER",
        content: input.message
      }
    });

    // ================= STEP 3: Generate and save AI reply with conversation memory =================
    const assistantMsg = await generateAndSaveReply({
      conversationId,
      preferredLanguage: input.preferredLanguage,
      onboardingProfile: input.onboardingProfile,
      locationContext: input.locationContext
    });

    // ================= STEP 8: Response =================
    res.status(201).json({
      conversationId,
      conversationTitle: input.conversationId
        ? undefined
        : buildConversationTitle({
            title: input.title,
            message: input.message
          }),
      message: {
        id: userMsg.id,
        role: userMsg.role,
        content: userMsg.content,
        createdAt: userMsg.createdAt
      },
      reply: {
        id: assistantMsg.id,
        role: assistantMsg.role,
        content: assistantMsg.content,
        createdAt: assistantMsg.createdAt
      }
    });

  } catch (err) {
    next(err);
  }
}

async function runQuickAction(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = quickActionSchema.parse(req.body || {});
    const prompt = buildQuickActionPrompt({
      action: input.action,
      text: input.text
    });

    if (input.incognito) {
      const now = new Date().toISOString();
      const history = (input.history || []).map((message) => ({
        role: message.role,
        content: message.content
      }));
      const userMessage = {
        role: "USER",
        content: prompt
      };
      const assistantText = await generateReplyText({
        messages: [...history, userMessage],
        preferredLanguage: input.preferredLanguage,
        onboardingProfile: input.onboardingProfile,
        locationContext: input.locationContext
      });

      return res.status(201).json({
        incognito: true,
        action: input.action,
        conversationId: null,
        conversationTitle: "Incognito chat",
        message: {
          id: `incognito-user-${Date.now()}`,
          role: "USER",
          content: prompt,
          createdAt: now
        },
        reply: {
          id: `incognito-assistant-${Date.now()}`,
          role: "ASSISTANT",
          content: assistantText,
          createdAt: now
        }
      });
    }

    let conversationId = input.conversationId;

    if (conversationId) {
      await ensureConversation({ conversationId, organizationId, userId });
    } else {
      const conversation = await prisma.conversation.create({
        data: {
          organizationId,
          userId,
          title: buildConversationTitle({
            title: null,
            message: prompt
          })
        }
      });

      conversationId = conversation.id;
    }

    const userMsg = await prisma.message.create({
      data: {
        conversationId,
        userId,
        role: "USER",
        content: prompt
      }
    });

    const assistantMsg = await generateAndSaveReply({
      conversationId,
      preferredLanguage: input.preferredLanguage,
      onboardingProfile: input.onboardingProfile,
      locationContext: input.locationContext
    });

    res.status(201).json({
      action: input.action,
      conversationId,
      conversationTitle: input.conversationId
        ? undefined
        : buildConversationTitle({
            title: null,
            message: prompt
          }),
      message: {
        id: userMsg.id,
        role: userMsg.role,
        content: userMsg.content,
        createdAt: userMsg.createdAt
      },
      reply: {
        id: assistantMsg.id,
        role: assistantMsg.role,
        content: assistantMsg.content,
        createdAt: assistantMsg.createdAt
      }
    });
  } catch (err) {
    next(err);
  }
}

async function runConversationalOnboarding(req, res, next) {
  try {
    const input = onboardingSchema.parse(req.body || {});
    const explicitLanguage = normalizeLanguageName(input.preferredLanguage);
    const responseLanguage = explicitLanguage || "English";

    const plan = await generateAssistantReply({
      messages: [
        {
          role: "system",
          content: explicitLanguage
            ? `You are an onboarding specialist for an AI assistant workspace. Respond only in ${responseLanguage}. Keep the response professional, warm, concise, and highly specific to the user. Use exactly three short labeled sections with plain text headings and bullets: "What your workspace can do", "Recommended first actions", and "A simple first-week plan". In the first section, the first bullet must start with "Priority setup:" and list the exact chosen features by name. You must explicitly use the user's role, primary goal, experience level, and chosen priority features. For a goal like building a mobile app, recommendations must directly mention planning screens, tasks, reminders, or app-building workflow when relevant. Do not describe features the user did not choose unless they are essential. Avoid generic product-tour language. Keep it under 180 words.`
            : "You are an onboarding specialist for an AI assistant workspace. Detect the user's language from their input and respond fully in that same language. Keep the response professional, warm, concise, and highly specific to the user. Use exactly three short labeled sections with plain text headings and bullets: \"What your workspace can do\", \"Recommended first actions\", and \"A simple first-week plan\". In the first section, the first bullet must start with \"Priority setup:\" and list the exact chosen features by name. You must explicitly use the user's role, primary goal, experience level, and chosen priority features. For a goal like building a mobile app, recommendations must directly mention planning screens, tasks, reminders, or app-building workflow when relevant. Do not describe features the user did not choose unless they are essential. Avoid generic product-tour language. Keep it under 180 words."
        },
        {
          role: "user",
          content: [
            `Role: ${input.role}`,
            `Primary goal: ${input.primaryGoal}`,
            `Experience level: ${input.experienceLevel}`,
            `Priority features: ${input.priorities.join(", ")}`
          ].join("\n")
        }
      ]
    });

    res.status(201).json({
      plan
    });
  } catch (err) {
    next(err);
  }
}

// 7. Regenerate last/selected assistant response from existing conversation history
async function regenerateResponse(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = regenerateResponseSchema.parse(req.body || {});

    await ensureConversation({
      conversationId: input.conversationId,
      organizationId,
      userId
    });

    const targetAssistant = input.assistantMessageId
      ? await prisma.message.findFirst({
          where: {
            id: input.assistantMessageId,
            conversationId: input.conversationId,
            role: "ASSISTANT"
          }
        })
      : await prisma.message.findFirst({
          where: {
            conversationId: input.conversationId,
            role: "ASSISTANT"
          },
          orderBy: { createdAt: "desc" }
        });

    if (!targetAssistant) {
      throw new HttpError(404, "Assistant response not found");
    }

    await prisma.message.delete({
      where: { id: targetAssistant.id }
    });

    const reply = await generateAndSaveReply({
      conversationId: input.conversationId,
      preferredLanguage: input.preferredLanguage,
      onboardingProfile: input.onboardingProfile,
      locationContext: input.locationContext
    });

    res.status(201).json({
      conversationId: input.conversationId,
      reply: {
        id: reply.id,
        role: reply.role,
        content: reply.content,
        createdAt: reply.createdAt
      }
    });
  } catch (err) {
    next(err);
  }
}

// 8. Edit a user message, remove later messages, and resend from that point
async function editAndResendMessage(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) throw new HttpError(401, "Unauthorized");
    const organizationId = await resolveOrgId(req);
    const input = editAndResendSchema.parse(req.body || {});

    await ensureConversation({
      conversationId: input.conversationId,
      organizationId,
      userId
    });

    const originalMessage = await prisma.message.findFirst({
      where: {
        id: input.messageId,
        conversationId: input.conversationId,
        role: "USER"
      }
    });

    if (!originalMessage) {
      throw new HttpError(404, "User message not found");
    }

    await prisma.message.deleteMany({
      where: {
        conversationId: input.conversationId,
        createdAt: { gt: originalMessage.createdAt }
      }
    });

    const updatedMessage = await prisma.message.update({
      where: { id: originalMessage.id },
      data: {
        content: input.message,
        userId
      }
    });

    const reply = await generateAndSaveReply({
      conversationId: input.conversationId,
      preferredLanguage: input.preferredLanguage,
      onboardingProfile: input.onboardingProfile,
      locationContext: input.locationContext
    });

    res.status(201).json({
      conversationId: input.conversationId,
      message: {
        id: updatedMessage.id,
        role: updatedMessage.role,
        content: updatedMessage.content,
        createdAt: updatedMessage.createdAt
      },
      reply: {
        id: reply.id,
        role: reply.role,
        content: reply.content,
        createdAt: reply.createdAt
      }
    });
  } catch (err) {
    next(err);
  }
}

// ================= EXPORT =================

module.exports = {
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
};
