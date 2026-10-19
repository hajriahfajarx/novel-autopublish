// Zero-dependency gate that decides whether THIS particular cron trigger
// should do the real work today. Runs BEFORE `npm ci` in the workflow so a
// "not my turn" run costs only a few seconds of billable runner time instead
// of sleeping in the runner.
//
// How it works: there's one daily publish window, targeting a real-world
// landing of 22:00-23:30 WIB -- offset from the tech blog sibling project's
// windows on purpose, so they don't overlap and compete for the same shared
// Gemini API key's per-minute rate limit -- with 6 fixed cron triggers
// spread across it (every 15 min, uncommon minute offsets). A deterministic
// hash of today's date picks exactly one of those slots per day; every
// other trigger exits in a couple of seconds without installing anything.
// This still uses multiple redundant triggers per window (rather than a
// single cron + in-runner sleep) because GitHub's own schedule delivery was
// observed to be delayed by ~2.5-3h in practice (see the compensation note
// on CRON_TO_SLOT below) -- having several chances per window makes it more
// likely at least one fires reasonably close to the target, independent of
// Actions billing (this repo is public anyway, so billing isn't the
// motivation here, just delivery reliability).
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Must match the `schedule:` entries in .github/workflows/daily-post.yml.
//
// COMPENSATED: configured 12:22-13:37 UTC for a real-world landing around
// 15:00-16:30 UTC = 22:00-23:30 WIB. Observed in practice: GitHub was
// delivering this account's scheduled triggers ~2.5-3h late (likely queuing
// congestion on common :00/:15/:30/:45 marks), so this is shifted earlier +
// uses uncommon minute offsets. Re-tune if the delay pattern changes.
const CRON_TO_SLOT = {
  "22 12 * * *": 0,
  "37 12 * * *": 1,
  "52 12 * * *": 2,
  "7 13 * * *": 3,
  "22 13 * * *": 4,
  "37 13 * * *": 5,
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
