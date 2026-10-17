import { validateChapter } from "./validate.mjs";
import { parseChapterResponse } from "./parse.mjs";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

// --- Case 1: broken response (empty content, placeholder leak) ---
const brokenResponse = `
# METADATA

Judul Bab: {JUDUL}
Sinopsis Bab Ini:
Update Karakter:
- Tidak ada update

# KONTEN BAB

\`\`\`html
<!-- konten bab di sini -->
\`\`\`
`;

const broken = parseChapterResponse(brokenResponse);
const brokenResult = validateChapter(broken);
assert(brokenResult.ok === false, "broken response should fail validation");
assert(brokenResult.issues.length > 0, "broken response should report issues");
assert(
  brokenResult.issues.some((i) => i.toLowerCase().includes("sinopsis")),
  "should flag the empty synopsis field"
);

// --- Case 2: clean response ---
const longContent = "Ini adalah paragraf contoh cerita yang cukup panjang untuk lolos validasi kata minimum. ".repeat(60);

const cleanResponse = `
# METADATA

Judul Bab: Pertemuan Tak Terduga
Sinopsis Bab Ini: Arka bertemu dengan Sari di kedai kopi dan mereka mengobrol untuk pertama kalinya.
Update Karakter:
- Arka | Pria 28 tahun, arsitek, introvert | Baru saja pindah ke kota ini
- Sari | Wanita 26 tahun, barista, ceria | Pertama kali bertemu Arka

# KONTEN BAB

\`\`\`html
<p>${longContent}</p>
\`\`\`
`;

const clean = parseChapterResponse(cleanResponse);
const cleanResult = validateChapter(clean);
if (!cleanResult.ok) {
  console.error("Clean response issues:", cleanResult.issues);
}
assert(cleanResult.ok === true, "clean, fully-filled response should pass validation");
assert(clean.meta.characterUpdates.length === 2, "should parse both character updates");
assert(clean.meta.characterUpdates[0].name === "Arka", "should parse the first character's name correctly");

if (process.exitCode === 1) {
  console.error("\nSome validate.mjs tests FAILED.");
} else {
  console.log("\nAll validate.mjs tests passed.");
}
