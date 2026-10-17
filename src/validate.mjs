const PLACEHOLDER_PATTERNS = [
  /\{\{.*?\}\}/,
  /\{JUDUL\}/i,
  /\[nama\s/i,
  /\[disamarkan\]/i,
  /lorem ipsum/i,
  /\bTODO\b/,
  /example\.com/i,
  /<!--\s*konten bab di sini\s*-->/i,
];

const MIN_WORDS = 400;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

export function validateChapter({ meta, html }) {
  const issues = [];

  if (!meta.title || !meta.title.trim()) {
    issues.push('Field METADATA "Judul Bab" kosong — wajib diisi.');
  }
  if (!meta.synopsis || !meta.synopsis.trim()) {
    issues.push('Field METADATA "Sinopsis Bab Ini" kosong — wajib diisi (dibutuhkan untuk kelanjutan bab berikutnya).');
  }

  for (const [field, value] of [["title", meta.title], ["synopsis", meta.synopsis]]) {
    if (!value) continue;
    if (PLACEHOLDER_PATTERNS.some((p) => p.test(value))) {
      issues.push(`Field METADATA "${field}" sepertinya masih mengandung placeholder/instruksi yang ikut ter-copy: "${value}".`);
    }
  }

  if (!html || !html.trim()) {
    issues.push("KONTEN BAB kosong atau tidak ditemukan di dalam fenced code block.");
    return { ok: false, issues };
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(html)) {
      issues.push(`KONTEN BAB masih mengandung placeholder yang belum diisi (pola: ${pattern}).`);
    }
  }

  const words = wordCount(stripHtml(html));
  if (words < MIN_WORDS) {
    issues.push(`KONTEN BAB terlalu pendek (${words} kata, minimal ${MIN_WORDS}).`);
  }

  return { ok: issues.length === 0, issues };
}
