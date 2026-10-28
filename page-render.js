// Kindle Cloud Reader's own page data, read instead of screenshots. The reader
// fetches pages from /renderer/render as a TAR of JSON: per screen, the text
// runs (glyph ids, positions, font, colour, position ids) and illustrations,
// plus the glyph outlines. It draws each screen from that data itself, so the
// same data drawn here gives the very same pixels (illustrations aside, which
// come from elsewhere). That tells which screen the reader shows, gives OCR a
// clean page, and says which runs form a paragraph. See
// docs/page-pipeline-v2.md.
// Loaded by the content script and the Node tests; no chrome APIs.

const RENDER_PATH_RE = /\/renderer\/render(?:[?#]|$)/;

// The request parameters that decide how the book is laid out. The same
// position lands on a different screen under different ones, so a screen is
// only ever named together with its layout key.
const LAYOUT_PARAMS = [
  "asin",
  "revision",
  "fontFamily",
  "fontSize",
  "lineHeight",
  "dpi",
  "width",
  "height",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "maxNumberColumns",
  "theme",
  "rasterScale",
];

// A pixel differs when its R+G+B differ by more than this (anti-aliasing
// noise stays well under it); a screen matches when at most this share of
// the compared pixels differ. The right screen measured 0%, the nearest
// wrong one 7.8% or more.
const PIXEL_TOLERANCE = 30;
const SAME_SCREEN_MAX_DIFF = 0.001;

// A heading's text is this much larger than the page's body text.
const HEADING_SCALE = 1.2;

// Files of a TAR archive (ustar, with PAX headers skipped), as name → bytes.
function untar(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dec = new TextDecoder();
  const field = (o, n) => dec.decode(u8.subarray(o, o + n)).replace(/\0.*$/s, "");
  const files = new Map();
  for (let o = 0; o + 512 <= u8.length; ) {
    const name = field(o, 100);
    if (!name) break; // the zero blocks that end the archive
    const size = parseInt(field(o + 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("TAR 檔頭的大小不對");
    const type = String.fromCharCode(u8[o + 156] || 48);
    const prefix = field(o + 345, 155);
    const start = o + 512;
    if (start + size > u8.length) throw new Error("TAR 檔案被截斷");
    // "x" / "g": PAX extended headers, not files.
    if (type === "0" || type === "\0") files.set(prefix ? `${prefix}/${name}` : name, u8.subarray(start, start + size));
    o = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

// The layout parameters of a render request URL, and their key.
function layoutOf(url) {
  const q = new URL(url, "https://read.amazon.com/").searchParams;
  const params = Object.fromEntries(LAYOUT_PARAMS.map((k) => [k, q.get(k) ?? ""]));
  return { key: LAYOUT_PARAMS.map((k) => params[k]).join("|"), params };
}

// One /renderer/render response: { key, params, pages (screens), fonts
// (fontKey → { unitsPerEm, glyphs }) }. Throws when it isn't the format this
// code knows. The glyph ids in its screens refer to its own fonts only: each
// response numbers the glyphs it carries afresh.
function parseRender(bytes, url) {
  const files = untar(bytes);
  const json = (name) => JSON.parse(new TextDecoder().decode(files.get(name)));
  const names = [...files.keys()].filter((n) => /(^|\/)page_data_[^/]*\.json$/.test(n)).sort();
  if (!names.length) throw new Error("回應裡沒有 page_data");
  const pages = names.flatMap((n) => json(n));
  for (const p of pages) {
    if (!Number.isFinite(p?.startPositionId) || !(p.width > 0) || !(p.height > 0) || !Array.isArray(p.children)) {
      throw new Error("page_data 的格式不對");
    }
  }
  const glyphName = [...files.keys()].find((n) => /(^|\/)glyphs\.json$/.test(n));
  const fonts = {};
  for (const f of glyphName ? json(glyphName) : []) fonts[f.fontKey] = { unitsPerEm: f.unitsPerEm, glyphs: f.glyphs || {} };
  return { ...layoutOf(url), pages, fonts };
}

// Box of a run or an illustration in page CSS pixels: its rect is relative
// to its transform's origin (a run's baseline start).
function boxOf(item) {
  const [a, , , d, e, f] = item.transform;
  const r = item.rect;
  return { x0: e + r.left * a, y0: f + r.top * d, x1: e + r.right * a, y1: f + r.bottom * d };
}

function runsOf(page) {
  return page.children.filter((c) => c.type === "run" && Array.isArray(c.glyphs));
}

function imagesOf(page) {
  return page.children.filter((c) => c.type === "image");
}

// The page's columns as [x0, x1] in page pixels: two when the runs sit on
// both sides of the middle and none crosses it (a two-page spread).
function pageColumns(page) {
  const mid = page.width / 2;
  const boxes = runsOf(page).map(boxOf);
  const left = boxes.some((b) => b.x1 <= mid);
  const right = boxes.some((b) => b.x0 >= mid);
  const across = boxes.some((b) => b.x0 < mid && b.x1 > mid);
  return left && right && !across
    ? [
        [0, mid],
        [mid, page.width],
      ]
    : [[0, page.width]];
}

// "#rrggbbaa" (or "#rrggbb") as "#rrggbb"; `fallback` for anything else.
// The value of `key(run)` that most glyphs of `runs` have.
function mostGlyphs(runs, key) {
  const counts = new Map();
  for (const r of runs) counts.set(key(r), (counts.get(key(r)) || 0) + r.glyphs.length);
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

function cssColor(c, fallback = "#000000") {
  return typeof c === "string" && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7).toLowerCase() : fallback;
}

// Paragraphs of a screen, from the reader's own grouping: every run of one
// element (a paragraph or heading of the book's source) is one paragraph.
// Each: { id (elementId), start, end (position range on this screen), kind,
// column, boxes (one per column it spans: { x0, y0, x1, y1, lines }), fg },
// in reading order.
function pageParagraphs(page) {
  const runs = runsOf(page);
  if (!runs.length) return [];
  const cols = pageColumns(page);
  const columnOf = (b) => Math.max(0, cols.findIndex(([x0, x1]) => (b.x0 + b.x1) / 2 >= x0 && (b.x0 + b.x1) / 2 <= x1));
  // Body text size: the size most glyphs on the page are set in.
  const body = mostGlyphs(runs, (r) => r.fontSize);
  const groups = new Map();
  for (const r of runs) {
    const id = r.elementId ?? `@${r.startPositionId}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  const out = [];
  for (const [id, rs] of groups) {
    const perColumn = new Map();
    for (const r of rs) {
      const b = boxOf(r);
      const c = columnOf(b);
      const box = perColumn.get(c) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, baselines: new Set() };
      box.x0 = Math.min(box.x0, b.x0);
      box.y0 = Math.min(box.y0, b.y0);
      box.x1 = Math.max(box.x1, b.x1);
      box.y1 = Math.max(box.y1, b.y1);
      box.baselines.add(Math.round(r.transform[5]));
      perColumn.set(c, box);
    }
    const boxes = [...perColumn.keys()]
      .sort((a, b) => a - b)
      .map((c) => {
        const { baselines, ...b } = perColumn.get(c);
        return { ...b, lines: baselines.size };
      });
    const lines = boxes.reduce((n, b) => n + b.lines, 0);
    // By what most of its glyphs are set in: a drop cap (one large letter
    // starting a chapter's first paragraph) doesn't make it a heading.
    const size = mostGlyphs(rs, (r) => r.fontSize);
    const bold = mostGlyphs(rs, (r) => r.fontWeight >= 600);
    const fg = mostGlyphs(rs, (r) => r.textColor);
    out.push({
      id,
      start: Math.min(...rs.map((r) => r.startPositionId)),
      end: Math.max(...rs.map((r) => r.endPositionId)),
      kind: size >= body * HEADING_SCALE || (bold && lines <= 2 && size >= body) ? "heading" : "paragraph",
      column: Math.min(...perColumn.keys()),
      boxes,
      fg: cssColor(fg, cssColor(page.inkColor)),
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

// Draw the screen's text at `scale` × its CSS size, on its own background,
// the way the reader does: the shaded boxes behind sidebars and notes
// (backDecoration "fillStroke"), then each glyph's outline at its run's
// transform, its x position and the font size. Illustrations and link
// underlines aren't drawn (see compareMasks). `paths` caches Path2D objects
// (fontKey:glyph → Path2D) across calls. `plain` draws black on white
// whatever the theme, and no boxes, which OCR reads best.
function renderPage(page, fonts, scale, paths = new Map(), { plain = false } = {}) {
  const canvas = new OffscreenCanvas(Math.round(page.width * scale), Math.round(page.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = plain ? "#ffffff" : cssColor(page.fillColor, "#ffffff");
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!plain) {
    for (const { item, deco } of decorations(page, "fillStroke")) {
      const [a, , , d, e, f] = item.transform;
      const r = deco.rect ?? item.rect;
      ctx.setTransform(scale * a, 0, 0, scale * d, scale * e, scale * f);
      ctx.fillStyle = cssColor(deco.fillColor, "#e6e6e6");
      ctx.fillRect(r.left, r.top, r.right - r.left, r.bottom - r.top);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  for (const run of runsOf(page)) {
    const font = fonts[run.fontKey];
    if (!font) continue;
    const s = run.fontSize / font.unitsPerEm;
    const [a, b, c, d, e, f] = run.transform;
    ctx.fillStyle = plain ? "#000000" : cssColor(run.textColor, cssColor(page.inkColor));
    run.glyphs.forEach((g, i) => {
      const outline = font.glyphs[g];
      if (!outline?.path) return;
      const key = `${run.fontKey}:${g}`;
      if (!paths.has(key)) paths.set(key, new Path2D(outline.path));
      const x = run.xPosition?.[i] ?? 0;
      ctx.setTransform(scale * a * s, scale * b * s, scale * c * s, scale * d * s, scale * (e + a * x), scale * (f + b * x));
      ctx.fill(paths.get(key));
    });
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

// Illustrations as pixel rectangles at `scale`, grown by a pixel for their
// anti-aliased edges: the reader draws them, renderPage doesn't, so they're
// left out of the comparison.
function imageMasks(page, scale) {
  return imagesOf(page).map((img) => {
    const b = boxOf(img);
    return [Math.floor(b.x0 * scale) - 1, Math.floor(b.y0 * scale) - 1, Math.ceil(b.x1 * scale) + 1, Math.ceil(b.y1 * scale) + 1];
  });
}

// The decorations the reader draws behind items ({ item, deco }), of `type`
// if given: "fillStroke" (a shaded box behind a sidebar or note) or
// "linkLine" (a link's underline).
function decorations(page, type) {
  return page.children.flatMap((item) =>
    (Array.isArray(item.backDecoration) ? item.backDecoration : []).filter((d) => !type || d.type === type).map((deco) => ({ item, deco }))
  );
}

// Pixel rectangles left out when comparing a screen with the reader's image:
// the illustrations, a band along each edge of a shaded box (the reader
// rounds those edges a pixel or so differently), and link underlines (a
// pixel thick, never placed quite the same).
function compareMasks(page, scale) {
  const masks = imageMasks(page, scale);
  const band = Math.ceil(scale) + 2;
  for (const { item, deco } of decorations(page)) {
    const [a, , , d, e, f] = item.transform;
    const X = (v) => scale * (e + a * v);
    const Y = (v) => scale * (f + d * v);
    if (deco.type === "fillStroke") {
      const r = deco.rect ?? item.rect;
      const [x0, y0, x1, y1] = [X(r.left), Y(r.top), X(r.right), Y(r.bottom)];
      const edge = (ax, ay, bx, by) => masks.push([Math.floor(ax) - band, Math.floor(ay) - band, Math.ceil(bx) + band, Math.ceil(by) + band]);
      edge(x0, y0, x1, y0);
      edge(x0, y1, x1, y1);
      edge(x0, y0, x0, y1);
      edge(x1, y0, x1, y1);
    } else if (deco.type === "linkLine" && deco.strokeStartPoint && deco.strokeEndPoint) {
      const xs = [X(deco.strokeStartPoint.x), X(deco.strokeEndPoint.x)];
      const ys = [Y(deco.strokeStartPoint.y), Y(deco.strokeEndPoint.y)];
      const w = (deco.strokeWidth || 1) * scale;
      masks.push([Math.floor(Math.min(...xs)) - band, Math.floor(Math.min(...ys) - w) - band, Math.ceil(Math.max(...xs)) + band, Math.ceil(Math.max(...ys) + w) + band]);
    }
  }
  return masks;
}

// Share of the pixels outside `masks` whose colour differs between two RGBA
// arrays of the same `width`. Stops counting once the share is past
// `limit`, returning a value above it.
function pixelDiff(a, b, width, masks = [], limit = 1) {
  const height = a.length / 4 / width;
  let compared = 0;
  let differ = 0;
  const maxDiffer = limit * (width * height);
  for (let y = 0; y < height; y++) {
    // Columns masked on this row, as [x0, x1) spans.
    const spans = masks.filter(([, y0, , y1]) => y >= y0 && y < y1).map(([x0, , x1]) => [Math.max(0, x0), Math.min(width, x1)]);
    for (let x = 0; x < width; x++) {
      const skip = spans.find(([x0, x1]) => x >= x0 && x < x1);
      if (skip) {
        x = skip[1] - 1;
        continue;
      }
      const i = (y * width + x) * 4;
      compared++;
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > PIXEL_TOLERANCE) {
        if (++differ > maxDiffer) return Math.max(limit * 2, differ / (width * height));
      }
    }
  }
  return compared ? differ / compared : 0;
}

// Which of `candidates` (screens, best guesses first) the reader's image
// `shot` ({ width, height, data } RGBA) shows. `draw(page)` gives a
// candidate's RGBA at the image's size. The first match wins, so two screens
// that look the same resolve to the one listed first. Returns { page, diff,
// tried } or null.
//
// A screen that is mostly illustration leaves little to compare once the
// illustration is masked: a blank margin matches any screen there. Such a
// match is kept only if no candidate with more to compare matches too.
function identifyScreen(shot, candidates, draw, scale) {
  let tried = 0;
  let weak = null;
  for (const page of candidates) {
    if (Math.round(page.width * scale) !== shot.width || Math.round(page.height * scale) !== shot.height) continue;
    tried++;
    const diff = pixelDiff(draw(page), shot.data, shot.width, compareMasks(page, scale), SAME_SCREEN_MAX_DIFF);
    if (diff > SAME_SCREEN_MAX_DIFF) continue;
    if (maskedShare(imageMasks(page, scale), shot.width, shot.height) <= MOSTLY_MASKED) return { page, diff, tried };
    weak ??= { page, diff };
  }
  return weak && { ...weak, tried };
}

// Above this share of the screen hidden by illustrations, a match is weak.
const MOSTLY_MASKED = 0.5;

// Share of a width × height image the masks cover (overlaps counted once
// per row).
function maskedShare(masks, width, height) {
  if (!masks.length) return 0;
  let covered = 0;
  for (let y = 0; y < height; y++) {
    const spans = masks
      .filter(([, y0, , y1]) => y >= y0 && y < y1)
      .map(([x0, , x1]) => [Math.max(0, x0), Math.min(width, x1)])
      .sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const [x0, x1] of spans) {
      const from = Math.max(x0, end);
      if (x1 > from) covered += x1 - from;
      end = Math.max(end, x1);
    }
  }
  return covered / (width * height);
}

// The screen after `start` among `pages` (any order): the one with the
// smallest start position past it.
function screenAfter(pages, start) {
  let next = null;
  for (const p of pages) if (p.startPositionId > start && (!next || p.startPositionId < next.startPositionId)) next = p;
  return next;
}

// Split `text` into parts sized by `weights` (say, the lines a paragraph
// has in each column), cutting at a space or punctuation near each share.
function splitText(text, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (weights.length < 2 || !total) return [text, ...weights.slice(1).map(() => "")];
  const chars = [...text];
  const parts = [];
  let from = 0;
  let acc = 0;
  for (let i = 0; i < weights.length - 1; i++) {
    acc += weights[i];
    const target = Math.round((chars.length * acc) / total);
    // Look a few characters either way for a natural break.
    let cut = target;
    for (let d = 0; d <= 8; d++) {
      if (isBreak(chars[target + d - 1])) {
        cut = target + d;
        break;
      }
      if (target - d > from && isBreak(chars[target - d - 1])) {
        cut = target - d;
        break;
      }
    }
    cut = Math.min(chars.length, Math.max(from, cut));
    parts.push(chars.slice(from, cut).join("").trim());
    from = cut;
  }
  parts.push(chars.slice(from).join("").trim());
  return parts;
}

function isBreak(ch) {
  return ch !== undefined && /[\s，。、；：！？」』）,.;:!?)]/.test(ch);
}

if (typeof module !== "undefined") {
  module.exports = {
    RENDER_PATH_RE,
    LAYOUT_PARAMS,
    PIXEL_TOLERANCE,
    SAME_SCREEN_MAX_DIFF,
    untar,
    layoutOf,
    parseRender,
    boxOf,
    pageColumns,
    cssColor,
    pageParagraphs,
    renderPage,
    imageMasks,
    decorations,
    compareMasks,
    pixelDiff,
    maskedShare,
    identifyScreen,
    screenAfter,
    splitText,
  };
}
