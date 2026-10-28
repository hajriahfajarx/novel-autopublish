import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { getOAuthClient } from "./googleAuth.mjs";
import { ensureHeaderRows, readStoryLog, appendStoryRow, readCharacters, upsertCharacters } from "./sheets.mjs";
import { createGeminiClient, writeNextChapter, fixChapterResponse } from "./gemini.mjs";
import { parseChapterResponse } from "./parse.mjs";
import { validateChapter } from "./validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_FIX_ATTEMPTS = 3;
const MAX_WRITE_ATTEMPTS = 2;

// Batch-writes several chapters in one run (once a week, off-peak) and
// queues them as `ready` rows in the Sheet, instead of calling Gemini at
// every single daily publish moment. The daily publish job (run.mjs) then
// just pulls the oldest (lowest chapter_number) `ready` row and posts it --
// no Gemini call at publish time at all.
//
// Continuity (each chapter depends on the previous one's synopsis/character
// updates) is chained WITHIN this batch by re-reading the Story/Characters
// tabs after each chapter -- simpler and more robust than maintaining a
// parallel in-memory merge of the same logic readStoryLog/readCharacters
// already do, at the cost of a couple of extra cheap Sheets API calls per
// chapter.
//
// Unlike the tech blog / music blog batches, a failed chapter here STOPS the
// batch instead of skipping ahead: chapters are strictly sequential and
// visibly numbered (Bab 24, Bab 25, ...), so leaving a gap would be jarring
// for readers in a way an unrelated topic skip never is.
async function main() {
  const config = loadConfig();
  const styleGuideTemplate = readFileSync(path.join(__dirname, "..", "prompts", "novel-style-guide.md"), "utf-8");

  const auth = getOAuthClient(config.google);
  const ai = createGeminiClient({ apiKey: config.gemini.apiKey });

  await ensureHeaderRows(auth, config.sheetId);

  const count = parseInt(process.env.GENERATE_COUNT || "10", 10);
  console.log(`Generating up to ${count} chapter(s) into the queue...`);

  let readyCount = 0;

  for (let i = 1; i <= count; i++) {
    const storyLog = await readStoryLog(auth, config.sheetId);
    const characters = await readCharacters(auth, config.sheetId);
    // "ready" and "done" chapters both count for continuity purposes --
    // only "failed" rows (never actually written) are excluded.
    const notFailed = storyLog.filter((r) => r.status !== "failed");
    const recentChapters = notFailed.slice(-3);
    const nextChapterNumber = (notFailed.at(-1)?.chapterNumber || 0) + 1;

    console.log(`\n--- Chapter ${nextChapterNumber} (${i}/${count} this batch) ---`);
    console.log(`Character bible has ${characters.length} character(s).`);

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
      console.error(`Could not get a parseable chapter after ${MAX_WRITE_ATTEMPTS} attempt(s). Stopping the batch here (chapters must stay sequential, no gaps) -- ${readyCount} chapter(s) queued so far this run.`);
      await appendStoryRow(auth, config.sheetId, {
        date: new Date().toISOString(),
        status: "failed",
        chapterNumber: nextChapterNumber,
        title: "",
        reason: `Unparseable response: ${writeFailureReason}`,
      });
      break;
    }

    let result = validateChapter(parsed);
    let attempt = 1;
    while (!result.ok && attempt < MAX_FIX_ATTEMPTS) {
      attempt += 1;
      console.log(`Validation found ${result.issues.length} issue(s), attempt ${attempt}/${MAX_FIX_ATTEMPTS} to fix:`);
      result.issues.forEach((issue) => console.log(`  - ${issue}`));

      const characterLines = parsed.meta.characterUpdates.length
        ? parsed.meta.characterUpdates.map((c) => `- ${c.name} | ${c.description} | ${c.statusNotes}`).join("\n")
        : "- Tidak ada update";
      const reconstructed = `# METADATA\n\nJudul Bab: ${parsed.meta.title}\nSinopsis Bab Ini: ${parsed.meta.synopsis}\nTahap Cerita: ${parsed.meta.arcStage}\nUsia Saat Ini: ${parsed.meta.characterAges}\nUpdate Karakter:\n${characterLines}\n\n# KONTEN BAB\n\n\`\`\`html\n${parsed.html}\n\`\`\``;
      const rawFixed = await fixChapterResponse(ai, config.gemini.models, reconstructed, result.issues);
      try {
        parsed = parseChapterResponse(rawFixed);
      } catch (err) {
        console.log(`Fix attempt didn't parse either: ${err.message}`);
      }
      result = validateChapter(parsed);
    }

    if (!result.ok) {
      console.error(`Chapter ${nextChapterNumber} failed validation after ${attempt} attempt(s). Stopping the batch here (chapters must stay sequential, no gaps) -- ${readyCount} chapter(s) queued so far this run.`);
      result.issues.forEach((issue) => console.error(`  - ${issue}`));
      await appendStoryRow(auth, config.sheetId, {
        date: new Date().toISOString(),
        status: "failed",
        chapterNumber: nextChapterNumber,
        title: parsed.meta.title,
        reason: result.issues.join(" | "),
      });
      break;
    }

    await appendStoryRow(auth, config.sheetId, {
      date: new Date().toISOString(),
      status: "ready",
      chapterNumber: nextChapterNumber,
      title: parsed.meta.title,
      synopsis: parsed.meta.synopsis,
      arcStage: parsed.meta.arcStage,
      characterAges: parsed.meta.characterAges,
      contentHtml: parsed.html,
    });
    readyCount++;
    console.log(`Queued chapter ${nextChapterNumber} as ready: "${parsed.meta.title}"`);

    if (parsed.meta.characterUpdates.length) {
      console.log(`Updating ${parsed.meta.characterUpdates.length} character(s) in the character bible...`);
      await upsertCharacters(auth, config.sheetId, characters, parsed.meta.characterUpdates, nextChapterNumber);
    }
  }

  console.log(`\nDone. ${readyCount} chapter(s) queued as ready.`);
}

main().catch((err) => {
  console.error("Generate batch failed with an unexpected error:", err);
  process.exitCode = 1;
});
