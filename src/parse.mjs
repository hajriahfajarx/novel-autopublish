function extractField(text, label) {
  // Tolerates "Label:", "**Label:**", leading "- ", etc.
  // NOTE: the colon is REQUIRED and the capture is `.*` (zero or more), not
  // `.+` (one or more) -- with `.+`, a genuinely empty value makes the regex
  // engine backtrack and let the capture group eat the colon itself (or even
  // cross into the next line if the gap before it is \s*), so "empty" never
  // actually parses as empty. Caught by a real test case, not theoretical.
  const re = new RegExp(`^[ \\t\\-*]*${label}\\**[ \\t]*:(.*)$`, "im");
  const match = text.match(re);
  return match ? match[1].trim() : "";
}

function extractFencedBlock(text) {
  const match = text.match(/```(?:html)?\s*\n([\s\S]*?)\n```/i);
  return match ? match[1].trim() : "";
}

function extractCharacterUpdates(sectionText) {
  const afterLabel = sectionText.split(/Update Karakter\s*:?/i)[1];
  if (!afterLabel) return [];

  const lines = afterLabel.split("\n").map((l) => l.trim());
  const updates = [];
  for (const line of lines) {
    if (!line) continue;
    if (!line.startsWith("-")) break; // stop at the first non-bullet line (e.g. next section)
    const content = line.replace(/^-+\s*/, "");
    if (/tidak ada update/i.test(content)) continue;
    const parts = content.split("|").map((p) => p.trim());
    if (parts.length >= 2) {
      updates.push({
        name: parts[0],
        description: parts[1],
        statusNotes: parts[2] || "",
      });
    }
  }
  return updates;
}

export function parseChapterResponse(rawText) {
  const metaIndex = rawText.search(/#\s*METADATA/i);
  const contentIndex = rawText.search(/#\s*KONTEN BAB/i);

  if (metaIndex === -1 || contentIndex === -1 || contentIndex <= metaIndex) {
    throw new Error("Could not locate both METADATA and KONTEN BAB sections in Gemini's response.");
  }

  const metaSection = rawText.slice(metaIndex, contentIndex);
  const contentSection = rawText.slice(contentIndex);

  const meta = {
    title: extractField(metaSection, "Judul Bab"),
    synopsis: extractField(metaSection, "Sinopsis Bab Ini"),
    characterUpdates: extractCharacterUpdates(metaSection),
  };

  const html = extractFencedBlock(contentSection);

  return { meta, html };
}
