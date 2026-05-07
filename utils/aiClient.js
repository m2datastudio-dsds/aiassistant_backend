const { env } = require("../config/env");
const { HttpError } = require("./httpError");

async function generateAssistantReply({ messages }) {
  if (!env.AI_API_KEY) {
    throw new HttpError(
      500,
      "AI provider is not configured",
      "Set AI_API_KEY (and optionally AI_BASE_URL, AI_MODEL) in backend .env"
    );
  }

  const url = `${env.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
  "Content-Type": "application/json",
  Authorization: `Bearer ${env.AI_API_KEY}`,
  "HTTP-Referer": "http://localhost:4000",
  "X-Title": "AI Assistant App"
},
    body: JSON.stringify({
      model: env.AI_MODEL,
      messages
    })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new HttpError(502, "AI provider error", text || `HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new HttpError(502, "AI provider returned empty response");
  return String(content);
}

module.exports = { generateAssistantReply };

