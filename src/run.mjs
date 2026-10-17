import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { getOAuthClient } from "./googleAuth.mjs";
import { ensureHeaderRows, readStoryLog, appendStoryRow, readCharacters, upsertCharacters } from "./sheets.mjs";
import { createGeminiClient, writeNextChapter, fixChapterResponse } from "./gemini.mjs";
import { parseChapterResponse } from "./parse.mjs";
import { validateChapter } from "./validate.mjs";
import { publishPost } from "./blogger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_FIX_ATTEMPTS = 3;

function dateStringInTz(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function alreadyHandledToday(storyLog, timeZone) {
  const today = dateStringInTz(new Date(), timeZone);
  return storyLog.some((row) => {
    if (!row.date || (row.status !== "published" && row.status !== "failed")) return false;
    const rowDate = new Date(row.date);
    if (Number.isNaN(rowDate.valueOf())) return false;
    return dateStringInTz(rowDate, timeZone) === today;
  });
}

async function main() {
  const config = loadConfig();
  const styleGuideTemplate = readFileSync(path.join(__dirname, "..", "prompts", "novel-style-guide.md"), "utf-8");

  const auth = getOAuthClient(config.google);
  const ai = createGeminiClient({ apiKey: config.gemini.apiKey });

  await ensureHeaderRows(auth, config.sheetId);
  const storyLog = await readStoryLog(auth, config.sheetId);
  const characters = await readCharacters(auth, config.sheetId);

  if (process.env.FORCE_RUN === "true") {
    console.log("FORCE_RUN=true — skipping the already-handled-today guard (manual test only, never set this in the scheduled workflow).");
  } else if (alreadyHandledToday(storyLog, config.timezone)) {
    console.log("Today already has a published/failed row in the log — skipping (prevents double-posting if slots ever overlap).");
    return;
  }

  const successfulChapters = storyLog.filter((r) => r.status === "published");
  const recentChapters = successfulChapters.slice(-3);
  const nextChapterNumber = (successfulChapters.at(-1)?.chapterNumber || 0) + 1;

  console.log(`Writing chapter ${nextChapterNumber}${recentChapters.length ? ` (continuing from chapter ${recentChapters.at(-1).chapterNumber})` : " (first chapter — inventing premise)"}...`);
  console.log(`Character bible has ${characters.length} character(s).`);

  const MAX_WRITE_ATTEMPTS = 2;
  let parsed = null;
  let writeFailureReason = null;
  for (let writeAttempt = 1; writeAttempt <= MAX_WRITE_ATTEMPTS; writeAttempt++) {
    let rawResponse;
    try {
      rawResponse = await writeNextChapter(ai, config.gemini.models, {
        styleGuideTemplate,
        recentChapters,
        characters,
        nextChapterNumber,
      });
      parsed = parseChapterResponse(rawResponse);
      writeFailureReason = null;
      break;
    } catch (err) {
      writeFailureReason = err.message;
      console.log(`Gemini's response (attempt ${writeAttempt}/${MAX_WRITE_ATTEMPTS}) didn't parse: ${err.message}`);
      if (rawResponse) {
        console.log(`--- Last 500 chars (to check for truncation) ---\n${rawResponse.slice(-500)}`);
      }
    }
  }

  if (!parsed) {
    console.error(`Could not get a parseable chapter from Gemini after ${MAX_WRITE_ATTEMPTS} attempt(s). NOT publishing.`);
    await appendStoryRow(auth, config.sheetId, {
      date: new Date().toISOString(),
      status: "failed",
      chapterNumber: nextChapterNumber,
      title: "",
      reason: `Unparseable response: ${writeFailureReason}`,
    });
    process.exitCode = 1;
    return;
  }

  let result = validateChapter(parsed);

  let attempt = 1;
  while (!result.ok && attempt < MAX_FIX_ATTEMPTS) {
    attempt += 1;
    console.log(`Validation found ${result.issues.length} issue(s), attempt ${attempt}/${MAX_FIX_ATTEMPTS} to fix:`);
    result.issues.forEach((i) => console.log(`  - ${i}`));

    const characterLines = parsed.meta.characterUpdates.length
      ? parsed.meta.characterUpdates.map((c) => `- ${c.name} | ${c.description} | ${c.statusNotes}`).join("\n")
      : "- Tidak ada update";
    const reconstructed = `# METADATA\n\nJudul Bab: ${parsed.meta.title}\nSinopsis Bab Ini: ${parsed.meta.synopsis}\nUpdate Karakter:\n${characterLines}\n\n# KONTEN BAB\n\n\`\`\`html\n${parsed.html}\n\`\`\``;
    const rawFixed = await fixChapterResponse(ai, config.gemini.models, reconstructed, result.issues);
    try {
      parsed = parseChapterResponse(rawFixed);
    } catch (err) {
      console.log(`Fix attempt didn't parse either: ${err.message}`);
    }
    result = validateChapter(parsed);
  }

  if (!result.ok) {
    console.error(`Chapter failed validation after ${attempt} attempt(s). NOT publishing. Issues:`);
    result.issues.forEach((i) => console.error(`  - ${i}`));

    await appendStoryRow(auth, config.sheetId, {
      date: new Date().toISOString(),
      status: "failed",
      chapterNumber: nextChapterNumber,
      title: parsed.meta.title,
      reason: result.issues.join(" | "),
    });

    process.exitCode = 1;
    return;
  }

  const postTitle = `Bab ${nextChapterNumber}: ${parsed.meta.title}`;
  console.log(config.draftMode ? "Saving as DRAFT on Blogger (DRAFT_MODE=true)..." : "Publishing to Blogger...");
  const published = await publishPost(auth, {
    blogId: config.blogId,
    title: postTitle,
    contentHtml: parsed.html,
    label: config.seriesLabel,
    isDraft: config.draftMode,
  });

  console.log(`${config.draftMode ? "Saved as draft" : "Published"}: ${published.url}`);

  await appendStoryRow(auth, config.sheetId, {
    date: new Date().toISOString(),
    status: "published",
    chapterNumber: nextChapterNumber,
    title: parsed.meta.title,
    synopsis: parsed.meta.synopsis,
    postUrl: published.url,
  });

  if (parsed.meta.characterUpdates.length) {
    console.log(`Updating ${parsed.meta.characterUpdates.length} character(s) in the character bible...`);
    await upsertCharacters(auth, config.sheetId, characters, parsed.meta.characterUpdates, nextChapterNumber);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Pipeline failed with an unexpected error:", err);
  process.exitCode = 1;
});
