const dotenv = require("dotenv");

dotenv.config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT || 4000),
  DATABASE_URL: required("DATABASE_URL"),
  JWT_SECRET: required("JWT_SECRET"),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "7d",
  REFRESH_TOKEN_SECRET: required("REFRESH_TOKEN_SECRET"),
  REFRESH_TOKEN_EXPIRES_DAYS: Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 30),
  AI_BASE_URL: process.env.AI_BASE_URL || "https://openrouter.ai/api/v1",
  AI_API_KEY: process.env.AI_API_KEY || "",
  AI_MODEL: process.env.AI_MODEL || "meta-llama/llama-3-8b-instruct",
  GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID || "",
  GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET || "",
  GMAIL_REDIRECT_URI:
    process.env.GMAIL_REDIRECT_URI || "http://localhost:4000/api/email/oauth/callback",
  APP_BASE_URL: process.env.APP_BASE_URL || "http://localhost:4000"
};

module.exports = { env };

