# novel-autopublish

Daily serialized-fiction auto-publish pipeline for a Blogger blog: each day writes and publishes the **next chapter** of an ongoing story (life journey, relationship dynamics, implicit/tasteful romance, centered on one protagonist who grows alongside a recurring cast) — not an independent topic each time. Runs **1x/day** via GitHub Actions, landing at a randomized time in a ~21:00–22:00 WIB window.

This is a sibling project to `hajriahfajar-autopublish` (the tech/lifestyle blog pipeline) — same overall shape (local setup UI, zero-cost GitHub Actions slot-gating, Gemini retry/model-fallback), but with fully separate credentials (new Google account, new Gemini key, new Blogger blog, new Sheet) and a fundamentally different content model: **continuity, not rotation**.

## How it works

1. A single daily window (21:00–22:00 WIB) fires 4 small cron triggers (every 15 min). A dependency-free pre-check (`scripts/check-slot.mjs`) picks exactly one per day via a deterministic hash of today's date — the other 3 exit in a few seconds without installing anything.
2. Reads the **Story** tab of the Google Sheet: the last few chapters' synopses (for direct continuity) and the latest chapter number. Reads the **Characters** tab in full (the "character bible").
3. Asks Gemini to write the next chapter — continuing directly from the most recent chapter(s), staying consistent with every established character, following `prompts/novel-style-guide.md` (casual Indonesian, implicit/tasteful romance only — never explicit, one protagonist, chapter-ending hooks). If the Story tab is empty, this is chapter 1 and Gemini invents an original premise instead.
4. Validates the result (non-empty title/synopsis, minimum word count, no leaked template/instruction text). Repairs via a fix-request loop (up to 3 attempts) if something's wrong; if it still fails, logs a `failed` row and stops without publishing.
5. Publishes to Blogger as `"Bab {n}: {title}"`, labeled with your configured series name.
6. Appends a row to the **Story** tab (date, status, chapter number, title, synopsis, post URL) and **upserts** the **Characters** tab with any new/changed characters Gemini reported.

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
Public (not private) for unlimited free Actions minutes. Then re-run `npm run setup` (or check the box if you ran it after this step) to push secrets automatically, or add them manually: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `BLOG_ID`, `SHEET_ID`, `SERIES_LABEL`, `PUBLISH_TIMEZONE`.

GitHub Actions then runs daily (`.github/workflows/daily-post.yml`). Trigger a one-off test anytime from the **Actions** tab → "Daily chapter auto-publish" → **Run workflow** (always proceeds immediately, bypassing the slot check).

## Local test run
```bash
npm run run
```
Add `DRAFT_MODE=true` to save as a Blogger draft instead of publishing. Add `FORCE_RUN=true` to bypass the same-day dedup guard (e.g. to test chapter 1 and chapter 2 back-to-back locally). Both are local-only, never GitHub secrets.

## Notes / known tradeoffs
- The character bible is a full-tab read-merge-rewrite on every chapter that has updates — simple and robust for a cast of dozens, but not designed for hundreds of characters.
- Continuity context is only the last 3 chapters' synopses plus the full character bible, not the full chapter text — keeps prompt size reasonable, but very long-range plot threads (beyond what fits in a character's `status_notes`) can fade over time. If that becomes a problem, consider periodically writing a longer "story so far" recap into a character-bible-like row.
- Validation here is lighter than the tech blog's (no image/toggle-script/bilingual checks — this is plain single-language HTML) but reuses the same leaked-instruction-text detection, which was a real bug found in practice on the sibling project.
- Romance is required to stay implicit/fade-to-black — this is enforced only by the prompt, not by any code-level content filter. Spot-check early chapters.
