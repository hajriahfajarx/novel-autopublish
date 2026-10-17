// Zero-dependency gate that decides whether THIS particular cron trigger
// should do the real work today. Runs BEFORE `npm ci` in the workflow so a
// "not my turn" run costs only a few seconds of billable runner time instead
// of sleeping in the runner.
//
// How it works: there's one daily publish window (21:00-22:00 WIB -- offset
// by an hour from the tech blog sibling project's 19:00-20:30 WIB evening
// window on purpose, so the two don't overlap and compete for the same
// shared Gemini API key's per-minute rate limit) with 4 fixed cron triggers
// spread across it (every 15 min). A deterministic hash
// of today's date picks exactly one of those 4 slots per day; every other
// trigger exits in a couple of seconds without installing anything. This
// still uses multiple redundant triggers per window (rather than a single
// cron + in-runner sleep) because GitHub's own schedule delivery can be
// unreliable/delayed on its own -- having several chances per window makes
// it more likely at least one fires reasonably on time, independent of
// Actions billing (this repo is public anyway, so billing isn't the
// motivation here, just delivery reliability).
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Must match the `schedule:` entries in .github/workflows/daily-post.yml.
const CRON_TO_SLOT = {
  "0 14 * * *": 0, // 21:00 WIB
  "15 14 * * *": 1, // 21:15 WIB
  "30 14 * * *": 2, // 21:30 WIB
  "45 14 * * *": 3, // 21:45 WIB
};
const SLOT_COUNT = Object.keys(CRON_TO_SLOT).length;

function todayDateString(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function chosenSlotForToday(timeZone) {
  const dateStr = todayDateString(timeZone);
  const hash = createHash("sha256").update(dateStr).digest();
  return { dateStr, slot: hash[0] % SLOT_COUNT };
}

function writeOutput(name, value) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    appendFileSync(outFile, `${name}=${value}\n`);
  }
  console.log(`${name}=${value}`);
}

const eventName = process.env.EVENT_NAME || "";
const scheduleCron = process.env.SCHEDULE_CRON || "";
const timezone = process.env.PUBLISH_TIMEZONE || "Asia/Jakarta";

if (eventName !== "schedule") {
  console.log(`Event is "${eventName}" (not a scheduled cron) — always proceeding immediately.`);
  writeOutput("proceed", "true");
} else {
  const { dateStr, slot: chosenSlot } = chosenSlotForToday(timezone);
  const thisSlot = CRON_TO_SLOT[scheduleCron];

  if (thisSlot === undefined) {
    console.log(`Unrecognized schedule cron "${scheduleCron}" — proceeding to be safe.`);
    writeOutput("proceed", "true");
  } else {
    const proceed = thisSlot === chosenSlot;
    console.log(`Date ${dateStr}: today's chosen slot is ${chosenSlot}/${SLOT_COUNT - 1}, this trigger is slot ${thisSlot} ("${scheduleCron}"). Proceed: ${proceed}`);
    writeOutput("proceed", String(proceed));
  }
}
