// Page layout from OCR output: split a two-page spread into columns before
// OCR (Tesseract reads a narrow gutter as a word gap and merges both pages'
// lines), then join each column's lines back into paragraphs.
// Loaded by the service worker with importScripts; no DOM or chrome APIs.

// Columns of `img` ({ width, height, data } with one luminance byte per
// pixel), as [x0, x1] ranges. A two-page spread has a blank vertical band
// near the middle; otherwise the whole width is one column.
function findColumns(img) {
  const { width: w, height: h, data } = img;
  const bg = medianByte(data);
  // Ink per pixel column, skipping rows to keep it cheap.
  const ink = new Uint32Array(w);
  const step = Math.max(1, Math.round(h / 600));
  for (let y = 0; y < h; y += step) {
    const row = y * w;
    for (let x = 0; x < w; x++) if (Math.abs(data[row + x] - bg) > 60) ink[x]++;
  }
  // Widest blank run in the middle 40% of the width.
  let best = null;
  let start = -1;
  for (let x = Math.round(w * 0.3); x <= Math.round(w * 0.7); x++) {
    const blank = ink[x] === 0 && x < Math.round(w * 0.7);
    if (blank && start < 0) start = x;
    if (!blank && start >= 0) {
      if (!best || x - start > best[1] - best[0]) best = [start, x];
      start = -1;
    }
  }
  // A real gutter is wider than a word gap; ~1% of the width rules out
  // spaces and rivers in justified text.
  if (!best || best[1] - best[0] < w * 0.01) return [[0, w]];
  return [
    [0, best[0]],
    [best[1], w],
  ];
}

function medianByte(data) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 7) hist[data[i]]++;
  let half = 0;
  for (const n of hist) half += n;
  half /= 2;
  for (let v = 0, seen = 0; v < 256; v++) if ((seen += hist[v]) >= half) return v;
  return 255;
}

// Group one column's OCR lines ({ x0, y0, x1, y1, text, confidence }) into
// blocks { kind, x0, y0, x1, y1, lines, text } in reading order. A new
// paragraph starts at a first-line indent, a larger vertical gap, a change of
// font size, or after a line that ends short of the right margin.
function groupParagraphs(lines) {
  lines = lines.filter(isText).sort((a, b) => a.y0 - b.y0);
  if (!lines.length) return [];
  const heights = lines.map((l) => l.y1 - l.y0);
  const lineH = median(heights);
  const pitches = lines.slice(1).map((l, i) => l.y0 - lines[i].y0);
  const pitch = pitches.length ? median(pitches.filter((p) => p < lineH * 3)) || lineH * 1.5 : lineH * 1.5;
  const left = percentile(lines.map((l) => l.x0), 0.1);
  const right = percentile(lines.map((l) => l.x1), 0.9);

  const blocks = [];
  let cur = null;
  for (const l of lines) {
    const h = l.y1 - l.y0;
    const big = h > lineH * 1.35;
    let fresh = !cur;
    if (cur) {
      const prev = cur.items[cur.items.length - 1];
      const ph = prev.y1 - prev.y0;
      fresh =
        l.y0 - prev.y0 > pitch * 1.4 || // blank line / section break
        Math.abs(h - ph) > Math.max(h, ph) * 0.3 || // heading vs body
        l.x0 - left > lineH * 0.8 || // first-line indent
        prev.x1 < right - lineH * 2 || // previous line ended short
        big !== cur.big;
    }
    if (fresh) {
      cur = { items: [], big };
      blocks.push(cur);
    }
    cur.items.push(l);
  }
  // Headings (chapter numbers and titles) are short lines centred in the
  // column; height alone misfires on drop caps.
  const isHeading = ([l]) => Math.abs((l.x0 + l.x1) / 2 - (left + right) / 2) < (right - left) * 0.05 && l.x1 - l.x0 < (right - left) * 0.6;
  return blocks.map(({ items }) => ({
    kind: items.length === 1 && isHeading(items) ? "heading" : "paragraph",
    x0: Math.min(...items.map((l) => l.x0)),
    y0: Math.min(...items.map((l) => l.y0)),
    x1: Math.max(...items.map((l) => l.x1)),
    y1: Math.max(...items.map((l) => l.y1)),
    lines: items.length,
    text: joinLines(items.map((l) => l.text.trim())),
  }));
}

// Drop OCR noise: page-arrow glyphs, specks, a stray rule read as dashes.
function isText(l) {
  const t = l.text.trim();
  const letters = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  if (!letters) return false;
  if (l.confidence < 40) return false;
  return letters >= 2 || l.confidence >= 80;
}

// Rejoin lines, undoing end-of-line hyphenation ("disco-" + "theque").
function joinLines(parts) {
  return parts.reduce((acc, p) => {
    if (!acc) return p;
    if (/[a-z]-$/.test(acc) && /^[a-z]/.test(p)) return acc.slice(0, -1) + p;
    return `${acc} ${p}`;
  }, "");
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function percentile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

if (typeof module !== "undefined") module.exports = { findColumns, groupParagraphs };
