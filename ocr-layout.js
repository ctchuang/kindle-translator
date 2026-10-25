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
  let rows = 0;
  for (let y = 0; y < h; y += step, rows++) {
    const row = y * w;
    for (let x = 0; x < w; x++) if (Math.abs(data[row + x] - bg) > 60) ink[x]++;
  }
  // "Blank" allows a little ink: the reader's progress slider is a thin line
  // across both pages, and with it the gutter is never perfectly empty.
  const tolerance = Math.ceil(rows * 0.03);
  // Widest blank run in the middle 40% of the width.
  let best = null;
  let start = -1;
  for (let x = Math.round(w * 0.3); x <= Math.round(w * 0.7); x++) {
    const blank = ink[x] <= tolerance && x < Math.round(w * 0.7);
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

// Group one column's OCR lines ({ x0, y0, x1, y1, text, confidence, and
// optionally maxGap / firstWord from the word boxes }) into blocks
// { kind, x0, y0, x1, y1, lines, text } in reading order. A new paragraph
// starts at a first-line indent, a larger vertical gap, a change of font size,
// or after a line that ends short of the right margin although the next
// line's first word would have fitted there. Figures are left out.
function groupParagraphs(lines) {
  lines = lines.filter(isText).sort((a, b) => a.y0 - b.y0);
  if (!lines.length) return [];
  const lineH = median(lines.map((l) => l.y1 - l.y0));
  lines = dropFigures(lines, lineH);
  if (!lines.length) return [];
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
      const resized = Math.abs(h - ph) > Math.max(h, ph) * 0.3; // heading vs body
      if (big && cur.big) {
        // A heading wrapped onto more lines: its own, larger line spacing,
        // and the first line ends wherever the title breaks.
        fresh = resized || l.y0 - prev.y1 > Math.max(h, ph);
      } else {
        fresh =
          l.y0 - prev.y0 > pitch * 1.4 || // blank line / section break
          resized ||
          l.x0 - left > lineH * 0.8 || // first-line indent
          endedShort(prev, l, Math.max(l.x1, ...cur.items.map((i) => i.x1)), right, lineH) ||
          big !== cur.big;
      }
    }
    if (fresh) {
      cur = { items: [], big };
      blocks.push(cur);
    }
    cur.items.push(l);
  }
  // Headings (chapter numbers and titles) are short lines centred in the
  // column, or several large lines; height alone misfires on a single line
  // with a drop cap.
  const isHeading = ([l]) => Math.abs((l.x0 + l.x1) / 2 - (left + right) / 2) < (right - left) * 0.05 && l.x1 - l.x0 < (right - left) * 0.6;
  return blocks.map(({ items, big }) => ({
    kind: (items.length === 1 && isHeading(items)) || (big && items.length > 1) ? "heading" : "paragraph",
    x0: Math.min(...items.map((l) => l.x0)),
    y0: Math.min(...items.map((l) => l.y0)),
    x1: Math.max(...items.map((l) => l.x1)),
    y1: Math.max(...items.map((l) => l.y1)),
    lines: items.length,
    text: joinLines(items.map((l) => l.text.trim())),
  }));
}

// `prev` ends well short of the right margin, and not just because the next
// word was too long for the rest of the line. `edge` is the paragraph's own
// right edge so far: ragged-right text (captions, sidebars) ends every line
// short of the column's margin.
function endedShort(prev, next, edge, right, lineH) {
  if (prev.x1 >= right - lineH * 2) return false;
  if (!next.firstWord) return true; // no word boxes: go by the margin alone
  return prev.x1 + lineH * 0.3 + next.firstWord <= edge;
}

// Leave out figures: their labels and side-by-side notes come back from OCR
// as lines with gaps between words far wider than any word space, and
// translating them covers the figure with jumbled text. Lines between two
// such rows, and short labels just above or below them, are part of the
// figure too.
function dropFigures(lines, lineH) {
  const rows = lines.filter((l) => l.maxGap > lineH * 2);
  // Mostly wide gaps means the columns weren't split (two pages read as one),
  // not a figure; dropping them would lose the page.
  if (!rows.length || rows.length > lines.length / 2) return lines;
  const drop = new Set(rows);
  const clusters = [];
  for (const r of rows) {
    const c = clusters[clusters.length - 1];
    if (c && r.y0 - c.y1 < lineH * 3) c.y1 = Math.max(c.y1, r.y1);
    else clusters.push({ y0: r.y0, y1: r.y1 });
  }
  const width = percentile(lines.map((l) => l.x1), 0.9) - percentile(lines.map((l) => l.x0), 0.1);
  for (const c of clusters) {
    for (let grew = true; grew; ) {
      grew = false;
      for (const l of lines) {
        if (drop.has(l)) continue;
        const mid = (l.y0 + l.y1) / 2;
        const inside = mid > c.y0 && mid < c.y1;
        const label = l.x1 - l.x0 < width * 0.4 && l.y1 > c.y0 - lineH && l.y0 < c.y1 + lineH;
        if (!inside && !label) continue;
        drop.add(l);
        c.y0 = Math.min(c.y0, l.y0);
        c.y1 = Math.max(c.y1, l.y1);
        grew = true;
      }
    }
  }
  return lines.filter((l) => !drop.has(l));
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
