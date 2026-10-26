// ocr-layout.js: column splitting before OCR, and joining OCR lines back into
// paragraphs (heuristically, and with DocLayout-YOLO's regions).

const test = require("node:test");
const assert = require("node:assert/strict");
const { findColumns, groupParagraphs, groupWithLayout, layoutRegions, LAYOUT_CLASSES } = require("../ocr-layout.js");

// mulberry32: small, seedable.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- findColumns ----

const W = 1000;
const H = 600;

function image(bg) {
  return { width: W, height: H, data: new Uint8Array(W * H).fill(bg) };
}

function fillRect(img, x0, y0, x1, y1, v) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data[y * img.width + x] = v;
}

// Justified text between x0 and x1: random word widths and gaps, the last
// word stretched to the right margin, so the text block's edges are exact.
function textBlock(img, x0, x1, ink, rnd) {
  for (let y = 30; y + 10 <= H - 40; y += 16) {
    let x = x0;
    for (;;) {
      const w = 15 + Math.floor(rnd() * 60);
      if (x + w + 40 > x1) {
        fillRect(img, x, y, x1, y + 10, ink);
        break;
      }
      fillRect(img, x, y, x + w, y + 10, ink);
      x += w + 5 + Math.floor(rnd() * 4);
    }
  }
}

function page({ bg = 245, ink = 30, blocks, seed = 1 }) {
  const img = image(bg);
  const rnd = prng(seed);
  for (const [x0, x1] of blocks) textBlock(img, x0, x1, ink, rnd);
  return img;
}

test("findColumns: a single page is one column", () => {
  assert.deepEqual(findColumns(page({ blocks: [[60, 940]] })), [[0, W]]);
  assert.deepEqual(findColumns(page({ blocks: [[60, 940]], seed: 2 })), [[0, W]]);
});

test("findColumns: a blank page is one column", () => {
  assert.deepEqual(findColumns(image(245)), [[0, W]]);
});

test("findColumns: a spread with one blank page is one column", () => {
  assert.deepEqual(findColumns(page({ blocks: [[40, 470]] })), [[0, W]]);
  assert.deepEqual(findColumns(page({ blocks: [[530, 960]] })), [[0, W]]);
});

test("findColumns: a gutter wider than the middle 40% still splits", () => {
  assert.deepEqual(findColumns(page({ blocks: [[40, 250], [750, 960]] })), [
    [0, 300],
    [700, W],
  ]);
});

test("findColumns: a two-page spread splits at the blank gutter", () => {
  const img = page({ blocks: [[40, 470], [530, 960]] });
  assert.deepEqual(findColumns(img), [
    [0, 470],
    [470 + 60, W],
  ]);
});

test("findColumns: a thin progress-slider line across the gutter still splits", () => {
  const img = page({ blocks: [[40, 470], [530, 960]] });
  fillRect(img, 20, H - 20, W - 20, H - 17, 120); // 3 rows of ink, under the 3% tolerance
  assert.deepEqual(findColumns(img), [
    [0, 470],
    [530, W],
  ]);
  // Something solid in the gutter (a figure spanning both pages) isn't blank.
  fillRect(img, 300, 100, 700, 140, 30);
  assert.deepEqual(findColumns(img), [[0, W]]);
});

test("findColumns: a gutter narrower than 1% of the width doesn't split", () => {
  // 8 px < 10 px: could be a river in justified text.
  assert.deepEqual(findColumns(page({ blocks: [[40, 496], [504, 960]] })), [[0, W]]);
  // 12 px does.
  assert.deepEqual(findColumns(page({ blocks: [[40, 494], [506, 960]] })), [
    [0, 494],
    [506, W],
  ]);
});

test("findColumns: a blank band outside the middle 40% isn't a gutter", () => {
  assert.deepEqual(findColumns(page({ blocks: [[40, 200], [260, 960]] })), [[0, W]]);
  assert.deepEqual(findColumns(page({ blocks: [[40, 740], [800, 960]] })), [[0, W]]);
});

test("findColumns: works for light-on-dark pages too", () => {
  const img = page({ bg: 18, ink: 220, blocks: [[40, 470], [530, 960]] });
  assert.deepEqual(findColumns(img), [
    [0, 470],
    [530, W],
  ]);
  assert.deepEqual(findColumns(page({ bg: 18, ink: 220, blocks: [[60, 940]] })), [[0, W]]);
});

// ---- groupParagraphs ----

// Body text: 20 px lines on a 30 px pitch, margins 100..900.
const LH = 20;
const PITCH = 30;
const LEFT = 100;
const RIGHT = 900;

function line(i, text, o = {}) {
  const h = o.h ?? LH;
  const y0 = o.y0 ?? 100 + i * PITCH;
  return {
    x0: o.x0 ?? LEFT,
    y0,
    x1: o.x1 ?? RIGHT,
    y1: y0 + h,
    text,
    confidence: o.confidence ?? 92,
    maxGap: o.maxGap ?? 12,
    firstWord: o.firstWord ?? 60,
  };
}

// `n` full lines starting at row `from`.
function body(from, n, word = "word") {
  return Array.from({ length: n }, (_, k) => line(from + k, `${word} ${from + k}`));
}

const texts = (blocks) => blocks.map((b) => b.text);

test("groupParagraphs: empty and all-noise input give no blocks", () => {
  assert.deepEqual(groupParagraphs([]), []);
  assert.deepEqual(groupParagraphs([line(0, "—>"), line(1, "...")]), []);
});

test("groupParagraphs: full lines form one paragraph with an aggregated box", () => {
  const lines = body(0, 4);
  lines[1].x0 = 98; // OCR boxes wobble by a pixel or two
  lines[3].x1 = 880; // last line of a paragraph can end anywhere
  const blocks = groupParagraphs(lines);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    kind: "paragraph",
    x0: 98,
    y0: 100,
    x1: 900,
    y1: 100 + 3 * PITCH + LH,
    lines: 4,
    text: "word 0 word 1 word 2 word 3",
  });
});

test("groupParagraphs: a first-line indent starts a paragraph", () => {
  const lines = [...body(0, 3, "a"), line(3, "b 3", { x0: LEFT + 40 }), ...body(4, 3, "b")];
  const blocks = groupParagraphs(lines);
  assert.deepEqual(texts(blocks), ["a 0 a 1 a 2", "b 3 b 4 b 5 b 6"]);
  // A wobble smaller than 0.8 line heights isn't an indent.
  const wobble = [...body(0, 3), line(3, "x", { x0: LEFT + 12 }), ...body(4, 2)];
  assert.equal(groupParagraphs(wobble).length, 1);
});

test("groupParagraphs: an extra vertical gap starts a paragraph", () => {
  const lines = [...body(0, 3, "a"), ...body(4, 3, "b")]; // row 3 skipped: 60 px pitch
  assert.deepEqual(texts(groupParagraphs(lines)), ["a 0 a 1 a 2", "b 4 b 5 b 6"]);
});

test("groupParagraphs: a change of font size starts a paragraph", () => {
  // A smaller footnote line (13 px vs 20) at the normal pitch.
  const lines = [...body(0, 4, "a"), line(4, "note one", { h: 13 }), line(5, "note two", { h: 13, y0: 100 + 4 * PITCH + 20 })];
  assert.deepEqual(texts(groupParagraphs(lines)), ["a 0 a 1 a 2 a 3", "note one note two"]);
});

test("groupParagraphs: a line ending short splits only when the next first word would have fitted", () => {
  const shortThen = (firstWord) => [...body(0, 2, "a"), line(2, "a 2", { x1: 600 }), line(3, "b 3", { firstWord }), ...body(4, 2, "b")];
  // 60 px word in the 300 px left on the line: the line ended on purpose.
  assert.deepEqual(texts(groupParagraphs(shortThen(60))), ["a 0 a 1 a 2", "b 3 b 4 b 5"]);
  // A 300 px word didn't fit, so the short line was just a wrap.
  assert.equal(groupParagraphs(shortThen(300)).length, 1);
  // Without word boxes, the margin alone decides.
  assert.equal(groupParagraphs(shortThen(undefined).map((l) => ({ ...l, firstWord: undefined }))).length, 2);
  // Ending within two line heights of the margin isn't short.
  const nearMargin = [...body(0, 2), line(2, "x", { x1: RIGHT - 30 }), ...body(3, 2)];
  assert.equal(groupParagraphs(nearMargin).length, 1);
});

test("groupParagraphs: a ragged-right caption stays one block", () => {
  // Every caption line ends short of the column margin, by uneven amounts,
  // and the next first word wouldn't fit within the caption's own edge.
  const caption = [610, 560, 600, 540].map((x1, k) => line(8 + k, `cap ${k}`, { x1, firstWord: 50 }));
  const lines = [...body(0, 6), ...caption];
  const blocks = groupParagraphs(lines);
  assert.deepEqual(texts(blocks).slice(-1), ["cap 0 cap 1 cap 2 cap 3"]);
  assert.equal(blocks.at(-1).lines, 4);
});

test("groupParagraphs: a centred short line is a heading", () => {
  const lines = [line(0, "Chapter 3", { x0: 400, x1: 600 }), ...body(2, 5)];
  const blocks = groupParagraphs(lines);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "heading");
  assert.equal(blocks[0].text, "Chapter 3");
  assert.equal(blocks[1].kind, "paragraph");
  // Short but left-aligned: the last line of something, not a heading.
  const leftShort = groupParagraphs([line(0, "Left", { x1: 300 }), ...body(2, 5)]);
  assert.equal(leftShort[0].kind, "paragraph");
});

test("groupParagraphs: a big heading wrapped onto two lines stays one heading block", () => {
  // 40 px title lines on a 50 px pitch; the first line ends wherever the title breaks.
  const lines = [
    line(0, "THE LONG", { h: 40, y0: 40, x0: 380, x1: 620 }),
    line(0, "WAY HOME AGAIN", { h: 40, y0: 90, x0: 300, x1: 700 }),
    ...body(3, 5),
  ];
  const blocks = groupParagraphs(lines);
  assert.equal(blocks.length, 2);
  assert.deepEqual({ kind: blocks[0].kind, lines: blocks[0].lines, text: blocks[0].text }, { kind: "heading", lines: 2, text: "THE LONG WAY HOME AGAIN" });
});

test("groupParagraphs: a full-width line with a drop cap is a paragraph, not a heading", () => {
  // The drop cap makes the first line's box much taller than the body's.
  const lines = [line(0, "Once upon a time", { h: 45, y0: 55 }), ...body(1, 5)];
  const blocks = groupParagraphs(lines);
  assert.equal(blocks[0].text, "Once upon a time");
  assert.equal(blocks[0].kind, "paragraph");
  assert.ok(blocks.every((b) => b.kind === "paragraph"));
});

test("groupParagraphs: end-of-line hyphenation is undone, but not before a capital", () => {
  const joined = groupParagraphs([line(0, "at the disco-"), line(1, "theque we"), line(2, "a well-"), line(3, "Known place  ")]);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].text, "at the discotheque we a well- Known place");
});

test("groupParagraphs: noise lines are dropped", () => {
  const lines = [
    ...body(0, 3),
    line(3, " ~ — ", {}), // no letters or digits
    line(4, "faint words", { confidence: 39 }),
    line(5, "a", { confidence: 79 }), // single char, not sure
    line(6, "I", { confidence: 85 }), // single char, sure
    line(7, "ok", { confidence: 41 }), // two letters is enough
    line(8, "12", { confidence: 60 }),
  ];
  // What survived, in order (rows 3 to 5 are gone, so "I" starts a new block
  // after the gap; the split itself isn't the point here).
  assert.deepEqual(
    groupParagraphs(lines).flatMap((b) => b.text.split(" ")),
    ["word", "0", "word", "1", "word", "2", "I", "ok", "12"]
  );
});

test("groupParagraphs: figure rows, lines between them and nearby labels are dropped", () => {
  const fig = { maxGap: 120 }; // gaps far wider than any word space (> 2 line heights)
  const lines = [
    ...body(0, 5, "a"),
    line(6, "Fig label", { x0: 300, x1: 450 }), // short label just above
    line(7, "x-axis   y-axis   z", fig),
    line(8, "middle of the figure"), // between two figure rows
    line(9, "0.5     1.0     1.5", fig),
    line(10, "Units", { x0: 400, x1: 480 }), // short label just below
    ...body(12, 5, "b"),
  ];
  const blocks = groupParagraphs(lines);
  assert.deepEqual(texts(blocks), ["a 0 a 1 a 2 a 3 a 4", "b 12 b 13 b 14 b 15 b 16"]);
});

test("groupParagraphs: mostly wide-gap rows means unsplit columns, so nothing is dropped", () => {
  // Two pages read as one: every line has the gutter as a huge "word gap".
  const lines = Array.from({ length: 6 }, (_, k) => line(k, `left ${k} right ${k}`, { maxGap: 200 }));
  lines.push(line(6, "normal"));
  const blocks = groupParagraphs(lines);
  assert.equal(
    blocks.reduce((n, b) => n + b.lines, 0),
    7
  );
});

test("groupParagraphs: blocks come out in reading order whatever the input order", () => {
  const lines = [...body(0, 3, "a"), ...body(4, 3, "b"), ...body(8, 2, "c")];
  const rnd = prng(3);
  const shuffled = lines
    .map((l) => [rnd(), l])
    .sort((x, y) => x[0] - y[0])
    .map(([, l]) => l);
  assert.deepEqual(texts(groupParagraphs(shuffled)), ["a 0 a 1 a 2", "b 4 b 5 b 6", "c 8 c 9"]);
});

// ---- groupWithLayout ----

const region = (cls, x0, y0, x1, y1, conf = 0.9) => ({ cls, conf, x0, y0, x1, y1 });
// The box around rows a..b of body text.
const rows = (cls, a, b) => region(cls, LEFT - 5, 100 + a * PITCH - 5, RIGHT + 5, 100 + b * PITCH + LH + 5);

test("groupWithLayout: one block per text region, title/abandon as headings, sorted by y0", () => {
  const lines = [line(0, "Running head", { x0: 400, x1: 600 }), line(1, "Chapter One"), ...body(2, 3, "p"), line(5, "Figure 1. A cap-"), line(6, "tion")];
  const regions = [rows("figure_caption", 5, 6), rows("plain text", 2, 4), rows("title", 1, 1), rows("abandon", 0, 0)];
  const blocks = groupWithLayout(lines, regions);
  assert.deepEqual(
    blocks.map((b) => [b.kind, b.region, b.text, b.lines]),
    [
      ["heading", "abandon", "Running head", 1],
      ["heading", "title", "Chapter One", 1],
      ["paragraph", "plain text", "p 2 p 3 p 4", 3],
      ["paragraph", "figure_caption", "Figure 1. A caption", 2],
    ]
  );
  assert.deepEqual(
    { x0: blocks[2].x0, y0: blocks[2].y0, x1: blocks[2].x1, y1: blocks[2].y1 },
    { x0: LEFT, y0: 100 + 2 * PITCH, x1: RIGHT, y1: 100 + 4 * PITCH + LH }
  );
});

test("groupWithLayout: lines in figures, tables and formulas are left out, with half a line of slack", () => {
  for (const cls of ["figure", "table", "isolate_formula"]) {
    const lines = [...body(0, 3), line(3, "label clipped by the box"), line(4, "outside")];
    // The box ends 5 px into row 3 (a 20 px line): 25% covered as given,
    // 75% with the 10 px pad.
    const keep = region(cls, 50, 100 + 3 * PITCH - 200, 950, 100 + 3 * PITCH + 5);
    const text = rows("plain text", 0, 4);
    const blocks = groupWithLayout(lines, [keep, text]);
    assert.deepEqual(texts(blocks), ["outside"], cls);
  }
  // A line mostly outside even the padded box stays: the box ends 2 px above
  // it, padded 8 px into it, 40% covered.
  const lines = [line(0, "kept line")];
  const blocks = groupWithLayout(lines, [region("figure", 0, 0, 1000, 100 - 2)]);
  assert.deepEqual(texts(blocks), ["kept line"]);
});

test("groupWithLayout: a line goes to the region covering it most", () => {
  const l = line(0, "contested");
  // A covers 500/800 of the line, B 600/800; both over half.
  const a = region("plain text", 0, 90, 600, 130);
  const b = region("figure_caption", 300, 90, 1000, 130);
  const blocks = groupWithLayout([l], [a, b]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].region, "figure_caption");
  // Under half covered doesn't count: falls back to the heuristics.
  const c = region("plain text", 0, 90, 450, 130);
  const fallback = groupWithLayout([l], [c]);
  assert.equal(fallback[0].region, undefined);
});

test("groupWithLayout: uncovered lines fall back to groupParagraphs and are merged by position", () => {
  // The last lines got cut off by the page edge, so the model missed them;
  // the first lines are above the only region.
  const lines = [...body(0, 2, "top"), ...body(3, 3, "mid"), ...body(7, 2, "end")];
  const blocks = groupWithLayout(lines, [rows("plain text", 3, 5)]);
  assert.deepEqual(
    blocks.map((b) => [b.text, b.region]),
    [
      ["top 0 top 1", undefined],
      ["mid 3 mid 4 mid 5", "plain text"],
      ["end 7 end 8", undefined],
    ]
  );
  // No regions at all: same as groupParagraphs.
  assert.deepEqual(groupWithLayout(lines, []), groupParagraphs(lines));
});

test("groupWithLayout: noise is filtered first; nothing left gives []", () => {
  assert.deepEqual(groupWithLayout([line(0, "—", {}), line(1, "zz", { confidence: 10 })], [rows("plain text", 0, 1)]), []);
  const blocks = groupWithLayout([line(0, "real text"), line(1, "»", {})], [rows("plain text", 0, 1)]);
  assert.deepEqual(texts(blocks), ["real text"]);
});

// ---- layoutRegions ----

const flat = (rowsArr) => Float32Array.from(rowsArr.flat());
const id = (x, y) => [x, y];

test("layoutRegions: confidence under 0.25 is dropped", () => {
  const data = flat([
    [0, 0, 10, 10, 0.25, 1],
    [20, 0, 30, 10, 0.24, 1],
    [40, 0, 50, 10, 0.9, 1],
  ]);
  const found = layoutRegions(data, 3, id);
  assert.deepEqual(
    found.map((r) => r.x0),
    [40, 0]
  );
});

test("layoutRegions: classes map to names, unknown indexes to their number as a string", () => {
  const data = flat([
    [0, 0, 10, 10, 0.9, 0],
    [100, 0, 110, 10, 0.8, 9],
    [200, 0, 210, 10, 0.7, 12],
  ]);
  assert.deepEqual(
    layoutRegions(data, 3, id).map((r) => r.cls),
    ["title", "formula_caption", "12"]
  );
  assert.equal(LAYOUT_CLASSES.length, 10);
});

test("layoutRegions: boxes are mapped to image pixels with toImage", () => {
  const data = flat([[10, 20, 30, 40, 0.5, 3]]);
  const [r] = layoutRegions(data, 1, (x, y) => [x * 2 + 100, y * 3]);
  assert.deepEqual({ ...r }, { cls: "figure", conf: 0.5, x0: 120, y0: 60, x1: 160, y1: 120 });
});

test("layoutRegions: only `rows` rows are read", () => {
  const data = flat([
    [0, 0, 10, 10, 0.9, 1],
    [50, 50, 60, 60, 0.9, 1],
  ]);
  assert.equal(layoutRegions(data, 1, id).length, 1);
});

test("layoutRegions: near-duplicates (IoU > 0.6) keep the more confident box", () => {
  const data = flat([
    [0, 0, 100, 100, 0.5, 1], // plain text
    [0, 0, 100, 90, 0.75, 3], // figure, IoU 0.9 with the above
    [0, 0, 100, 50, 0.375, 4], // IoU 0.5 / 0.56 with the others: kept
    [500, 500, 600, 600, 0.25, 0],
  ]);
  const found = layoutRegions(data, 4, id);
  assert.deepEqual(
    found.map((r) => [r.cls, r.conf]),
    [
      ["figure", 0.75],
      ["figure_caption", 0.375],
      ["title", 0.25],
    ]
  );
});

test("layoutRegions: empty output", () => {
  assert.deepEqual(layoutRegions(new Float32Array(0), 0, id), []);
});
