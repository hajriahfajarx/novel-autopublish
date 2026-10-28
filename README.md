# novel-autopublish

Daily serialized-fiction auto-publish pipeline for a Blogger blog: each day writes and publishes the **next chapter** of an ongoing story (life journey, relationship dynamics, implicit/tasteful romance, centered on one protagonist who grows alongside a recurring cast) — not an independent topic each time. Runs **1x/day** via GitHub Actions, targeting a randomized real-world landing time around ~22:00–23:30 WIB (configured cron times are shifted earlier to compensate for observed GitHub scheduling delay — see `scripts/check-slot.mjs`).

This is a sibling project to `hajriahfajar-autopublish` (the tech/lifestyle blog pipeline) — same overall shape (local setup UI, zero-cost GitHub Actions slot-gating, Gemini retry/model-fallback), but with fully separate credentials (new Google account, new Gemini key, new Blogger blog, new Sheet) and a fundamentally different content model: **continuity, not rotation**.

## Two-phase model: generate weekly, publish daily from a queue

Publishing **no longer calls Gemini at all**. Instead:

1. **Generate** (`src/generate.mjs`, run via `.github/workflows/generate.yml`) writes several (default 10) complete, validated, ready-to-publish chapters in one batch run — once a week, off-peak (Tuesday 10:00 UTC / 17:00 WIB) — and queues them in the **Story** tab with `status = ready` (full chapter HTML included). Continuity (each chapter depends on the previous one's synopsis + character updates) is chained *within* the batch, so chapters 21–30 still read naturally in order even though they're all written in one sitting. Unlike the other two sibling projects, a failed chapter **stops the batch** instead of skipping ahead — chapters are visibly numbered and sequential, so a gap (Bab 24, then Bab 26) would be jarring for readers in a way an unrelated topic skip never is.
2. **Publish** (`src/run.mjs`, the existing daily workflow) just pulls the oldest (lowest `chapter_number`) `ready` row and posts it, marking it `done`. No Gemini call in this path at all.

This exists because calling Gemini at every single publish moment was exactly what caused a string of failures: Gemini's free tier occasionally has multi-minute 503/429 overload spells that exhaust both the primary and fallback model mid-publish. Batching means Gemini is only invoked during one deliberate weekly window, and a publish-time failure becomes nearly impossible since there's no Gemini call left to fail.

**Manual "dashboard"**: Actions tab → **Weekly batch generate** → **Run workflow** to generate on demand (optional custom count). The Google Sheet's **Story** tab is the visual queue — filter by `status` to see `ready`/`done`/`failed`.

If the queue runs dry, `run.mjs` logs a warning and does nothing that run (no on-the-fly fallback generation) — re-run the generate workflow manually if the queue ever looks low (10/week generated vs 7/week consumed gives a few days of buffer).

## How it works

1. A single daily window (configured 12:22–13:37 UTC, compensated for observed delay to land around 22:00–23:30 WIB) fires 6 small cron triggers (every 15 min, uncommon minute offsets). A dependency-free pre-check (`scripts/check-slot.mjs`) picks exactly one per day via a deterministic hash of today's date — the others exit in a few seconds without installing anything.
2. Reads the **Story** tab, skips if today's already been handled (a `published`/`done` row today).
3. Pulls the oldest `ready` chapter from the queue (see "Two-phase model" above) and publishes it to Blogger as `"Bab {n}: {title}"`, labeled with your configured series name, then flips that row to `done` with the post URL.

No images at all — this blog is text-only.

## One-time setup

### 1. Google Cloud Console (new Google account, manual, unavoidable)
1. Create a project at https://console.cloud.google.com with the **new** Google account.
2. Enable **Blogger API v3** and **Google Sheets API**.
3. Credentials → **Create Credentials → OAuth client ID** → Application type: **Desktop app**. Note the Client ID/Secret.
4. Configure the OAuth consent screen (External). To avoid the 7-day refresh-token expiry that Testing-mode apps get, publish it to **Production** (Audience page → Publish app) once Branding is filled in (app name + support/developer email is enough — skip the logo/home page/privacy fields, which trigger a verification requirement).

### 2. Gemini API key
From https://aistudio.google.com/apikey, same or different account — independent of the Blogger OAuth identity.

### 3. Create the new Blogger blog
Blog creation itself isn't available via the API — create it manually at https://www.blogger.com with the new Google account first.

### 4. Run the local settings UI
```bash
npm install
npm run setup
```
Opens `http://localhost:5578` (different port from the sibling project, so both can run at once). Fill in the Gemini key, OAuth Client ID/Secret, the new blog's URL, and a series label, then **Connect Google Account** (consent screen, log in with the new account). Once connected, it auto-detects the Blog ID and creates a new Sheet with both `Story` and `Characters` tabs pre-headered.

### 5. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
gh repo create <your-repo-name> --public --source=. --remote=origin
git push -u origin main
```
Public (not private) for unlimited free Actions minutes. Then re-run `npm run setup` (or check the box if you ran it after this step) to push secrets automatically, or add them manually: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `BLOG_ID`, `SHEET_ID`, `SERIES_LABEL`, `PUBLISH_TIMEZONE`. The same secrets are reused by `generate.yml` — no separate set needed.

GitHub Actions then runs daily (`.github/workflows/daily-post.yml`) — **but first, top up the queue**: Actions tab → "Weekly batch generate" → **Run workflow** once, so there's a chapter 1 `ready` to publish. Trigger a one-off publish test anytime from "Daily chapter auto-publish" → **Run workflow** (always proceeds immediately, bypassing the slot check).

## Local test run
```bash
npm run run
```
Add `DRAFT_MODE=true` to save as a Blogger draft instead of publishing. Add `FORCE_RUN=true` to bypass the same-day dedup guard (e.g. to test chapter 1 and chapter 2 back-to-back locally). Both are local-only, never GitHub secrets.

To generate a batch locally (writes real `ready`/`failed` rows to the Story tab, no Blogger calls at all):
```bash
GENERATE_COUNT=3 npm run generate
```

## Notes / known tradeoffs
- The character bible is a full-tab read-merge-rewrite on every chapter that has updates — simple and robust for a cast of dozens, but not designed for hundreds of characters.
- Continuity context is only the last 3 chapters' synopses plus the full character bible, not the full chapter text — keeps prompt size reasonable, but very long-range plot threads (beyond what fits in a character's `status_notes`) can fade over time. If that becomes a problem, consider periodically writing a longer "story so far" recap into a character-bible-like row.
- Validation here is lighter than the tech blog's (no image/toggle-script/bilingual checks — this is plain single-language HTML) but reuses the same leaked-instruction-text detection, which was a real bug found in practice on the sibling project.
- Romance is required to stay implicit/fade-to-black — this is enforced only by the prompt, not by any code-level content filter. Spot-check early chapters.
