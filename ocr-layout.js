// Reading the text of each paragraph: the reader's page data says where every
// paragraph is (page-render.js pageParagraphs) but not what it says, since
// its glyphs are numbered rather than characters. Tesseract reads the lines;
// each line goes into the paragraph that covers it.
// Loaded by the service worker with importScripts; no DOM or chrome APIs.

// Slack around a paragraph's box, in page pixels: OCR line boxes reach a
// little past the glyphs the reader placed.
const PARA_PAD = 4;

// The text of each paragraph in `paras` (each with `boxes` in the same
// pixels as the lines), from OCR `lines` ({ x0, y0, x1, y1, text,
// confidence }). A line goes to the paragraph whose box covers most of it,
// more than half; lines no paragraph covers are dropped (specks, the edge of
// an illustration). Each paragraph's lines are joined box by box, top to
// bottom.
function assignLines(lines, paras) {
  const items = paras.map(() => []);
  for (const l of lines.filter(isText)) {
    let best = null;
    let bestCover = 0.5;
    paras.forEach((p, i) =>
      p.boxes.forEach((b, j) => {
        const cover = overlapArea(l, pad(b)) / (area(l) || 1);
        if (cover > bestCover) [best, bestCover] = [{ i, j }, cover];
      })
    );
    if (best) items[best.i].push({ box: best.j, line: l });
  }
  return items.map((list) => joinLines(list.sort((a, b) => a.box - b.box || a.line.y0 - b.line.y0).map((it) => it.line.text.trim())));
}

function pad(b) {
  return { x0: b.x0 - PARA_PAD, y0: b.y0 - PARA_PAD, x1: b.x1 + PARA_PAD, y1: b.y1 + PARA_PAD };
}

// Drop OCR noise: specks, a stray rule read as dashes.
function isText(l) {
  const t = (l.text || "").trim();
  const letters = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  if (!letters) return false;
  if (l.confidence < 40) return false;
  return letters >= 2 || l.confidence >= 80;
}

// Rejoin lines, undoing end-of-line hyphenation ("disco-" + "theque").
function joinLines(parts) {
  return parts.filter(Boolean).reduce((acc, p) => {
    if (!acc) return p;
    if (/[a-z]-$/.test(acc) && /^[a-z]/.test(p)) return acc.slice(0, -1) + p;
    return `${acc} ${p}`;
  }, "");
}

function overlapArea(a, b) {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
}

function area(r) {
  return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
}

if (typeof module !== "undefined") module.exports = { PARA_PAD, assignLines, isText, joinLines };
