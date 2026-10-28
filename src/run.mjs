import { loadConfig } from "./config.mjs";
import { getOAuthClient } from "./googleAuth.mjs";
import { ensureHeaderRows, readStoryLog, updateStoryRow } from "./sheets.mjs";
import { publishPost } from "./blogger.mjs";

function dateStringInTz(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Only a terminal "posted" status blocks the rest of today's slots -- a
// "failed" row (e.g. a transient Gemini 503 overload spell during
// generation) must NOT block retries. "published" is legacy (pre-queue)
// terminology; "done" is the current queue-consumed terminal state -- both
// mean "today's chapter is handled".
function alreadyHandledToday(storyLog, timeZone) {
  const today = dateStringInTz(new Date(), timeZone);
  return storyLog.some((row) => {
    if (!row.date || (row.status !== "published" && row.status !== "done")) return false;
    const rowDate = new Date(row.date);
    if (Number.isNaN(rowDate.valueOf())) return false;
    return dateStringInTz(rowDate, timeZone) === today;
  });
}

// No Gemini call at all -- pulls the oldest (lowest chapter_number) `ready`
// row out of the queue (written by generate.mjs's weekly batch) and posts
// it.
async function main() {
  const config = loadConfig();
  const auth = getOAuthClient(config.google);

  await ensureHeaderRows(auth, config.sheetId);
  const storyLog = await readStoryLog(auth, config.sheetId);

  if (process.env.FORCE_RUN === "true") {
    console.log("FORCE_RUN=true — skipping the already-handled-today guard (manual test only, never set this in the scheduled workflow).");
  } else if (alreadyHandledToday(storyLog, config.timezone)) {
    console.log("Today already has a published/done row in the log — skipping (prevents double-posting if slots ever overlap).");
    return;
  }

  const readyRows = storyLog.filter((row) => row.status === "ready").sort((a, b) => a.chapterNumber - b.chapterNumber);
  if (readyRows.length === 0) {
    console.log('No "ready" chapters in the queue — nothing to publish. Run the generate workflow (or "Run workflow" on generate.yml) to top up the queue.');
    return;
  }

  const row = readyRows[0];
  console.log(`Publishing queued chapter ${row.chapterNumber} (row ${row.rowIndex}): "${row.title}"`);

  const postTitle = `Bab ${row.chapterNumber}: ${row.title}`;
  console.log(config.draftMode ? "Saving as DRAFT on Blogger (DRAFT_MODE=true)..." : "Publishing to Blogger...");
  const published = await publishPost(auth, {
    blogId: config.blogId,
    title: postTitle,
    contentHtml: row.contentHtml,
    label: config.seriesLabel,
    isDraft: config.draftMode,
  });

  console.log(`${config.draftMode ? "Saved as draft" : "Published"}: ${published.url}`);

  await updateStoryRow(auth, config.sheetId, row.rowIndex, {
    ...row,
    date: new Date().toISOString(),
    status: "done",
    postUrl: published.url,
  });

  console.log("Done.");
}

main().catch((err) => {
  console.error("Pipeline failed with an unexpected error:", err);
  process.exitCode = 1;
});
