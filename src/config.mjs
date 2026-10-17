import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Run "npm run setup" or copy .env.example to .env.`);
  }
  return value;
}

export function loadConfig() {
  return {
    gemini: {
      apiKey: required("GEMINI_API_KEY"),
      models: (process.env.GEMINI_MODEL || "gemini-flash-latest,gemini-flash-lite-latest")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    },
    google: {
      clientId: required("GOOGLE_CLIENT_ID"),
      clientSecret: required("GOOGLE_CLIENT_SECRET"),
      refreshToken: required("GOOGLE_REFRESH_TOKEN"),
    },
    blogId: required("BLOG_ID"),
    sheetId: required("SHEET_ID"),
    seriesLabel: process.env.SERIES_LABEL || "Cerita",
    timezone: process.env.PUBLISH_TIMEZONE || "Asia/Jakarta",
    // Local-only, never a GitHub secret -- see README.
    draftMode: process.env.DRAFT_MODE === "true",
  };
}
