// Reading the text of each paragraph: the reader's page data says where every
// paragraph is (page-render.js pageParagraphs) but not what it says, since
// its glyphs are numbered rather than characters. Tesseract reads the lines
// and their words; each line goes into the paragraph that covers it, and
// each word takes the styles (italic, bold, a highlight) of the style boxes
// it sits in.
// Loaded by the service worker with importScripts; no DOM or chrome APIs.

// Slack around a paragraph's box, in page pixels: OCR line boxes reach a
// little past the glyphs the reader placed.
const PARA_PAD = 4;

// The words of each paragraph in `paras` (each with `boxes` and optionally
// `styleBoxes`, in the same pixels as the lines), from OCR `lines` ({ x0,
// y0, x1, y1, text, confidence, words? }). A line goes to the paragraph
// whose box covers most of it, more than half; lines no paragraph covers
// are dropped (specks, the edge of an illustration). Each paragraph's words
// come box by box, top to bottom, left to right: { text, x0, y0, x1, y1,
// styles }. A word broken across lines by a hyphen is joined.
function assignWords(lines, paras) {
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
  return items.map((list, i) => {
    const sorted = list.sort((a, b) => a.box - b.box || a.line.y0 - b.line.y0);
    const words = [];
    for (const { line } of sorted) {
      const lineWords = wordsOf(line).map((w) => ({ ...w, styles: stylesAt(w, paras[i].styleBoxes || []) }));
      const prev = words.at(-1);
      // "disco-" + "theque": one word again.
      if (prev && lineWords.length && /[a-z]-$/.test(prev.text) && /^[a-z]/.test(lineWords[0].text)) {
        prev.text = prev.text.slice(0, -1) + lineWords.shift().text;
      }
      words.push(...lineWords);
    }
    return words;
  });
}

// The text of a paragraph's words, without styles.
function wordsText(words) {
  return words.map((w) => w.text).join(" ");
}

// A line's words with their boxes: Tesseract's, or, when it gave none, the
// line's text split at spaces and spread over the line by length.
function wordsOf(line) {
  const given = (line.words || []).filter((w) => (w.text || "").trim());
  if (given.length) return given.map((w) => ({ text: w.text.trim(), x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
  const parts = (line.text || "").trim().split(/\s+/).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length + 1, -1) || 1;
  let at = 0;
  return parts.map((text) => {
    const x0 = line.x0 + ((line.x1 - line.x0) * at) / total;
    at += text.length;
    const x1 = line.x0 + ((line.x1 - line.x0) * at) / total;
    at += 1;
    return { text, x0, y0: line.y0, x1, y1: line.y1 };
  });
}

// The styles of the style boxes a word's centre falls in.
function stylesAt(word, styleBoxes) {
  const cx = (word.x0 + word.x1) / 2;
  const cy = (word.y0 + word.y1) / 2;
  const styles = new Set();
  for (const b of styleBoxes) {
    if (cx >= b.x0 - 2 && cx <= b.x1 + 2 && cy >= b.y0 - 2 && cy <= b.y1 + 2) for (const s of b.styles) styles.add(s);
  }
  return [...styles];
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

function overlapArea(a, b) {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
}

function area(r) {
  return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
}

if (typeof module !== "undefined") module.exports = { PARA_PAD, assignWords, wordsText, wordsOf, stylesAt, isText };
