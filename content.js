// Kindle Cloud Reader page script (top frame). Three jobs:
// - Keep the page data the reader fetches, which page-hook.js copies over
//   (see page-render.js and docs/page-pipeline-v2.md).
// - Notice when the reader shows another screen (its page image changes),
//   work out which screen it is by drawing candidates from that data and
//   comparing pixels, and tell the background ("pageShown").
// - Draw the translation overlay: one box per paragraph (per column it
//   spans), placed over the reader's page image.

// Guard against double injection (manifest + background retry injection).
if (window.__kindleTranslatorLoaded) throw new Error("already loaded");
window.__kindleTranslatorLoaded = true;

const RENDER_MSG = "kindle-translator-render";
const DEV_CAPTURE = "kindle-translator-dev-capture";
const PAGE_IMG = ".kg-full-page-img img";
// The reader's highlights: one element per word (and space) over the page
// image, its class naming the highlight's position range ("24751/24817").
const HIGHLIGHT = ".kg-client-highlight";
// Italic translations: Chinese fonts rarely have italics, and Chinese books
// set such words in a kai face instead.
const KAI = '"BiauKai","Kaiti TC","STKaiti","KaiTi","Noto Serif TC",serif';
// Layouts (font size, theme, window size…) kept at once, and screens per
// layout: changing a setting starts a new layout, and the reader keeps a
// dozen screens or so around the one it shows.
const MAX_LAYOUTS = 2;
const MAX_SCREENS = 40;
// The next screen starts right after this one ends; a bigger jump means the
// batch with the screen in between hasn't arrived.
const MAX_SCREEN_GAP = 5;

// ---- Page data ----

// key → { key, params, pages: Map(start → screen) }
const layouts = new Map();

// Each screen's fonts: { fonts, paths (Path2D cache) } of the batch it came
// in. Glyph ids are only good within one response: each batch numbers the
// glyphs it carries afresh, so fonts must never be merged across batches.
const fontsOf = new WeakMap();

function addBatch(url, buf) {
  let batch;
  try {
    batch = parseRender(new Uint8Array(buf), url);
  } catch (err) {
    pageLog(`閱讀器的頁面資料看不懂：${err.message}`);
    return;
  }
  // Asking for pages before the book's start comes back empty.
  if (!batch.pages.length) return;
  const layout = layouts.get(batch.key) ?? { key: batch.key, params: batch.params, pages: new Map() };
  layouts.delete(batch.key); // re-added last: newest layout last
  layouts.set(batch.key, layout);
  const fonts = { fonts: batch.fonts, paths: new Map() };
  for (const p of batch.pages) {
    layout.pages.set(p.startPositionId, p);
    fontsOf.set(p, fonts);
  }
  // Keep the screens nearest the one shown (or the newest), the layouts used last.
  const near = shown?.key === layout.key ? shown.start : batch.pages[0].startPositionId;
  if (layout.pages.size > MAX_SCREENS) {
    const far = [...layout.pages.keys()].sort((a, b) => Math.abs(b - near) - Math.abs(a - near));
    for (const k of far.slice(0, layout.pages.size - MAX_SCREENS)) layout.pages.delete(k);
  }
  for (const key of [...layouts.keys()]) {
    if (layouts.size <= MAX_LAYOUTS) break;
    if (key !== shown?.key && key !== layout.key) layouts.delete(key);
  }
  pageLog(`收到閱讀器的頁面資料：${batch.pages.length} 個畫面（${Math.round(buf.byteLength / 1024)} KB）`);
  // A screen that couldn't be found may be in this batch.
  if (!shown && failed) identify();
}

// ---- Which screen the reader shows ----

let shown = null; // { key, start, end, asin, revision, width, height, fill, ink }
let shownSrc = null; // the page image it was identified from
let lastStart = null; // the previous screen: candidates are tried nearest first
let failed = null; // why the screen couldn't be identified
let identifying = Promise.resolve();
let latest = 0; // the newest identification; older ones give way

function pageImage() {
  return document.querySelector(PAGE_IMG);
}

// Every page turn (and every re-render after a settings change) gives the
// page image a new blob URL. The overlay goes at once, before the new screen
// paints: it belongs to the screen that's gone.
function checkImage() {
  const img = pageImage();
  const src = img?.src || null;
  if (src === shownSrc) return;
  shownSrc = src;
  if (shown) lastStart = shown.start;
  shown = null;
  clearOverlay();
  if (src) identify();
}

// Resolves the wait of the identification under way when a newer one starts:
// its image may have been replaced and never fire "load".
let giveWay = () => {};

function identify() {
  giveWay();
  const mine = ++latest;
  const superseded = new Promise((resolve) => (giveWay = resolve));
  identifying = (async () => {
    const img = pageImage();
    if (!img) return;
    try {
      await Promise.race([loaded(img), superseded]);
      if (mine !== latest) return;
      const found = await findScreen(img);
      if (mine !== latest) return;
      if (found.miss) {
        failed = layouts.size ? "閱讀器的頁面資料裡找不到目前這一頁" : "還沒收到閱讀器的頁面資料，請重新整理 Kindle 分頁";
        if (layouts.size) pageLog(found.miss);
        report({ error: failed });
        return;
      }
      shown = screenInfo(found.layout, found.page);
      shown.highlights = readHighlights(shown);
      failed = null;
      report({ page: shown, tried: found.tried, ms: found.ms });
    } catch (err) {
      if (mine !== latest) return;
      failed = `辨識目前這一頁失敗：${err.message}`;
      report({ error: failed });
    }
  })();
  return identifying;
}

function loaded(img) {
  if (img.complete && img.naturalWidth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", () => reject(new Error("書頁圖片載入失敗")), { once: true });
  });
}

// Compare the reader's image with the screens of each layout, newest layout
// first, nearest the previous screen first.
async function findScreen(img) {
  const started = performance.now();
  const bitmap = await createImageBitmap(img);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const shot = { width: bitmap.width, height: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
  let tried = 0;
  for (const layout of [...layouts.values()].reverse()) {
    const scale = scaleOf(layout);
    // Readers mostly turn forward: after the screen itself, the ones after
    // it before the ones as far before it.
    const near = lastStart ?? 0;
    const distance = (p) => (p.startPositionId >= near ? p.startPositionId - near : (near - p.startPositionId) * 1.5);
    const candidates = [...layout.pages.values()].sort((a, b) => distance(a) - distance(b));
    const hit = identifyScreen(shot, candidates, (p) => pixelsOf(layout, p, scale), scale);
    if (hit) return { layout, page: hit.page, tried: tried + hit.tried, ms: Math.round(performance.now() - started) };
    // Only those of the image's size were drawn and compared.
    tried += candidates.filter((p) => Math.round(p.width * scale) === shot.width && Math.round(p.height * scale) === shot.height).length;
  }
  return { miss: missReport(shot) };
}

const MISS_DIFF_LIMIT = 0.05;

// Why no screen matched, for the log: the image's size against each layout's
// screens, and how far off the closest three of the right size were.
function missReport(shot) {
  const parts = [...layouts.values()].reverse().map((layout, i) => {
    const scale = scaleOf(layout);
    const pages = [...layout.pages.values()];
    const starts = pages.map((p) => p.startPositionId);
    const sizes = [...new Set(pages.map((p) => `${Math.round(p.width * scale)}×${Math.round(p.height * scale)}`))];
    const fits = pages.filter((p) => Math.round(p.width * scale) === shot.width && Math.round(p.height * scale) === shot.height);
    let text = `版面 ${i + 1}（rasterScale ${scale}，${pages.length} 個畫面，位置 ${Math.min(...starts)}–${Math.max(...starts)}，畫出來 ${sizes.join("、")}）尺寸相符 ${fits.length} 個`;
    if (fits.length) {
      // Past 5% it's plainly another screen: stop counting there.
      const closest = fits
        .map((p) => ({ start: p.startPositionId, diff: pixelDiff(pixelsOf(layout, p, scale), shot.data, shot.width, compareMasks(p, scale), MISS_DIFF_LIMIT) }))
        .sort((a, b) => a.diff - b.diff)
        .slice(0, 3);
      text += `，最接近的：${closest.map((c) => `位置 ${c.start} 差 ${c.diff > MISS_DIFF_LIMIT ? `>${MISS_DIFF_LIMIT * 100}` : (c.diff * 100).toFixed(2)}%`).join("、")}`;
    }
    return text;
  });
  return `辨識不到：書頁圖片 ${shot.width}×${shot.height}（devicePixelRatio ${globalThis.devicePixelRatio ?? "?"}），上一頁位置 ${lastStart ?? "無"}；${parts.join("；")}`;
}

function scaleOf(layout) {
  return Number(layout.params.rasterScale) || 2;
}

function draw(page, scale, options) {
  const { fonts, paths } = fontsOf.get(page);
  return renderPage(page, fonts, scale, paths, options);
}

function pixelsOf(layout, page, scale) {
  const canvas = draw(page, scale);
  return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
}

function screenInfo(layout, page) {
  return {
    key: layout.key,
    start: page.startPositionId,
    end: page.endPositionId,
    asin: layout.params.asin,
    revision: layout.params.revision,
    width: page.width,
    height: page.height,
    fill: cssColor(page.fillColor, "#ffffff"),
    ink: cssColor(page.inkColor, "#000000"),
  };
}

// The highlights on show, in page pixels: [{ start, end, color, boxes }], the
// colour as the reader paints it.
function readHighlights(page) {
  const img = pageImage();
  if (!img || !page) return [];
  const r = img.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return [];
  const sx = page.width / r.width;
  const sy = page.height / r.height;
  const found = new Map();
  for (const el of document.querySelectorAll(HIGHLIGHT)) {
    const range = String(el.className).split(/\s+/).map((c) => /^(\d+)\/(\d+)$/.exec(c)).find(Boolean);
    if (!range) continue;
    const color = getComputedStyle(el).backgroundColor || "";
    const key = `${range[1]}/${range[2]}|${color}`;
    if (!found.has(key)) found.set(key, { start: Number(range[1]), end: Number(range[2]), color, boxes: [] });
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) {
      found.get(key).boxes.push({ x0: (b.left - r.left) * sx, y0: (b.top - r.top) * sy, x1: (b.right - r.left) * sx, y1: (b.bottom - r.top) * sy });
    }
  }
  return [...found.values()].filter((h) => h.boxes.length);
}

function highlightsKey(list) {
  return JSON.stringify((list || []).map((h) => [h.start, h.end, h.color]).sort());
}

// The reader draws highlights after the page, and the user adds and removes
// them: report the screen again when they change, so the translation follows.
// Adding one, the reader removes every highlight and draws them all again, so
// wait for them to settle rather than report "none" in between.
const HIGHLIGHT_SETTLE_MS = 300;
let highlightTimer = null;

function scheduleHighlightCheck() {
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(checkHighlights, HIGHLIGHT_SETTLE_MS);
}

function checkHighlights() {
  if (!shown) return;
  const now = readHighlights(shown);
  if (highlightsKey(now) === highlightsKey(shown.highlights)) return;
  shown = { ...shown, highlights: now };
  report({ page: shown, highlights: true });
}

function report(msg) {
  // Reloading the extension leaves this script running but cut off.
  if (!chrome.runtime?.id) return;
  chrome.runtime.sendMessage({ type: "pageShown", ...msg }).catch(() => {});
}

// A line for the side panel's log.
function pageLog(text) {
  if (!chrome.runtime?.id) return;
  chrome.runtime.sendMessage({ type: "pageLog", text }).catch(() => {});
}

// The screen on show, once any identification under way (even one that
// started while waiting) is done.
async function currentPage() {
  let waited;
  do {
    waited = identifying;
    await waited;
  } while (waited !== identifying);
  return shown ? { page: shown } : { error: failed || "還不知道目前是哪一頁" };
}

// What the background needs to translate a screen: where its paragraphs
// are, and (`image`) the screen drawn for OCR. `next` asks for the screen
// after `start` instead.
async function pageData({ key, start, next, image }) {
  const layout = layouts.get(key);
  if (!layout) return { error: "這個版面的頁面資料已經不在了" };
  let page = layout.pages.get(start);
  if (next) {
    const after = page && screenAfter([...layout.pages.values()], start);
    page = after && after.startPositionId - page.endPositionId <= MAX_SCREEN_GAP ? after : null;
  }
  if (!page) return { error: next ? "頁面資料裡還沒有下一頁" : "頁面資料裡沒有這一頁" };
  const out = { page: screenInfo(layout, page), paragraphs: pageParagraphs(page), columns: pageColumns(page) };
  if (image) {
    const scale = scaleOf(layout);
    // Black on white whatever the theme: Tesseract reads light-on-dark text worse.
    const blob = await draw(page, scale, { plain: true }).convertToBlob({ type: "image/png" });
    out.image = `data:image/png;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
    out.scale = scale;
  }
  return out;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Development aid: the shown screen's page data (with just the glyphs it
// uses), to debug or test with on this computer. It holds the book's font
// outlines, so it never goes into the repo.
function dumpPage() {
  if (!shown) return { error: failed || "還不知道目前是哪一頁" };
  const layout = layouts.get(shown.key);
  const page = layout?.pages.get(shown.start);
  if (!page) return { error: "頁面資料裡沒有這一頁" };
  const fonts = {};
  const own = fontsOf.get(page).fonts;
  for (const run of page.children.filter((c) => c.type === "run")) {
    const font = own[run.fontKey];
    if (!font) continue;
    const f = (fonts[run.fontKey] ??= { unitsPerEm: font.unitsPerEm, glyphs: {} });
    for (const g of run.glyphs || []) if (font.glyphs[g]) f.glyphs[g] = font.glyphs[g];
  }
  return { filename: `kindle-${shown.asin || "book"}-${shown.start}.json`, data: { params: layout.params, page, fonts } };
}

// ---- Overlay ----

let root = null;
let enabled = true; // the side panel's translation / original switch
let lastOverlay = null; // the overlay message drawn, redrawn when the window resizes

function isOverlayNode(node) {
  return (root !== null && (node === root || root.contains(node))) || isToggle(node);
}

// ---- Floating translation / original button ----

// It sits in the bottom-right corner, outside the book page, so it never
// covers text.
let toggle = null;

function isToggle(node) {
  return toggle !== null && toggle.contains(node);
}

function ensureToggle() {
  if (toggle) return toggle;
  // Reloading the extension orphans the old script but leaves its button,
  // stuck on one label, under the new one.
  document.getElementById("kindle-translator-toggle")?.remove();
  toggle = document.createElement("button");
  toggle.id = "kindle-translator-toggle";
  Object.assign(toggle.style, {
    position: "fixed",
    right: "16px",
    bottom: "8px",
    zIndex: "2147483647",
    padding: "6px 16px",
    border: "1px solid rgba(128,128,128,.6)",
    borderRadius: "999px",
    background: "rgba(128,128,128,.22)",
    color: "inherit",
    font: '600 15px/1.2 "PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif',
    cursor: "pointer",
    opacity: "0.75",
  });
  toggle.onmouseenter = () => (toggle.style.opacity = "1");
  toggle.onmouseleave = () => (toggle.style.opacity = "0.75");
  toggle.onclick = (e) => {
    e.stopPropagation();
    try {
      chrome.storage.sync.set({ overlay: !enabled });
    } catch (_) {
      // Extension was reloaded; this content script is orphaned.
    }
  };
  document.documentElement.append(toggle);
  return toggle;
}

function showToggle() {
  const t = ensureToggle();
  t.textContent = enabled ? "顯示原文" : "顯示譯文";
  t.title = enabled ? "暫時隱藏譯文（Kindle 翻譯）" : "把譯文蓋回書頁上（Kindle 翻譯）";
}

function ensureRoot() {
  if (root) return root;
  document.getElementById("kindle-translator-overlay")?.remove(); // left by a script orphaned by a reload
  root = document.createElement("div");
  root.id = "kindle-translator-overlay";
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none", // clicks still reach the reader (page turns, menus)
  });
  if (!enabled) root.style.display = "none";
  document.documentElement.append(root);
  return root;
}

function clearOverlay() {
  root?.replaceChildren();
  lastOverlay = null;
}

// Turning the switch to "original" only hides the overlay, so switching back
// shows the same page's translation instantly.
function applyEnabled() {
  if (root) root.style.display = enabled ? "" : "none";
  showToggle();
}

// The overlay message's paragraphs (boxes in page pixels) as boxes in
// viewport pixels, over where the reader draws the page image now. A
// paragraph that runs from one column into the next gets one box per column,
// its text split between them by their line counts.
function overlayBoxes(msg) {
  const img = pageImage();
  if (!img) return null;
  const r = img.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return null;
  const sx = r.width / msg.size.width;
  const sy = r.height / msg.size.height;
  const out = [];
  for (const b of msg.blocks) {
    const parts = splitMarked(b.text, b.boxes.map((x) => x.lines || 1));
    b.boxes.forEach((box, i) => {
      if (!parts[i]?.length) return;
      out.push({
        kind: b.kind,
        segments: parts[i],
        marks: b.marks || {},
        lines: box.lines || 1,
        bg: msg.bg,
        fg: b.fg,
        rect: { x0: r.left + box.x0 * sx, y0: r.top + box.y0 * sy, x1: r.left + box.x1 * sx, y1: r.top + box.y1 * sy },
      });
    });
  }
  return out;
}

// Just above the page image and below the reader's own toolbar and menus
// (its settings panel slides over the page): one level above the page
// image's outermost positioned ancestor with a z-index, which is how the
// reader stacks the page under its app (the page at -3, the app at 0). The
// very top when the page image has no such ancestor.
function overlayZ() {
  let z = null;
  for (let el = pageImage(); el && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.position !== "static" && cs.zIndex !== "auto" && Number.isFinite(Number(cs.zIndex))) z = Number(cs.zIndex);
  }
  return z === null ? "2147483647" : String(z + 1);
}

function drawOverlay(msg) {
  const boxes = overlayBoxes(msg);
  if (!boxes) return "看不到書頁圖片";
  if (!boxes.length) return "這一頁沒有可以畫的譯文";
  ensureRoot().style.zIndex = overlayZ();
  showOverlay(boxes);
  lastOverlay = msg;
  return null;
}

function showOverlay(blocks) {
  const el = ensureRoot();
  el.replaceChildren();
  const pad = 3; // cover anti-aliased edges of the original glyphs
  const rects = blocks.map((b) => b.rect);
  const body = blocks.map((b, i) => ({ b, r: rects[i] })).filter(({ b }) => b.kind !== "heading");
  // Height of one line of the original text, from the paragraphs' own line counts.
  const perLine = body.map(({ b, r }) => (r.y1 - r.y0) / b.lines).sort((a, c) => a - c);
  const lineHeight = perLine.length ? perLine[perLine.length >> 1] : Math.min(...rects.map((r) => r.y1 - r.y0));
  const boxes = [];
  blocks.forEach((b, i) => {
    const r = rects[i];
    // Single lines (dialogue, short quotes) get a tighter line-height and more
    // width; with the paragraph line-height of 1.5 they shrank.
    const single = b.kind !== "heading" && b.lines === 1;
    // The boxes hug the glyphs, which leaves no room for a full line. Grow
    // each box into the blank space between it and its neighbours in the same
    // column: halfway to them, at most half a line, and not at all past the
    // first/last block (title bar, progress bar).
    const { above, below } = verticalRoom(rects, i, lineHeight / 2);
    const top = r.y0 - above;
    const height = r.y1 - r.y0 + above + below;
    // A short line ('I'm OK.') gives a box too narrow for its translation.
    // The rest of that line is blank, so let it run to the column's edge.
    const right = single ? columnRight(rects, i) : r.x1;
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "absolute",
      left: `${r.x0 - pad}px`,
      top: `${top - pad}px`,
      width: `${right - r.x0 + pad * 2}px`,
      height: `${height + pad * 2}px`,
      padding: `${pad}px`,
      boxSizing: "border-box",
      overflow: "hidden",
      background: b.bg,
      color: b.fg,
      fontFamily: '"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif',
      fontWeight: b.kind === "heading" ? "700" : "400",
      lineHeight: single ? "1.2" : "1.5",
      textAlign: "justify",
      whiteSpace: "pre-wrap",
      // Keep a single line on one line, at the original line's position;
      // if it doesn't fit, fitText shrinks it instead of wrapping.
      ...(single && { display: "flex", alignItems: "center", textAlign: "left", whiteSpace: "pre" }),
    });
    appendSegments(box, b.segments, b.marks);
    el.append(box);
    boxes.push({ box, kind: b.kind, single, fit: fitText(box) });
  });
  // Use one body-text size for the page so it reads like a book: the median
  // fit of the paragraphs, but never larger than what a box can hold. Short
  // blocks (a line cut off at the page edge) would otherwise get huge or tiny.
  // Single lines don't vote, or a dialogue-heavy page shrinks everything.
  const bodyBoxes = boxes.filter((b) => b.kind !== "heading");
  const voters = bodyBoxes.some((b) => !b.single) ? bodyBoxes.filter((b) => !b.single) : bodyBoxes;
  if (!voters.length) return;
  const fits = voters.map((b) => b.fit).sort((a, b) => a - b);
  const median = fits[fits.length >> 1];
  for (const b of bodyBoxes) b.box.style.fontSize = `${Math.min(b.fit, median)}px`;
}

// A translation's segments ({ text, styles }) as text nodes and spans:
// italics in a kai face, bold, highlights on the reader's highlight colour.
// Built from text nodes, never parsed as HTML.
function appendSegments(box, segments, marks) {
  for (const seg of segments) {
    if (!seg.styles.length) {
      box.append(seg.text);
      continue;
    }
    const span = document.createElement("span");
    for (const s of seg.styles) {
      if (s === "i") span.style.fontFamily = KAI;
      else if (s === "b") span.style.fontWeight = "700";
      else if (marks[s]) span.style.background = marks[s];
    }
    span.textContent = seg.text;
    box.append(span);
  }
}

// Blank space above and below block i: halfway to the nearest block in the
// same column (overlapping horizontally), at most `cap`; none on a side with
// no neighbour, since past the first/last block is reader UI.
function verticalRoom(rects, i, cap) {
  const r = rects[i];
  let above = null;
  let below = null;
  rects.forEach((o, j) => {
    if (j === i || o.x1 <= r.x0 || o.x0 >= r.x1) return;
    if (o.y1 <= r.y0) above = Math.min(above ?? cap, (r.y0 - o.y1) / 2);
    else if (o.y0 >= r.y1) below = Math.min(below ?? cap, (o.y0 - r.y1) / 2);
  });
  return { above: Math.max(0, above ?? 0), below: Math.max(0, below ?? 0) };
}

// Right edge of block i's column: the widest block overlapping it horizontally.
function columnRight(rects, i) {
  const r = rects[i];
  return Math.max(...rects.filter((o) => o.x1 > r.x0 && o.x0 < r.x1).map((o) => o.x1));
}

// Largest font size (binary search) at which the text fits the box.
function fitText(box) {
  let lo = 8;
  let hi = Math.max(lo, Math.min(40, box.clientHeight));
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    box.style.fontSize = `${mid}px`;
    if (box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth) hi = mid;
    else lo = mid;
  }
  box.style.fontSize = `${lo}px`;
  return lo;
}

// Where the reader draws the book, in CSS pixels, for the vision engine's
// screenshot: the page image, or the largest images on screen when the
// reader draws pages some other way. page is null when there's none.
function pageGeometry() {
  let page = null;
  const own = pageImage();
  const candidates = own ? [own] : [...document.querySelectorAll("img, canvas")];
  for (const el of candidates) {
    if (root?.contains(el)) continue;
    const r = el.getBoundingClientRect();
    // Skip icons, covers in menus and anything off screen.
    if (r.width < innerWidth * 0.15 || r.height < innerHeight * 0.3) continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
    page = page
      ? { left: Math.min(page.left, r.left), top: Math.min(page.top, r.top), right: Math.max(page.right, r.right), bottom: Math.max(page.bottom, r.bottom) }
      : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  if (page) for (const k of Object.keys(page)) page[k] = Math.round(page[k]);
  return { viewport: { width: innerWidth, height: innerHeight }, dpr: window.devicePixelRatio || 1, page };
}

if (window.top === window) {
  chrome.storage.sync.get({ overlay: true }).then((v) => {
    enabled = v.overlay;
    applyEnabled();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.overlay) return;
    enabled = changes.overlay.newValue;
    applyEnabled();
  });

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    // Page data from page-hook.js, in the page's own world.
    // (An ArrayBuffer from the page's world isn't an instance of this world's.)
    if (e.data?.type === RENDER_MSG && Object.prototype.toString.call(e.data.buf) === "[object ArrayBuffer]" && typeof e.data.url === "string") {
      let path = "";
      try {
        path = new URL(e.data.url).pathname;
      } catch (_) {}
      if (RENDER_PATH_RE.test(path)) addBatch(e.data.url, e.data.buf);
    }
    // A test tool driving this page asks for the page data (the background
    // refuses unless the options page's developer switch is on).
    if (e.data?.type === DEV_CAPTURE) {
      const { id, name } = e.data;
      const reply = (r) => window.postMessage({ type: `${DEV_CAPTURE}-result`, id, ...r }, location.origin);
      chrome.runtime.sendMessage({ type: "devCapture", name }).then(reply, (err) => reply({ ok: false, error: String(err?.message || err) }));
    }
  });

  new MutationObserver((mutations) => {
    if (mutations.every((m) => isOverlayNode(m.target))) return;
    checkImage();
    if (shown) scheduleHighlightCheck();
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });

  // The page image moves with the window; keep the boxes over it.
  window.addEventListener("resize", () => {
    if (lastOverlay) drawOverlay(lastOverlay);
  });

  // Reply once the change is on screen: the vision engine takes a screenshot
  // next, and must not catch our own translation in it. A frame callback runs
  // before the next paint; the second one runs after it. The timeout covers a
  // hidden tab, which doesn't paint at all.
  const afterPaint = (reply) => {
    let done = false;
    const send = () => done || ((done = true), reply());
    requestAnimationFrame(() => requestAnimationFrame(send));
    setTimeout(send, 500);
    return true; // keep the channel open for the async reply
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "clearOverlay":
        clearOverlay();
        return afterPaint(() => sendResponse({}));
      case "debugLog":
        console.log(`[Kindle 翻譯] ${msg.text}`);
        return;
      case "geometry":
        sendResponse(pageGeometry());
        return;
      case "overlayState":
        sendResponse({ shown: enabled && !!root?.childElementCount });
        return;
      case "currentPage":
        currentPage().then(sendResponse);
        return true;
      case "pageData":
        pageData(msg).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
        return true;
      case "dumpPage":
        sendResponse(dumpPage());
        return;
      case "overlay": {
        if (!shown || shown.key !== msg.page?.key || shown.start !== msg.page?.start) {
          sendResponse({ shown: false, stale: true, reason: "畫面已經換頁，這份譯文不畫" });
          return;
        }
        const problem = drawOverlay(msg);
        if (problem) {
          sendResponse({ shown: false, reason: problem });
          return;
        }
        return afterPaint(() => sendResponse({ shown: true }));
      }
    }
  });

  // The screen already showing when this script starts (injected into an open tab).
  checkImage();
}
