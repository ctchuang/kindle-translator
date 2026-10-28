// A synthetic book in Kindle Cloud Reader's page data format, so the tests
// never need Amazon's (its fonts can't go into the repo). The book is a list
// of paragraphs; `layout()` sets it in screens the way the reader would for
// a font size, window size and column count: every character has its own
// position id, the same in every layout, and a paragraph that doesn't fit
// runs on into the next column or screen.
//
// Glyphs are boxes whose width and height vary with the character, so
// screens with different text draw differently. In `screens` a glyph id is
// the character code; in a response (as from the reader) it's renumbered per
// response. A fake canvas
// (tests/helpers/raster.js) fills them, giving real pixels to compare.

const { layoutOf } = require("../../page-render.js");

const FONT_NORMAL = "testserifNormal";
const FONT_BOLD = "testserifBold";
const FONT_ITALIC = "testserifItalic";
const FONT_BOLD_ITALIC = "testserifBoldItalic";
const UNITS = 1000;

// Advance and height (font units) of a character's glyph.
function glyphShape(code) {
  return { advance: 380 + (code % 7) * 40, height: 480 + (code % 5) * 70 };
}

function glyphOutline(code) {
  const { advance, height } = glyphShape(code);
  // Inset a little so neighbouring glyphs don't touch.
  return { type: "path", advanceWidth: advance, path: `M20,-${height} L${advance - 20},-${height} L${advance - 20},0 L20,0 Z` };
}

// The fonts a set of runs uses, with only their glyphs (as the reader sends).
function fontsFor(runs) {
  const fonts = {};
  for (const r of runs) {
    const f = (fonts[r.fontKey] ??= { fontFamily: "testserif", fontKey: r.fontKey, unitsPerEm: UNITS, glyphs: {} });
    for (const g of r.glyphs) if (g !== 32) f.glyphs[g] = glyphOutline(g);
  }
  return Object.values(fonts);
}

// Deterministic "English" text of `words` words.
function words(seed, n) {
  const pool = "alice rabbit garden queen tea hatter cat mouse door key bottle cake tiny large curious said thought looked again little very".split(" ");
  let s = seed * 7919 + 13;
  const out = [];
  for (let i = 0; i < n; i++) {
    s = (s * 48271) % 2147483647;
    out.push(pool[s % pool.length]);
  }
  return out.join(" ");
}

// A book: paragraphs of { text, heading } or { image: true, lines } (an
// illustration taking that many lines). Strings are plain paragraphs.
function makeBook({ asin = "B0TESTBOOK", revision = "rev1", paragraphs } = {}) {
  paragraphs ??= Array.from({ length: 40 }, (_, i) => (i % 9 === 0 ? { text: `Chapter ${i / 9 + 1}`, heading: true } : `${words(i, 30 + (i % 4) * 12)}.`));
  // Position ids: every character one, two between paragraphs.
  let pos = 1000;
  const paras = paragraphs.map((p, i) => {
    const para = typeof p === "string" ? { text: p } : { ...p };
    para.elementId = 500 + i;
    para.start = pos;
    para.end = para.image ? pos : pos + para.text.length - 1;
    pos = para.end + 2;
    return para;
  });
  return { asin, revision, paras, layout: (opts) => layoutBook({ asin, revision, paras }, opts) };
}

// Set the book in screens. Returns { key, params, url(skip, numPage),
// screens (page_data objects), lineText (run start → its text),
// response(from, count) → { url, bytes } }.
function layoutBook(book, { fontSize = 10, width = 300, height = 200, columns = 2, theme = "default", margin = 10, rasterScale = 2 } = {}) {
  const fill = { default: "#ffffffff", sepia: "#e7dec7ff", dark: "#000000ff" }[theme];
  const ink = { default: "#000000ff", sepia: "#5d4232ff", dark: "#acacacff" }[theme];
  const params = {
    asin: book.asin,
    revision: book.revision,
    fontFamily: "Testserif",
    fontSize: String(fontSize),
    lineHeight: "1.4",
    dpi: "160",
    width: String(width),
    height: String(height),
    marginTop: "0",
    marginBottom: "0",
    marginLeft: String(margin),
    marginRight: String(margin),
    maxNumberColumns: String(columns),
    theme,
    rasterScale: String(rasterScale),
  };
  const url = (skip = 0, numPage = 6) =>
    `https://read.amazon.com/renderer/render?version=3.0&${new URLSearchParams({ ...params, contentType: "FullBook", locationMap: "true", packageType: "TAR", numPage: String(numPage), skipPageCount: String(skip), startingPosition: String(book.paras[0].start) })}`;
  const { key } = layoutOf(url());

  const colWidth = columns === 2 ? (width - margin * 3) / 2 : width - margin * 2;
  const colLeft = (c) => margin + c * (colWidth + margin);
  const pitch = (size) => Math.round(size * 1.4);
  const screens = [];
  const lineText = new Map();
  const lineInfo = [];
  let screen = null;
  let col = 0;
  let y = 0;
  const newScreen = () => {
    screen = { type: "page", pageIndex: screens.length, sectionId: 1, width, height, fillColor: fill, inkColor: ink, children: [], startPositionId: null, endPositionId: null };
    screens.push(screen);
    col = 0;
    y = margin;
  };
  // Room for `h` more pixels in this column, else the next column / screen.
  const room = (h) => {
    if (!screen) newScreen();
    if (y + h <= height - margin) return;
    if (col + 1 < columns) {
      col++;
      y = margin;
    } else newScreen();
  };
  const touch = (s, e) => {
    screen.startPositionId ??= s;
    screen.endPositionId = e;
  };
  for (const p of book.paras) {
    if (p.image) {
      const h = pitch(fontSize) * p.lines;
      room(h);
      screen.children.push({
        type: "image",
        transform: [1, 0, 0, 1, colLeft(col), y],
        rect: { top: 0, left: 0, bottom: h, right: colWidth },
        elementId: p.elementId,
        imageReference: `resource/rsrc${p.elementId}`,
        startPositionId: p.start,
        endPositionId: p.start,
      });
      touch(p.start, p.start);
      y += h;
      continue;
    }
    const size = p.heading ? Math.round(fontSize * 1.6) : fontSize;
    const fontKey = p.heading ? FONT_BOLD : FONT_NORMAL;
    // Break the paragraph into lines that fit the column.
    const scale = size / UNITS;
    const lines = [];
    let line = "";
    let lineStart = 0;
    let offset = 0; // of the current word in the paragraph
    for (const word of p.text.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      const w = [...candidate].reduce((s, ch) => s + glyphShape(ch.charCodeAt(0)).advance * scale, 0);
      if (line && w > colWidth) {
        lines.push({ text: line, offset: lineStart });
        line = word;
        lineStart = offset;
      } else line = candidate;
      offset += word.length + 1;
    }
    if (line) lines.push({ text: line, offset: lineStart });
    // A paragraph in a shaded box (a sidebar or note) gets a "group" with a
    // fillStroke decoration around its lines on each screen; a link's first
    // line a "textline" with a linkLine underline, as the reader sends them.
    let box = null;
    const closeBox = () => {
      if (!box) return;
      box.group.backDecoration[0].rect.bottom = box.bottom - box.group.transform[5] + 3;
      box = null;
    };
    for (const [li, l] of lines.entries()) {
      const before = screen;
      const beforeCol = col;
      room(pitch(size));
      if (box && (screen !== before || col !== beforeCol)) closeBox();
      const baseline = y + size;
      // Every glyph's x from the line's start; the line's words, and the
      // style of each (p.styles: word index in the paragraph → "i", "b" or
      // "bi"), so a line splits into one run per stretch of one style, all
      // sharing the line's origin as the reader's do.
      const chars = [...l.text];
      const xs = [];
      let x = 0;
      for (const ch of chars) {
        xs.push(+x.toFixed(4));
        x += glyphShape(ch.charCodeAt(0)).advance * scale;
      }
      const firstWord = l.offset ? p.text.slice(0, l.offset).split(" ").length - 1 : 0;
      const lineWords = [];
      let at = 0;
      for (const [k, text] of l.text.split(" ").entries()) {
        lineWords.push({ text, from: at, to: at + text.length, style: p.styles?.[firstWord + k] ?? "" });
        at += text.length + 1;
      }
      const stretches = [];
      for (const wd of lineWords) {
        const last = stretches.at(-1);
        if (last && last.style === wd.style) last.to = wd.to;
        else {
          if (last) last.to = wd.from; // the space before a new style stays with the last run
          stretches.push({ from: wd.from, to: wd.to, style: wd.style });
        }
      }
      const start = p.start + l.offset;
      const end = start + l.text.length - 1;
      for (const st of stretches) {
        const italic = st.style.includes("i");
        const boldRun = p.heading || st.style.includes("b");
        const runChars = chars.slice(st.from, st.to);
        const runEnd = st.to < chars.length ? xs[st.to] : x;
        screen.children.push({
          type: "run",
          transform: [1, 0, 0, 1, colLeft(col), baseline],
          elementId: p.elementId,
          rect: { top: -size, left: xs[st.from], bottom: size * 0.3, right: +runEnd.toFixed(4) },
          startPosition: `${p.elementId};${l.offset + st.from}`,
          endPosition: `${p.elementId};${l.offset + st.to}`,
          startPositionId: start + st.from,
          endPositionId: start + st.to - 1,
          textColor: p.color ?? ink,
          fontKey: italic ? (boldRun ? FONT_BOLD_ITALIC : FONT_ITALIC) : boldRun ? FONT_BOLD : fontKey,
          fontFamily: "testserif",
          fontSize: size,
          fontWeight: boldRun ? 700 : 400,
          fontStyle: italic ? "italic" : "normal",
          glyphs: runChars.map((ch) => ch.charCodeAt(0)),
          xPosition: xs.slice(st.from, st.to),
        });
      }
      // What OCR reads on this line: its text, box and words, in page pixels.
      const left = colLeft(col);
      const wordBox = (wd) => ({ text: wd.text, x0: left + xs[wd.from], y0: baseline - size, x1: left + (wd.to < chars.length ? xs[wd.to] : x), y1: baseline + size * 0.3 });
      lineInfo.push({ screen: screens.length - 1, start, element: p.elementId, text: l.text, x0: left, y0: baseline - size, x1: left + x, y1: baseline + size * 0.3, words: lineWords.filter((wd) => wd.text).map(wordBox) });
      if (p.box) {
        if (!box) {
          const group = {
            type: "group",
            transform: [1, 0, 0, 1, colLeft(col), y],
            elementId: p.elementId,
            rect: { top: -3, left: -3, bottom: 0, right: colWidth + 3 },
            backDecoration: [{ type: "fillStroke", rect: { top: -3, left: -3, bottom: 0, right: colWidth + 3 }, fillColor: "#e6e6e6ff", backgroundColor: "#000000ff" }],
          };
          screen.children.unshift(group);
          box = { group, bottom: y };
        }
        box.bottom = y + pitch(size);
      }
      if (p.link && li === 0) {
        screen.children.push({
          type: "textline",
          transform: [1, 0, 0, 1, colLeft(col), y],
          elementId: p.elementId,
          rect: { top: 0, left: 0, bottom: pitch(size), right: colWidth },
          backDecoration: [{ type: "linkLine", strokeStartPoint: { x: 0, y: size * 1.15 }, strokeEndPoint: { x: +x.toFixed(4), y: size * 1.15 }, strokeWidth: 1, strokeColor: "#0000ffff" }],
        });
      }
      lineText.set(start, l.text);
      touch(start, end);
      y += pitch(size);
    }
    closeBox();
  }
  const runsOf = (list) => list.flatMap((s) => s.children.filter((c) => c.type === "run"));
  // Like the reader's, each response numbers the glyphs it carries afresh,
  // in the order they first appear (offset by where the batch starts, so two
  // batches give the same id to different characters): glyph ids only mean
  // something together with that response's glyphs.json.
  const response = (from = 0, count = 6) => {
    const ids = new Map();
    const idOf = (code) => {
      if (!ids.has(code)) ids.set(code, ids.size + 1 + (from % 7));
      return ids.get(code);
    };
    const batch = structuredClone(screens.slice(from, from + count));
    for (const r of runsOf(batch)) r.glyphs = r.glyphs.map(idOf);
    const fonts = fontsFor(runsOf(screens.slice(from, from + count))).map((f) => ({
      ...f,
      glyphs: Object.fromEntries(Object.entries(f.glyphs).map(([code, outline]) => [idOf(Number(code)), outline])),
    }));
    const files = {
      "metadata.json": JSON.stringify({ bookTitle: "Test" }),
      "glyphs.json": JSON.stringify(fonts),
      [`tokens_${from}_${from + count - 1}.json`]: "[]",
      "manifest.json": "{}",
      "toc.json": "[]",
      [`page_data_${from}_${from + count - 1}.json`]: JSON.stringify(batch),
    };
    return { url: url(from, count), bytes: makeTar(files) };
  };
  // Every font and glyph the layout uses, as page-render.js keeps them.
  const fonts = Object.fromEntries(fontsFor(runsOf(screens)).map((f) => [f.fontKey, { unitsPerEm: f.unitsPerEm, glyphs: f.glyphs }]));
  // The lines of screen `index`, as OCR would read them.
  const linesOf = (index) => lineInfo.filter((l) => l.screen === index);
  return { key, params, url, screens, lineText, linesOf, response, fonts, fill: fill.slice(0, 7), ink: ink.slice(0, 7) };
}

// A ustar archive with a PAX header before every file, like the reader's.
function makeTar(files) {
  const blocks = [];
  const header = (name, size, type) => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 99), 0);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const body = (buf) => Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);
  for (const [name, content] of Object.entries(files)) {
    const pax = Buffer.from("28 mtime=1761400000.000000\n");
    blocks.push(header(`./PaxHeaders.X/${name}`, pax.length, "x"), body(pax));
    const data = Buffer.from(content);
    blocks.push(header(name, data.length, "0"), body(data));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(Buffer.concat(blocks));
}

module.exports = { makeBook, makeTar, words, glyphShape, glyphOutline, fontsFor, FONT_NORMAL, FONT_BOLD, FONT_ITALIC };
