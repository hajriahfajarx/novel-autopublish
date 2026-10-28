import { google } from "googleapis";

const STORY_SHEET = "Story";
const CHARACTERS_SHEET = "Characters";
const STORY_HEADER = ["date", "status", "chapter_number", "title", "synopsis", "arc_stage", "character_ages", "post_url", "reason", "content_html"];
const CHARACTERS_HEADER = ["name", "description", "status_notes", "first_appeared_chapter", "last_updated_chapter"];

async function ensureSheetExists(sheets, spreadsheetId, title) {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (data.sheets || []).some((s) => s.properties?.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }
}

export async function ensureHeaderRows(auth, sheetId) {
  const sheets = google.sheets({ version: "v4", auth });

  await ensureSheetExists(sheets, sheetId, STORY_SHEET);
  await ensureSheetExists(sheets, sheetId, CHARACTERS_SHEET);

  const { data: storyData } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${STORY_SHEET}!A1:J1`,
  });
  if (!storyData.values?.[0] || storyData.values[0].join("|") !== STORY_HEADER.join("|")) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${STORY_SHEET}!A1:J1`,
      valueInputOption: "RAW",
      requestBody: { values: [STORY_HEADER] },
    });
  }

  const { data: charData } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${CHARACTERS_SHEET}!A1:E1`,
  });
  if (!charData.values?.[0] || charData.values[0].join("|") !== CHARACTERS_HEADER.join("|")) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${CHARACTERS_SHEET}!A1:E1`,
      valueInputOption: "RAW",
      requestBody: { values: [CHARACTERS_HEADER] },
    });
  }
}

function storyRowToValues(row) {
  return [
    row.date,
    row.status,
    row.chapterNumber,
    row.title,
    row.synopsis || "",
    row.arcStage || "",
    row.characterAges || "",
    row.postUrl || "",
    row.reason || "",
    row.contentHtml || "",
  ];
}

export async function readStoryLog(auth, sheetId) {
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${STORY_SHEET}!A2:J`,
  });
  const rows = data.values || [];
  return rows.map((row, i) => ({
    // 1-based sheet row number (row 1 is the header, data starts at row 2).
    rowIndex: i + 2,
    date: row[0] || "",
    status: row[1] || "",
    chapterNumber: Number(row[2]) || 0,
    title: row[3] || "",
    synopsis: row[4] || "",
    arcStage: row[5] || "",
    characterAges: row[6] || "",
    postUrl: row[7] || "",
    reason: row[8] || "",
    contentHtml: row[9] || "",
  }));
}

export async function appendStoryRow(auth, sheetId, row) {
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${STORY_SHEET}!A:J`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [storyRowToValues(row)] },
  });
}

/**
 * Updates an existing Story row in place (identified by its absolute sheet
 * row number, from readStoryLog's `rowIndex`) instead of appending a new one
 * -- used to flip a queued `ready` chapter to `done` once it's actually
 * published, without disturbing any other row.
 */
export async function updateStoryRow(auth, sheetId, rowIndex, row) {
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${STORY_SHEET}!A${rowIndex}:J${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [storyRowToValues(row)] },
  });
}

export async function readCharacters(auth, sheetId) {
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${CHARACTERS_SHEET}!A2:E`,
  });
  const rows = data.values || [];
  return rows.map((row) => ({
    name: row[0] || "",
    description: row[1] || "",
    statusNotes: row[2] || "",
    firstAppearedChapter: Number(row[3]) || 0,
    lastUpdatedChapter: Number(row[4]) || 0,
  }));
}

/**
 * Upserts character updates into the Characters tab: existing characters
 * (matched by name, case-insensitive) get their description/status/
 * last_updated_chapter refreshed in place; new names are appended. Done as
 * a full read-merge-rewrite of the tab rather than targeted range updates,
 * since a cast of at most a few dozen characters makes that simple and
 * robust (no risk of range-offset bugs as rows are added over time).
 */
export async function upsertCharacters(auth, sheetId, existingCharacters, updates, chapterNumber) {
  if (!updates.length) return;

  const byName = new Map(existingCharacters.map((c) => [c.name.toLowerCase(), { ...c }]));

  for (const update of updates) {
    const key = update.name.toLowerCase();
    if (byName.has(key)) {
      const existing = byName.get(key);
      existing.description = update.description || existing.description;
      existing.statusNotes = update.statusNotes || existing.statusNotes;
      existing.lastUpdatedChapter = chapterNumber;
    } else {
      byName.set(key, {
        name: update.name,
        description: update.description || "",
        statusNotes: update.statusNotes || "",
        firstAppearedChapter: chapterNumber,
        lastUpdatedChapter: chapterNumber,
      });
    }
  }

  const merged = [...byName.values()];
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${CHARACTERS_SHEET}!A2:E${merged.length + 1}`,
    valueInputOption: "RAW",
    requestBody: {
      values: merged.map((c) => [c.name, c.description, c.statusNotes, c.firstAppearedChapter, c.lastUpdatedChapter]),
    },
  });
}
