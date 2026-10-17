import { GoogleGenAI } from "@google/genai";

export function createGeminiClient({ apiKey }) {
  return new GoogleGenAI({ apiKey });
}

function isRetryableStatus(err) {
  const status = err?.status || err?.response?.status;
  return status === 503 || status === 429 || status === 500;
}

async function generateContentWithRetry(ai, params, { retries = 4, baseDelayMs = 5000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryableStatus(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      console.log(`Gemini call failed (${err?.status || "unknown status"}), retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Tries each model in `models` (in order) with its own retry-with-backoff
 * cycle, falling through to the next model only once a given model has
 * exhausted its retries. Same resilience pattern proven on the tech blog
 * pipeline (protects against one model being temporarily overloaded).
 */
async function generateContentWithFallback(ai, models, paramsWithoutModel, retryOpts) {
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    try {
      return await generateContentWithRetry(ai, { ...paramsWithoutModel, model: models[i] }, retryOpts);
    } catch (err) {
      lastErr = err;
      if (i < models.length - 1) {
        console.log(`Model "${models[i]}" exhausted its retries, falling back to "${models[i + 1]}"...`);
      }
    }
  }
  throw lastErr;
}

function formatCharacters(characters) {
  if (!characters.length) return "(belum ada karakter — ini kemungkinan bab pertama)";
  return characters
    .map((c) => `- ${c.name}: ${c.description} | Status/arc saat ini: ${c.statusNotes || "-"} (pertama muncul di Bab ${c.firstAppearedChapter})`)
    .join("\n");
}

function formatRecentChapters(recentChapters) {
  if (!recentChapters.length) return null;
  return recentChapters
    .map((r) => `Bab ${r.chapterNumber} — "${r.title}": ${r.synopsis}`)
    .join("\n\n");
}

/**
 * Writes the next chapter of the ongoing serialized story. If recentChapters
 * is empty, this is chapter 1 and Gemini invents the opening premise from
 * scratch (per styleGuideTemplate's chapter-1 branch); otherwise it continues
 * directly from the most recent chapters' synopses, consistent with the
 * character bible.
 */
export async function writeNextChapter(ai, models, { styleGuideTemplate, recentChapters, characters, nextChapterNumber }) {
  const recentText = formatRecentChapters(recentChapters);
  const filled = styleGuideTemplate
    .replaceAll("{{NEXT_CHAPTER_NUMBER}}", String(nextChapterNumber))
    .replaceAll("{{IS_FIRST_CHAPTER}}", recentChapters.length === 0 ? "YA — ini BAB PERTAMA, belum ada cerita sebelumnya." : "TIDAK — lanjutkan dari bab-bab sebelumnya di bawah.")
    .replaceAll("{{RECENT_CHAPTERS}}", recentText || "(tidak ada — ini bab pertama)")
    .replaceAll("{{CHARACTER_BIBLE}}", formatCharacters(characters));

  const response = await generateContentWithFallback(ai, models, {
    contents: filled,
  });

  return response.text;
}

/**
 * Sends back a list of concrete problems found in the generated chapter
 * (METADATA + KONTEN BAB sections) and asks Gemini to return the full
 * corrected response in the same two-section format.
 */
export async function fixChapterResponse(ai, models, brokenRawResponse, issues) {
  const prompt = `Berikut adalah respons bab cerita (METADATA + KONTEN BAB) yang perlu diperbaiki. Ditemukan masalah berikut:

${issues.map((i) => `- ${i}`).join("\n")}

Respons yang perlu diperbaiki (perbaiki HANYA bagian yang bermasalah, jangan ubah isi lain yang sudah benar):

"""
${brokenRawResponse}
"""

Balas dengan format LENGKAP yang sudah diperbaiki, persis mengikuti format "# METADATA" dan "# KONTEN BAB" (dengan fenced code block \`\`\`html ... \`\`\`) seperti sebelumnya. Jangan tambahkan penjelasan di luar format itu.`;

  const response = await generateContentWithFallback(ai, models, {
    contents: prompt,
  });

  return response.text;
}
