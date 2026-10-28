// content.js in a fake Kindle page: keeping the page data page-hook.js
// passes over, noticing a new page image and telling which screen it is,
// answering the background's questions, and drawing the overlay.

const test = require("node:test");
const assert = require("node:assert/strict");
const { TIME_SCALE, plain, waitFor, source } = require("./helpers/load");
const { createChrome } = require("./helpers/chrome");
const { loadPage } = require("./helpers/dom");
const { makeBook, words } = require("./helpers/kindle");
const raster = require("./helpers/raster");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READER_HTML = '<html><body><div id="kr-renderer"><div class="kg-full-page-img"><img /></div></div></body></html>';

function setup(t, { sync = {}, innerWidth = 1000, innerHeight = 800, html = READER_HTML, globals = {}, runtimeId } = {}) {
  const chrome = createChrome({ sync, runtimeId });
  // The background: answers nothing, but records what it was sent.
  chrome._.runtimeMessageHandler = () => undefined;
  const page = loadPage(["page-render.js", "styled-text.js", "content.js"], {
    chrome,
    html,
    innerWidth,
    innerHeight,
    globals: {
      OffscreenCanvas: raster.OffscreenCanvas,
      Path2D: raster.Path2D,
      async createImageBitmap(img) {
        if (!img.__pixels) throw new Error("no pixels");
        return { ...img.__pixels };
      },
      ...globals,
    },
  });
  t.after(() => page.close());
  const sent = (type) => chrome._.runtimeMessages.filter((m) => m.type === type);
  // Send a runtime message the way the background's tabs.sendMessage does.
  const send = (msg) => {
    const replies = [];
    const [ret] = chrome.runtime.onMessage.dispatch(msg, {}, (r) => replies.push(plain(r)));
    return { ret, replies };
  };
  const ask = async (msg) => {
    const { replies } = send(msg);
    await waitFor(() => replies.length, { what: `reply to ${msg.type}` });
    return replies[0];
  };
  const img = () => page.document.querySelector(".kg-full-page-img img");
  if (img()) place(img(), [0, 0, innerWidth, innerHeight]);
  const s = { chrome, page, sent, send, ask, img, overlay: () => page.$("kindle-translator-overlay"), toggle: () => page.$("kindle-translator-toggle") };
  return s;
}

function place(el, [left, top, width, height]) {
  Object.assign(el.style, { position: "absolute", left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
}

// The page posts a /renderer/render response (as page-hook.js does).
async function deliver(s, layout, from = 0, count = 6, { url, buf } = {}) {
  const r = layout.response(from, count);
  const bytes = buf ?? r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength);
  s.page.window.postMessage({ type: "kindle-translator-render", url: url ?? r.url, buf: bytes }, "*");
  await sleep(5);
}

// The reader shows screen `index` of `layout`: a new blob URL and its pixels.
let blobs = 0;
async function show(s, layout, index, { complete = true, wait = true } = {}) {
  const img = s.img();
  const screen = layout.screens[index];
  img.src = `blob:https://read.amazon.com/${++blobs}`;
  img.__pixels = raster.readerPixels(screen, layout.fonts, Number(layout.params.rasterScale));
  img.complete = complete;
  img.naturalWidth = complete ? img.__pixels.width : 0;
  img.naturalHeight = complete ? img.__pixels.height : 0;
  const before = s.sent("pageShown").length;
  s.page.mutate([{ type: "attributes", target: img, attributeName: "src" }]);
  if (!wait) return null;
  await waitFor(() => s.sent("pageShown").length > before, { what: "pageShown" });
  return plain(s.sent("pageShown").at(-1));
}

const book = makeBook({
  paragraphs: [
    { text: "Chapter One", heading: true },
    ...Array.from({ length: 24 }, (_, i) => `${words(i, 36)}.`),
    { image: true, lines: 12 },
    ...Array.from({ length: 12 }, (_, i) => `${words(i + 40, 36)}.`),
  ],
});
const L = book.layout();

// A page showing screen 0 of L, identified.
async function ready(t, opts) {
  const s = setup(t, opts);
  await deliver(s, L, 0, 6);
  s.shown = (await show(s, L, 0)).page;
  return s;
}

function overlayMsg(shown, blocks, { size = { width: 1000, height: 800 }, bg = "#fafafa" } = {}) {
  return { type: "overlay", page: { key: shown.key, start: shown.start }, size, bg, blocks };
}

// Draws `msg` and lets the after-paint reply through.
function draw(s, msg) {
  const r = s.send(msg);
  s.page.frame();
  s.page.frame();
  return r;
}

// Paragraph boxes in page pixels; with a 1000×800 page drawn over the whole
// 1000×800 viewport they're viewport pixels too.
const BLOCKS = [
  { kind: "heading", text: "第一章", fg: "#000000", boxes: [{ x0: 100, y0: 40, x1: 900, y1: 80, lines: 1 }] },
  { kind: "paragraph", text: "他走進房間。".repeat(20), fg: "#111111", boxes: [{ x0: 100, y0: 120, x1: 900, y1: 320, lines: 5 }] },
  { kind: "paragraph", text: "她沒有回頭。".repeat(20), fg: "#111111", boxes: [{ x0: 100, y0: 360, x1: 900, y1: 560, lines: 5 }] },
  { kind: "paragraph", text: "好。", fg: "#222222", boxes: [{ x0: 100, y0: 600, x1: 300, y1: 640, lines: 1 }] },
];

// ---- Loading ----

test("the guard refuses to run a second time in the same window", (t) => {
  assert.throws(() => setup(t, { globals: { __kindleTranslatorLoaded: true } }), /already loaded/);
});

test("re-injecting into the same page doesn't add a second set of listeners", (t) => {
  const s = setup(t);
  assert.throws(() => s.page.ctx.run(source("content.js")));
  assert.equal(s.page.window._listeners.filter((l) => l.type === "message").length, 1);
  assert.equal(s.page.observers.length, 1);
});

test("the manifest loads the hook in the page's world first, then page-render.js, styled-text.js and content.js", () => {
  const manifest = JSON.parse(source("manifest.json"));
  const [hook, cs] = manifest.content_scripts;
  assert.deepEqual(hook.js, ["page-hook.js"]);
  assert.equal(hook.world, "MAIN");
  assert.equal(hook.run_at, "document_start");
  assert.deepEqual(cs.js, ["page-render.js", "styled-text.js", "content.js"]);
  assert.equal(cs.world, undefined);
  assert.equal(cs.run_at, "document_start");
  assert.ok(!cs.all_frames && !hook.all_frames, "top frame only");
});

// ---- Page data ----

test("a render response from page-hook.js is kept and logged", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6);
  assert.match(s.sent("pageLog")[0].text, /^收到閱讀器的頁面資料：6 個畫面（\d+ KB）$/);
  const layouts = s.page.ctx.run("layouts");
  assert.equal(layouts.size, 1);
  assert.equal(layouts.get(L.key).pages.size, 6);
});

test("messages that aren't the hook's copy are ignored", async (t) => {
  const s = setup(t);
  const { url, bytes } = L.response(0, 6);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  // From another window (an ad frame, say).
  s.page.fire(s.page.window, "message", { data: { type: "kindle-translator-render", url, buf }, source: {} });
  // Not a render URL, not a URL at all, not bytes, or no URL.
  for (const data of [
    { type: "kindle-translator-render", url: "https://read.amazon.com/renderer/wordCount", buf },
    { type: "kindle-translator-render", url: "not a url", buf },
    { type: "kindle-translator-render", url, buf: "text" },
    { type: "kindle-translator-render", buf },
    { type: "something-else", url, buf },
  ]) {
    s.page.window.postMessage(data, "*");
  }
  await sleep(10);
  assert.equal(s.page.ctx.run("layouts").size, 0);
  assert.equal(s.sent("pageLog").length, 0);
});

test("an empty batch (pages asked for before the book's start) is ignored", async (t) => {
  const s = setup(t);
  const { makeTar } = require("./helpers/kindle");
  const buf = makeTar({ "page_data_0_0.json": "[]", "glyphs.json": "[]" });
  await deliver(s, L, 0, 6, { buf: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
  assert.equal(s.page.ctx.run("layouts").size, 0);
  assert.equal(s.sent("pageLog").length, 0);
});

test("data it can't read is logged, not kept", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6, { buf: new Uint8Array([1, 2, 3]).buffer });
  assert.match(s.sent("pageLog")[0].text, /^閱讀器的頁面資料看不懂：/);
  assert.equal(s.page.ctx.run("layouts").size, 0);
});

test("batches of one layout are merged screen by screen", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6);
  await deliver(s, L, 6, 6);
  await deliver(s, L, 3, 6); // overlapping
  const layout = s.page.ctx.run("layouts").get(L.key);
  assert.equal(layout.pages.size, 12);
});

test("each screen is drawn with its own batch's glyphs, which are numbered per batch", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6);
  await deliver(s, L, 6, 6);
  // Screens from both batches, in either order, are identified...
  for (const i of [1, 7, 2, 9]) assert.equal((await show(s, L, i)).page.start, L.screens[i].startPositionId, `screen ${i}`);
  // ...and the drawing OCR gets after a later batch came is still right.
  await deliver(s, L, 12, 6);
  const shown = (await show(s, L, 2)).page;
  let drawn = null;
  const real = s.page.ctx.renderPage;
  s.page.ctx.renderPage = (...args) => (drawn = real(...args));
  await s.ask({ type: "pageData", key: L.key, start: shown.start, image: true });
  const { pixelDiff, imageMasks } = require("../page-render.js");
  const truth = raster.readerPixels(L.screens[2], L.fonts, 2); // black on white already
  assert.equal(pixelDiff(drawn.data, truth.data, truth.width, imageMasks(L.screens[2], 2)), 0);
});

test("a new layout is added; past two, the oldest not on screen goes", async (t) => {
  const s = setup(t);
  const big = book.layout({ fontSize: 12 });
  const dark = book.layout({ theme: "dark" });
  await deliver(s, L, 0, 6);
  await show(s, L, 0);
  await deliver(s, big, 0, 6);
  await deliver(s, dark, 0, 6);
  const keys = [...s.page.ctx.run("layouts").keys()];
  assert.deepEqual(keys, [L.key, dark.key], "the one on screen stays; the unused one goes");
});

test("past MAX_SCREENS, the screens farthest from the one shown go", async (t) => {
  const s = setup(t);
  const long = makeBook({ paragraphs: Array.from({ length: 300 }, (_, i) => `${words(i, 30)}.`) }).layout();
  assert.ok(long.screens.length > 60);
  await deliver(s, long, 20, 6);
  await show(s, long, 22);
  for (let from = 0; from < 60; from += 6) await deliver(s, long, from, 6);
  const starts = [...s.page.ctx.run("layouts").get(long.key).pages.keys()].sort((a, b) => a - b);
  assert.equal(starts.length, s.page.ctx.run("MAX_SCREENS"));
  assert.ok(starts.includes(long.screens[22].startPositionId));
  assert.ok(!starts.includes(long.screens[59].startPositionId), "the far end went");
});

// ---- Which screen ----

test("a new page image is identified and reported", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6);
  const msg = await show(s, L, 2);
  const screen = L.screens[2];
  assert.deepEqual(msg.page, {
    key: L.key,
    start: screen.startPositionId,
    end: screen.endPositionId,
    asin: "B0TESTBOOK",
    revision: "rev1",
    width: 300,
    height: 200,
    fill: "#ffffff",
    ink: "#000000",
    highlights: [],
  });
  assert.ok(msg.tried >= 1 && msg.tried <= 6);
  assert.equal(typeof msg.ms, "number");
});

test("every screen of the batch is told apart, including an illustration alone", async (t) => {
  const s = setup(t);
  const one = book.layout({ columns: 1 });
  await deliver(s, one, 0, 40);
  const only = one.screens.findIndex((sc) => sc.children.every((c) => c.type === "image"));
  assert.ok(only > 0);
  for (const i of [0, 1, only, only + 1, 3]) {
    assert.equal((await show(s, one, i)).page.start, one.screens[i].startPositionId, `screen ${i}`);
  }
});

test("the count of screens compared leaves out those of another size", async (t) => {
  const s = setup(t);
  const wide = book.layout({ width: 320 });
  await deliver(s, L, 0, 6);
  await deliver(s, wide, 0, 6); // newest layout, tried first, but no screen of this size
  const msg = await show(s, L, 1);
  assert.equal(msg.page.key, L.key);
  assert.ok(msg.tried <= 6, `tried ${msg.tried}`);
});

test("a screen with a shaded box and a link underline is identified", async (t) => {
  const s = setup(t);
  const decorated = makeBook({
    paragraphs: [...Array.from({ length: 4 }, (_, i) => `${words(i, 30)}.`), { text: `${words(9, 60)}.`, box: true }, { text: `${words(10, 30)}.`, link: true }, ...Array.from({ length: 6 }, (_, i) => `${words(i + 20, 30)}.`)],
  }).layout();
  const i = decorated.screens.findIndex((sc) => sc.children.some((c) => c.type === "group"));
  await deliver(s, decorated, 0, 6);
  assert.equal((await show(s, decorated, i)).page.start, decorated.screens[i].startPositionId);
});

test("candidates nearest the previous screen are tried first", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 12);
  await show(s, L, 7);
  const msg = await show(s, L, 8);
  assert.ok(msg.tried <= 2, `tried ${msg.tried}`);
});

test("the overlay goes the moment the page image changes, before identifying", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, BLOCKS));
  assert.equal(s.overlay().childElementCount, 4);
  const pending = show(s, L, 1);
  assert.equal(s.overlay().childElementCount, 0, "cleared synchronously in the observer");
  await pending;
});

test("mutations that leave the page image alone change nothing", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, BLOCKS));
  const n = s.sent("pageShown").length;
  s.page.mutate([{ type: "childList", target: s.page.document.body, addedNodes: [{}], removedNodes: [] }]);
  s.page.mutate([{ type: "attributes", target: s.img(), attributeName: "style" }]);
  await sleep(10);
  assert.equal(s.sent("pageShown").length, n);
  assert.equal(s.overlay().childElementCount, 4);
});

test("mutations inside the overlay alone aren't even looked at", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, BLOCKS));
  s.img().src = "blob:changed-behind-our-back";
  s.page.mutate([{ type: "childList", target: s.overlay(), addedNodes: [], removedNodes: [] }]);
  assert.equal(s.overlay().childElementCount, 4);
});

test("an image still loading is identified once it has loaded", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6);
  await show(s, L, 1, { complete: false, wait: false });
  await sleep(10);
  assert.equal(s.sent("pageShown").length, 0);
  const img = s.img();
  img.complete = true;
  img.naturalWidth = img.__pixels.width;
  s.page.fire(img, "load");
  await waitFor(() => s.sent("pageShown").length, { what: "pageShown" });
  assert.equal(s.sent("pageShown")[0].page.start, L.screens[1].startPositionId);
});

test("an image that fails to load is reported", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6);
  await show(s, L, 1, { complete: false, wait: false });
  s.page.fire(s.img(), "error");
  await waitFor(() => s.sent("pageShown").length, { what: "pageShown" });
  assert.equal(s.sent("pageShown")[0].error, "辨識目前這一頁失敗：書頁圖片載入失敗");
});

test("an identification overtaken by a newer page image isn't reported", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6);
  await show(s, L, 1, { complete: false, wait: false });
  await show(s, L, 2);
  // The first image's load comes late, after the second was identified.
  s.page.fire(s.img(), "load");
  await sleep(20);
  assert.deepEqual(
    s.sent("pageShown").map((m) => m.page?.start),
    [L.screens[2].startPositionId]
  );
});

test("without any page data yet, it says to reload; data arriving later fixes it", async (t) => {
  const s = setup(t);
  const msg = await show(s, L, 1);
  assert.deepEqual(msg, { type: "pageShown", error: "還沒收到閱讀器的頁面資料，請重新整理 Kindle 分頁" });
  await deliver(s, L, 0, 6);
  await waitFor(() => s.sent("pageShown").length === 2, { what: "second pageShown" });
  assert.equal(s.sent("pageShown")[1].page.start, L.screens[1].startPositionId);
});

test("a screen missing from the data is reported, and found once its batch comes", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6);
  const msg = await show(s, L, 8);
  assert.equal(msg.error, "閱讀器的頁面資料裡找不到目前這一頁");
  await deliver(s, L, 6, 6);
  await waitFor(() => s.sent("pageShown").length === 2, { what: "found" });
  assert.equal(s.sent("pageShown")[1].page.start, L.screens[8].startPositionId);
});

test("a new batch doesn't re-identify a screen already known", async (t) => {
  const s = await ready(t);
  await deliver(s, L, 6, 6);
  await sleep(10);
  assert.equal(s.sent("pageShown").length, 1);
});

test("after a settings change, the screen is found in the new layout", async (t) => {
  const s = await ready(t);
  const sepia = book.layout({ theme: "sepia" });
  await deliver(s, sepia, 0, 6);
  const msg = await show(s, sepia, 0);
  assert.equal(msg.page.key, sepia.key);
  assert.equal(msg.page.fill, "#e7dec7");
  assert.equal(msg.page.ink, "#5d4232");
});

test("a page image removed (the reader loading) reports nothing", async (t) => {
  const s = await ready(t);
  s.img().parentNode.replaceChildren();
  s.page.mutate([{ type: "childList", target: s.page.document.body, addedNodes: [], removedNodes: [{}] }]);
  await sleep(10);
  assert.equal(s.sent("pageShown").length, 1);
  assert.deepEqual(await s.ask({ type: "currentPage" }), { error: "還不知道目前是哪一頁" });
});

test("once the extension is reloaded, the orphaned script reports nothing", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6);
  delete s.chrome.runtime.id;
  await show(s, L, 1, { wait: false });
  await sleep(20);
  assert.equal(s.sent("pageShown").length, 0);
});

test("the screen already showing when the script starts is identified once data comes", async (t) => {
  const html = READER_HTML.replace("<img />", '<img src="blob:already" />');
  const s = setup(t, { html });
  const img = s.img();
  img.src = "blob:already";
  img.__pixels = raster.readerPixels(L.screens[0], L.fonts, 2);
  img.complete = true;
  img.naturalWidth = img.__pixels.width;
  // Loaded at document start, the script saw no image; this is the next check.
  s.page.mutate([{ type: "childList", target: s.page.document.body, addedNodes: [img], removedNodes: [] }]);
  await waitFor(() => s.sent("pageShown").length, { what: "first report" });
  await deliver(s, L, 0, 6);
  await waitFor(() => s.sent("pageShown").some((m) => m.page), { what: "identified" });
});

// ---- Answering the background ----

test("currentPage: the screen identified, an error before, and it waits for one in progress", async (t) => {
  const s = setup(t);
  assert.deepEqual(await s.ask({ type: "currentPage" }), { error: "還不知道目前是哪一頁" });
  await deliver(s, L, 0, 6);
  show(s, L, 3, { wait: false });
  const reply = await s.ask({ type: "currentPage" });
  assert.equal(reply.page.start, L.screens[3].startPositionId);
});

test("currentPage after a failure says why", async (t) => {
  const s = setup(t);
  await show(s, L, 1);
  assert.deepEqual(await s.ask({ type: "currentPage" }), { error: "還沒收到閱讀器的頁面資料，請重新整理 Kindle 分頁" });
});

test("pageData: the screen, its paragraphs and columns", async (t) => {
  const s = await ready(t);
  const reply = await s.ask({ type: "pageData", key: L.key, start: s.shown.start });
  const { highlights, ...screen } = s.shown;
  assert.deepEqual(reply.page, screen, "the screen, without the highlights only the one on show has");
  assert.deepEqual(reply.columns, [
    [0, 150],
    [150, 300],
  ]);
  const { pageParagraphs } = require("../page-render.js");
  assert.deepEqual(reply.paragraphs, plain(pageParagraphs(L.screens[0])));
  assert.equal(reply.image, undefined);
});

test("pageData with image: the screen drawn as a PNG at the raster scale", async (t) => {
  const s = await ready(t);
  const reply = await s.ask({ type: "pageData", key: L.key, start: s.shown.start, image: true });
  assert.equal(reply.scale, 2);
  assert.match(reply.image, /^data:image\/png;base64,/);
  const drawn = JSON.parse(Buffer.from(reply.image.split(",")[1], "base64").toString());
  assert.deepEqual([drawn.width, drawn.height], [600, 400]);
});

test("pageData's image is drawn black on white, even in a dark theme", async (t) => {
  const s = setup(t);
  const dark = book.layout({ theme: "dark" });
  await deliver(s, dark, 0, 6);
  const shown = (await show(s, dark, 1)).page;
  let plainDrawn = null;
  const real = s.page.ctx.renderPage;
  s.page.ctx.renderPage = (...args) => {
    const c = real(...args);
    if (args[4]?.plain) plainDrawn = c;
    return c;
  };
  await s.ask({ type: "pageData", key: dark.key, start: shown.start, image: true });
  assert.ok(plainDrawn, "drawn plain");
  assert.equal(plainDrawn.ops[0].color, "#ffffff");
  assert.ok(plainDrawn.ops.slice(1).every((o) => o.color === "#000000"));
});

test("pageData next: the screen right after, or an error when it hasn't come", async (t) => {
  const s = await ready(t);
  const next = await s.ask({ type: "pageData", key: L.key, start: L.screens[0].startPositionId, next: true });
  assert.equal(next.page.start, L.screens[1].startPositionId);
  assert.deepEqual(await s.ask({ type: "pageData", key: L.key, start: L.screens[5].startPositionId, next: true }), { error: "頁面資料裡還沒有下一頁" });
  // A batch further on doesn't count as the next screen.
  await deliver(s, L, 7, 6);
  assert.deepEqual(await s.ask({ type: "pageData", key: L.key, start: L.screens[5].startPositionId, next: true }), { error: "頁面資料裡還沒有下一頁" });
  await deliver(s, L, 6, 1);
  assert.equal((await s.ask({ type: "pageData", key: L.key, start: L.screens[5].startPositionId, next: true })).page.start, L.screens[6].startPositionId);
});

test("pageData for a layout or screen it doesn't have", async (t) => {
  const s = await ready(t);
  assert.deepEqual(await s.ask({ type: "pageData", key: "other", start: 1 }), { error: "這個版面的頁面資料已經不在了" });
  assert.deepEqual(await s.ask({ type: "pageData", key: L.key, start: 12345 }), { error: "頁面資料裡沒有這一頁" });
  assert.deepEqual(await s.ask({ type: "pageData", key: L.key, start: 12345, next: true }), { error: "頁面資料裡還沒有下一頁" });
});

test("pageData reports a drawing failure instead of throwing", async (t) => {
  const s = await ready(t);
  s.page.ctx.OffscreenCanvas = class {
    constructor() {
      throw new Error("out of memory");
    }
  };
  assert.deepEqual(await s.ask({ type: "pageData", key: L.key, start: s.shown.start, image: true }), { error: "out of memory" });
});

test("dumpPage: the screen's data with only the glyphs it uses", async (t) => {
  const s = await ready(t);
  const { filename, data } = (await s.ask({ type: "dumpPage" }));
  assert.equal(filename, `kindle-B0TESTBOOK-${s.shown.start}.json`);
  assert.equal(data.params.asin, "B0TESTBOOK");
  assert.equal(data.page.startPositionId, s.shown.start);
  const used = new Set(data.page.children.filter((c) => c.type === "run").flatMap((r) => r.glyphs));
  for (const f of Object.values(data.fonts)) for (const g of Object.keys(f.glyphs)) assert.ok(used.has(Number(g)));
  assert.ok(Object.keys(data.fonts.testserifNormal.glyphs).length > 5);
});

test("dumpPage before a screen is known", async (t) => {
  const s = setup(t);
  assert.deepEqual(await s.ask({ type: "dumpPage" }), { error: "還不知道目前是哪一頁" });
});

test("debugLog goes to the console", async (t) => {
  const lines = [];
  const s = setup(t, { globals: { console: { ...console, log: (x) => lines.push(x) } } });
  s.send({ type: "debugLog", text: "12:00:00.000 hello" });
  assert.deepEqual(lines, ["[Kindle 翻譯] 12:00:00.000 hello"]);
});

test("messages it doesn't know get no reply", (t) => {
  const s = setup(t);
  assert.equal(s.send({ type: "nope" }).ret, undefined);
});

// ---- Overlay ----

test("an overlay for the screen on show is drawn over the page image", async (t) => {
  const s = await ready(t);
  const { ret, replies } = draw(s, overlayMsg(s.shown, BLOCKS));
  assert.equal(ret, true);
  assert.deepEqual(replies, [{ shown: true }]);
  const root = s.overlay();
  assert.equal(root.style.pointerEvents, "none", "clicks still reach the reader");
  const [heading, a, b, single] = root.children;
  const geom = (el) => [el.style.left, el.style.top, el.style.width, el.style.height];
  // 3px padding, line height 40px (5 lines in 200px), so each box grows by
  // up to half a line (20px) towards a neighbour and not past the first or
  // last block.
  assert.deepEqual(geom(heading), ["97px", "37px", "806px", "66px"]);
  assert.deepEqual(geom(a), ["97px", "97px", "806px", "246px"]);
  assert.deepEqual(geom(b), ["97px", "337px", "806px", "246px"]);
  // The short single line runs to the column's right edge (900px).
  assert.deepEqual(geom(single), ["97px", "577px", "806px", "66px"]);
  assert.equal(heading.style.fontWeight, "700");
  assert.equal(a.style.fontWeight, "400");
  assert.equal(a.style.lineHeight, "1.5");
  assert.equal(single.style.lineHeight, "1.2");
  assert.equal(single.style.whiteSpace, "pre");
  assert.equal(heading.style.display, undefined, "a heading is never treated as a single line");
  assert.deepEqual([a.style.background, a.style.color], ["#fafafa", "#111111"]);
  assert.deepEqual([single.style.background, single.style.color], ["#fafafa", "#222222"]);
  assert.equal(a.textContent, BLOCKS[1].text);
});

test("the overlay sits just above the page, below the reader's toolbar and menus", async (t) => {
  // As in Kindle Cloud Reader: the page container at z-index -3, the app
  // (toolbar, settings panel) at 0.
  const html = '<html><body><div id="app" style="position:fixed;z-index:0"></div><div id="c" class="kr-renderer-container-fullpage"><div id="kr-renderer"><div class="kg-full-page-img"><img /></div></div></div></body></html>';
  const s = await ready(t, { html });
  Object.assign(s.page.$("c").style, { position: "absolute", zIndex: "-3" });
  draw(s, overlayMsg(s.shown, BLOCKS));
  assert.equal(s.overlay().style.zIndex, "-2");
});

test("the outermost stacking ancestor of the page image decides the overlay's level", async (t) => {
  const html = '<html><body><div id="outer"><div id="inner"><div class="kg-full-page-img"><img /></div></div></div></body></html>';
  const s = await ready(t, { html });
  Object.assign(s.page.$("outer").style, { position: "relative", zIndex: "5" });
  Object.assign(s.page.$("inner").style, { position: "absolute", zIndex: "100" });
  draw(s, overlayMsg(s.shown, BLOCKS));
  assert.equal(s.overlay().style.zIndex, "6");
});

test("without a stacking ancestor, the overlay goes on top", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, BLOCKS));
  assert.equal(s.overlay().style.zIndex, "2147483647");
});

test("page pixels are mapped through where the reader draws the page image", async (t) => {
  const s = await ready(t);
  place(s.img(), [100, 50, 600, 400]);
  const blocks = [{ kind: "paragraph", text: "譯文", fg: "#000", boxes: [{ x0: 10, y0: 20, x1: 140, y1: 60, lines: 3 }] }];
  draw(s, overlayMsg(s.shown, blocks, { size: { width: 300, height: 200 } }));
  const [box] = s.overlay().children;
  // ×2: 10,20 → 120,90; 140,60 → 380,170; plus the 3px pad.
  assert.deepEqual([box.style.left, box.style.top, box.style.width, box.style.height], ["117px", "87px", "266px", "86px"]);
});

test("a paragraph spanning two columns gets two boxes, its text split by their lines", async (t) => {
  const s = await ready(t);
  const text = "前半段的文字，在左邊那一欄的最後幾行。後半段的文字在右邊那一欄的最上面。";
  const blocks = [{ kind: "paragraph", text, fg: "#000", boxes: [{ x0: 50, y0: 600, x1: 450, y1: 760, lines: 4 }, { x0: 550, y0: 40, x1: 950, y1: 120, lines: 2 }] }];
  draw(s, overlayMsg(s.shown, blocks));
  const [left, right] = s.overlay().children;
  assert.equal(left.textContent + right.textContent, text);
  assert.ok(left.textContent.length > right.textContent.length);
  assert.equal(left.style.left, "47px");
  assert.equal(right.style.left, "547px");
});

test("a box with no line count counts as one line", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, [{ kind: "paragraph", text: "一行", fg: "#000", boxes: [{ x0: 100, y0: 100, x1: 300, y1: 130 }] }]));
  assert.equal(s.overlay().children[0].style.whiteSpace, "pre");
});

test("an overlay for another screen, or before one is known, is refused", async (t) => {
  const s = setup(t);
  assert.deepEqual(s.send({ type: "overlay", page: { key: "k", start: 1 }, size: { width: 1, height: 1 }, blocks: BLOCKS }).replies, [{ shown: false, stale: true, reason: "畫面已經換頁，這份譯文不畫" }]);
  await deliver(s, L, 0, 6);
  const shown = (await show(s, L, 0)).page;
  assert.deepEqual(s.send(overlayMsg({ ...shown, start: shown.start + 1 }, BLOCKS)).replies, [{ shown: false, stale: true, reason: "畫面已經換頁，這份譯文不畫" }]);
  assert.deepEqual(s.send(overlayMsg({ ...shown, key: "other" }, BLOCKS)).replies, [{ shown: false, stale: true, reason: "畫面已經換頁，這份譯文不畫" }]);
  assert.deepEqual(s.send({ type: "overlay", size: {}, blocks: BLOCKS }).replies, [{ shown: false, stale: true, reason: "畫面已經換頁，這份譯文不畫" }]);
  assert.equal(s.overlay(), null);
});

test("an overlay with nothing to draw is refused with a reason", async (t) => {
  const s = await ready(t);
  assert.deepEqual(s.send(overlayMsg(s.shown, [])).replies, [{ shown: false, reason: "這一頁沒有可以畫的譯文" }]);
  assert.deepEqual(s.send(overlayMsg(s.shown, [{ kind: "paragraph", text: "", fg: "#000", boxes: [{ x0: 0, y0: 0, x1: 10, y1: 10, lines: 1 }] }])).replies, [{ shown: false, reason: "這一頁沒有可以畫的譯文" }]);
});

test("an overlay without a visible page image is refused", async (t) => {
  const s = await ready(t);
  place(s.img(), [0, 0, 0, 0]);
  assert.deepEqual(s.send(overlayMsg(s.shown, BLOCKS)).replies, [{ shown: false, reason: "看不到書頁圖片" }]);
});

test("resizing the window moves the boxes with the page image", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, BLOCKS));
  place(s.img(), [0, 0, 500, 400]);
  s.page.resize(500, 400);
  assert.equal(s.overlay().children[1].style.left, "47px");
});

test("after a page turn, resizing doesn't bring the old overlay back", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, BLOCKS));
  await show(s, L, 1);
  s.page.resize(800, 600);
  assert.equal(s.overlay().childElementCount, 0);
});

test("clearOverlay replies only after the next paint", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, BLOCKS));
  const { ret, replies } = s.send({ type: "clearOverlay" });
  assert.equal(ret, true, "keeps the channel open");
  assert.equal(s.overlay().childElementCount, 0);
  assert.deepEqual(replies, []);
  s.page.frame();
  assert.deepEqual(replies, [], "the first frame runs before the paint");
  s.page.frame();
  assert.deepEqual(replies, [{}]);
});

test("clearOverlay still replies, once, in a tab that doesn't paint", async (t) => {
  const s = setup(t);
  const { replies } = s.send({ type: "clearOverlay" });
  await waitFor(() => replies.length, { what: "fallback reply" });
  s.page.frame();
  s.page.frame();
  await sleep(600 / TIME_SCALE);
  assert.deepEqual(replies, [{}]);
});

test("overlayState says whether translated boxes are showing", async (t) => {
  const s = await ready(t);
  await waitFor(s.toggle, { what: "toggle" });
  assert.deepEqual(s.send({ type: "overlayState" }).replies, [{ shown: false }]);
  draw(s, overlayMsg(s.shown, BLOCKS));
  assert.deepEqual(s.send({ type: "overlayState" }).replies, [{ shown: true }]);
  await s.chrome.storage.sync.set({ overlay: false });
  assert.deepEqual(s.send({ type: "overlayState" }).replies, [{ shown: false }]);
});

test("body text shares one size, never larger than a box can hold", async (t) => {
  const s = await ready(t);
  const para = (y, text, lines = 3) => ({ kind: "paragraph", text, fg: "#000", boxes: [{ x0: 100, y0: y, x1: 900, y1: y + 120, lines }] });
  const blocks = [
    { kind: "heading", text: "第二章", fg: "#000", boxes: [{ x0: 100, y0: 16, x1: 900, y1: 64, lines: 1 }] },
    para(80, "長".repeat(400)),
    para(240, "中".repeat(200)),
    para(400, "短".repeat(60)),
    // A single line doesn't vote, and a cut-off one-word line doesn't get huge.
    { kind: "paragraph", text: "嗯", fg: "#000", boxes: [{ x0: 100, y0: 560, x1: 900, y1: 600, lines: 1 }] },
  ];
  draw(s, overlayMsg(s.shown, blocks));
  const boxes = s.overlay().children;
  const sizes = boxes.map((b) => parseFloat(b.style.fontSize));
  const fits = boxes.map((b) => s.page.ctx.fitText(b));
  assert.ok(fits[1] < fits[2] && fits[2] < fits[3], `fits ${fits}`);
  assert.deepEqual(sizes.slice(1), [fits[1], fits[2], fits[2], fits[2]]);
  assert.ok(fits[4] > fits[2], "the single line could have been larger");
  assert.equal(sizes[0], fits[0], "headings keep their own size");
  for (const b of boxes) assert.ok(b.scrollHeight <= b.clientHeight && b.scrollWidth <= b.clientWidth, "text fits its box");
});

test("a page of headings only keeps each heading's own size", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, [{ kind: "heading", text: "標題", fg: "#000", boxes: [{ x0: 100, y0: 100, x1: 900, y1: 160, lines: 1 }] }]));
  const [h] = s.overlay().children;
  assert.equal(h.style.fontSize, `${s.page.ctx.fitText(h)}px`);
});

test("fitText finds the largest size that fits", (t) => {
  const s = setup(t);
  const box = s.page.document.createElement("div");
  Object.assign(box.style, { width: "100px", height: "50px", lineHeight: "1.5", whiteSpace: "pre-wrap" });
  box.textContent = "一二三四五六七八九十";
  // Two lines of 5+ glyphs need 2 * 1.5 * f <= 50, so f <= 16.67.
  const fit = s.page.ctx.fitText(box);
  assert.ok(fit > 16.67 - 0.5 && fit <= 16.67, `fit ${fit}`);
  assert.equal(box.style.fontSize, `${fit}px`);
  // Nothing fits a tiny box: the floor is 8px.
  Object.assign(box.style, { width: "10px", height: "5px" });
  assert.equal(s.page.ctx.fitText(box), 8);
});

test("verticalRoom: halfway to same-column neighbours, capped, none at the ends", (t) => {
  const { verticalRoom } = setup(t).page.ctx;
  const rects = [
    { x0: 0, y0: 0, x1: 100, y1: 10 },
    { x0: 0, y0: 30, x1: 100, y1: 50 },
    { x0: 0, y0: 54, x1: 100, y1: 70 },
    { x0: 200, y0: 0, x1: 300, y1: 100 }, // another column: never a neighbour
  ];
  assert.deepEqual(plain(verticalRoom(rects, 0, 100)), { above: 0, below: 10 });
  assert.deepEqual(plain(verticalRoom(rects, 1, 100)), { above: 10, below: 2 });
  assert.deepEqual(plain(verticalRoom(rects, 1, 5)), { above: 5, below: 2 });
  assert.deepEqual(plain(verticalRoom(rects, 2, 100)), { above: 2, below: 0 });
  assert.deepEqual(plain(verticalRoom(rects, 3, 100)), { above: 0, below: 0 });
  const overlap = [
    { x0: 0, y0: 0, x1: 100, y1: 20 },
    { x0: 0, y0: 20, x1: 100, y1: 40 },
  ];
  assert.deepEqual(plain(verticalRoom(overlap, 0, 10)), { above: 0, below: 0 });
});

test("columnRight: the right edge of the widest block in the column", (t) => {
  const { columnRight } = setup(t).page.ctx;
  const rects = [
    { x0: 100, y0: 0, x1: 150, y1: 10 },
    { x0: 100, y0: 20, x1: 480, y1: 60 },
    { x0: 90, y0: 70, x1: 470, y1: 90 },
    { x0: 520, y0: 0, x1: 900, y1: 90 },
  ];
  assert.equal(columnRight(rects, 0), 480);
  assert.equal(columnRight(rects, 3), 900);
  assert.equal(columnRight([{ x0: 0, y0: 0, x1: 10, y1: 10 }], 0), 10);
});

// ---- Highlights and styled translations ----

// A highlight the reader draws: one element per word, its class naming the
// position range, positioned in viewport pixels.
function addHighlight(s, { start, end, rects, color = "rgba(255, 235, 59, 0.5)", name = "yellow" }) {
  const host = s.page.document.getElementById("kr-renderer");
  for (const [left, top, width, height] of rects) {
    const el = s.page.document.createElement("div");
    el.className = `kg-client-highlight kg-${name}-highlight ${start}/${end} kg-decoration`;
    Object.assign(el.style, { position: "absolute", left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, backgroundColor: color });
    host.append(el);
  }
  s.page.mutate([{ type: "childList", target: host, addedNodes: [{}], removedNodes: [] }]);
}

test("the highlights on show come with the screen, in page pixels and the reader's colour", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6);
  // The page image is 1000×800 over a 300×200 page: ×1/3.33 to page pixels.
  addHighlight(s, { start: 1010, end: 1030, rects: [[100, 80, 50, 20], [150, 80, 40, 20]] });
  addHighlight(s, { start: 1200, end: 1210, rects: [[300, 300, 30, 20]], color: "rgb(160, 200, 255)", name: "blue" });
  const msg = await show(s, L, 0);
  assert.deepEqual(msg.page.highlights, [
    { start: 1010, end: 1030, color: "rgba(255, 235, 59, 0.5)", boxes: [{ x0: 30, y0: 20, x1: 45, y1: 25 }, { x0: 45, y0: 20, x1: 57, y1: 25 }] },
    { start: 1200, end: 1210, color: "rgb(160, 200, 255)", boxes: [{ x0: 90, y0: 75, x1: 99, y1: 80 }] },
  ]);
  assert.deepEqual((await s.ask({ type: "currentPage" })).page.highlights, msg.page.highlights);
});

test("elements without a position range, or of no size, aren't highlights", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6);
  addHighlight(s, { start: 5, end: 9, rects: [[10, 10, 0, 0]] });
  const odd = s.page.document.createElement("div");
  odd.className = "kg-client-highlight kg-yellow-highlight";
  Object.assign(odd.style, { left: "1px", top: "1px", width: "5px", height: "5px" });
  s.page.document.getElementById("kr-renderer").append(odd);
  assert.deepEqual((await show(s, L, 0)).page.highlights, []);
});

test("adding or removing a highlight reports the same screen again, with its highlights", async (t) => {
  const s = await ready(t);
  addHighlight(s, { start: 1010, end: 1030, rects: [[100, 80, 50, 20]] });
  await waitFor(() => s.sent("pageShown").length === 2, { what: "second report" });
  const second = s.sent("pageShown")[1];
  assert.equal(second.highlights, true);
  assert.equal(second.page.start, s.shown.start);
  assert.equal(second.page.highlights.length, 1);
  // Unrelated DOM churn with the same highlights reports nothing.
  s.page.mutate([{ type: "childList", target: s.page.document.body, addedNodes: [{}], removedNodes: [] }]);
  await sleep(10);
  assert.equal(s.sent("pageShown").length, 2);
  // Removing it reports again, with none.
  for (const el of s.page.document.querySelectorAll(".kg-client-highlight")) el.remove();
  s.page.mutate([{ type: "childList", target: s.page.document.body, addedNodes: [], removedNodes: [{}] }]);
  await waitFor(() => s.sent("pageShown").length === 3, { what: "third report" });
  assert.deepEqual(plain(s.sent("pageShown")[2].page.highlights), []);
});

test("highlights removed and drawn again at once (as the reader does when one is added) report once", async (t) => {
  const s = await ready(t);
  addHighlight(s, { start: 1010, end: 1030, rects: [[100, 80, 50, 20]] });
  await waitFor(() => s.sent("pageShown").length === 2, { what: "report" });
  // The reader adds one: it removes them all, then draws both.
  for (const el of s.page.document.querySelectorAll(".kg-client-highlight")) el.remove();
  s.page.mutate([{ type: "childList", target: s.page.document.body, addedNodes: [], removedNodes: [{}] }]);
  addHighlight(s, { start: 1010, end: 1030, rects: [[100, 80, 50, 20]] });
  addHighlight(s, { start: 1200, end: 1210, rects: [[300, 300, 30, 20]], color: "rgb(130, 180, 255)", name: "blue" });
  await sleep(40);
  assert.equal(s.sent("pageShown").length, 3, "one report, not one for 'none' and one for two");
  assert.equal(s.sent("pageShown")[2].page.highlights.length, 2);
});

test("currentPage waits for an identification that starts while it waits", async (t) => {
  const s = setup(t);
  await deliver(s, L, 0, 6);
  await show(s, L, 1, { complete: false, wait: false });
  const reply = s.ask({ type: "currentPage" });
  // While it waits on the first image, a second one replaces it.
  await show(s, L, 2, { wait: false });
  assert.equal((await reply).page.start, L.screens[2].startPositionId);
});

test("a highlight change keeps the overlay; the screen's translation is redrawn for it", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, BLOCKS));
  addHighlight(s, { start: 1010, end: 1030, rects: [[100, 80, 50, 20]] });
  await waitFor(() => s.sent("pageShown").length === 2, { what: "report" });
  assert.equal(s.overlay().childElementCount, 4, "not cleared: the screen is the same");
  assert.deepEqual(draw(s, overlayMsg(s.sent("pageShown")[1].page, BLOCKS)).replies, [{ shown: true }], "and its redrawn translation is accepted");
});

test("styled translations: italics in a kai face, bold, highlights on their colour", async (t) => {
  const s = await ready(t);
  const blocks = [{ kind: "paragraph", text: "讀<i>建構推理模型</i>這本<h1>書<b>很</b>好</h1>。", fg: "#000", marks: { h1: "rgba(255, 235, 59, 0.5)" }, boxes: [{ x0: 100, y0: 100, x1: 900, y1: 200, lines: 3 }] }];
  draw(s, overlayMsg(s.shown, blocks));
  const [box] = s.overlay().children;
  assert.equal(box.textContent, "讀建構推理模型這本書很好。");
  const spans = box.querySelectorAll("span");
  assert.deepEqual(
    spans.map((sp) => [sp.textContent, sp.style.fontFamily ?? "", sp.style.fontWeight ?? "", sp.style.background ?? ""]),
    [
      ["建構推理模型", s.page.ctx.run("KAI"), "", ""],
      ["書", "", "", "rgba(255, 235, 59, 0.5)"],
      ["很", "", "700", "rgba(255, 235, 59, 0.5)"],
      ["好", "", "", "rgba(255, 235, 59, 0.5)"],
    ]
  );
});

test("a highlight mark with no colour given, or unknown marks, draw plainly", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, [{ kind: "paragraph", text: "一<h2>二</h2>三", fg: "#000", boxes: [{ x0: 100, y0: 100, x1: 900, y1: 200, lines: 3 }] }]));
  const [span] = s.overlay().children[0].querySelectorAll("span");
  assert.equal(span.textContent, "二");
  assert.equal(span.style.background, undefined);
});

test("a translation that looks like HTML is drawn as text, never parsed", async (t) => {
  const s = await ready(t);
  const text = '<img src=x onerror="alert(1)"><script>bad()</script><i>斜</i>';
  draw(s, overlayMsg(s.shown, [{ kind: "paragraph", text, fg: "#000", boxes: [{ x0: 100, y0: 100, x1: 900, y1: 200, lines: 3 }] }]));
  const [box] = s.overlay().children;
  assert.equal(box.querySelectorAll("img").length + box.querySelectorAll("script").length, 0);
  assert.equal(box.textContent, '<img src=x onerror="alert(1)"><script>bad()</script>斜');
});

test("broken marks are drawn as plain text", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, [{ kind: "paragraph", text: "<i>沒有關上", fg: "#000", boxes: [{ x0: 100, y0: 100, x1: 900, y1: 200, lines: 3 }] }]));
  const [box] = s.overlay().children;
  assert.equal(box.textContent, "沒有關上");
  assert.equal(box.querySelectorAll("span").length, 0);
});

test("a styled paragraph split across two columns keeps its styles on both sides", async (t) => {
  const s = await ready(t);
  const text = `前半段${"甲".repeat(10)}<i>${"乙".repeat(20)}</i>後半段。`;
  const blocks = [{ kind: "paragraph", text, fg: "#000", boxes: [{ x0: 50, y0: 600, x1: 450, y1: 700, lines: 2 }, { x0: 550, y0: 40, x1: 950, y1: 140, lines: 2 }] }];
  draw(s, overlayMsg(s.shown, blocks));
  const [left, right] = s.overlay().children;
  assert.equal(left.textContent + right.textContent, "前半段" + "甲".repeat(10) + "乙".repeat(20) + "後半段。");
  assert.ok(left.querySelectorAll("span").length >= 1 && right.querySelectorAll("span").length >= 1, "italics on both sides of the cut");
});

// ---- Floating toggle ----

test("the toggle button's label follows the setting", async (t) => {
  const s = setup(t, { sync: { overlay: false } });
  await waitFor(s.toggle, { what: "toggle" });
  assert.equal(s.toggle().textContent, "顯示譯文");
  await s.chrome.storage.sync.set({ overlay: true });
  assert.equal(s.toggle().textContent, "顯示原文");
  assert.equal(s.page.document.querySelectorAll("#kindle-translator-toggle").length, 1);
});

test("clicking the toggle flips the setting and only hides the overlay", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, BLOCKS));
  await waitFor(s.toggle, { what: "toggle" });
  s.toggle().click();
  await waitFor(async () => (await s.chrome.storage.sync.get("overlay")).overlay === false, { what: "overlay off" });
  assert.equal(s.overlay().style.display, "none");
  assert.equal(s.toggle().textContent, "顯示譯文");
  assert.equal(s.overlay().childElementCount, BLOCKS.length, "only hidden, so switching back is instant");
  s.toggle().click();
  await waitFor(async () => (await s.chrome.storage.sync.get("overlay")).overlay === true, { what: "overlay on" });
  assert.equal(s.overlay().style.display, "");
});

test("clicking the toggle of an orphaned script doesn't throw", async (t) => {
  const s = setup(t);
  await waitFor(s.toggle, { what: "toggle" });
  s.chrome.storage.sync.set = () => {
    throw new Error("Extension context invalidated.");
  };
  assert.doesNotThrow(() => s.toggle().click());
});

test("storage changes from elsewhere hide and show the overlay", async (t) => {
  const s = await ready(t);
  draw(s, overlayMsg(s.shown, BLOCKS));
  await waitFor(s.toggle, { what: "initial setting read" });
  await s.chrome.storage.sync.set({ overlay: false });
  assert.equal(s.overlay().style.display, "none");
  await s.chrome.storage.sync.set({ autoTranslate: false });
  await s.chrome.storage.local.set({ overlay: true });
  assert.equal(s.overlay().style.display, "none");
  await s.chrome.storage.sync.set({ overlay: true });
  assert.equal(s.overlay().style.display, "");
});

test("an overlay first drawn while the switch is off starts hidden", async (t) => {
  const s = await ready(t, { sync: { overlay: false } });
  await waitFor(() => s.toggle()?.textContent === "顯示譯文", { what: "setting read" });
  draw(s, overlayMsg(s.shown, BLOCKS));
  assert.equal(s.overlay().style.display, "none");
});

test("a button and overlay left by an orphaned script are replaced", async (t) => {
  const s = setup(t, { html: READER_HTML.replace("</body>", '<button id="kindle-translator-toggle">old</button><div id="kindle-translator-overlay"><div></div></div></body>') });
  await waitFor(() => s.toggle()?.textContent === "顯示原文", { what: "new toggle" });
  assert.equal(s.page.document.querySelectorAll("#kindle-translator-toggle").length, 1);
  await deliver(s, L, 0, 6);
  const shown = (await show(s, L, 0)).page;
  draw(s, overlayMsg(shown, BLOCKS));
  assert.equal(s.page.document.querySelectorAll("#kindle-translator-overlay").length, 1);
  assert.equal(s.overlay().childElementCount, BLOCKS.length);
});

// ---- Where the book is drawn (vision engine) ----

test("geometry reports the page image in CSS pixels", async (t) => {
  const s = setup(t, { innerWidth: 1571, innerHeight: 974 });
  place(s.img(), [157, 60, 1257, 824]);
  const [g] = s.send({ type: "geometry" }).replies;
  assert.deepEqual(g.viewport, { width: 1571, height: 974 });
  assert.deepEqual(g.page, { left: 157, top: 60, right: 1414, bottom: 884 });
  assert.equal(typeof g.dpr, "number");
});

test("geometry rounds to whole pixels", (t) => {
  const s = setup(t);
  place(s.img(), [100.4, 59.6, 800.3, 700.2]);
  assert.deepEqual(s.send({ type: "geometry" }).replies[0].page, { left: 100, top: 60, right: 901, bottom: 760 });
});

test("without the reader's page image, geometry takes the large images on screen", (t) => {
  const s = setup(t, { html: "<html><body></body></html>", innerWidth: 1600, innerHeight: 1000 });
  const add = (tag, rect) => {
    const el = s.page.document.createElement(tag);
    place(el, rect);
    s.page.document.body.append(el);
  };
  add("img", [160, 60, 630, 820]);
  add("canvas", [810, 60, 630, 820]);
  add("img", [50, 22, 18, 18]); // an icon
  add("img", [1700, 0, 800, 800]); // off screen
  assert.deepEqual(s.send({ type: "geometry" }).replies[0].page, { left: 160, top: 60, right: 1440, bottom: 880 });
});

test("geometry is null without page images", (t) => {
  const s = setup(t, { html: "<html><body></body></html>" });
  const [g] = s.send({ type: "geometry" }).replies;
  assert.equal(g.page, null);
  assert.deepEqual(g.viewport, { width: 1000, height: 800 });
});

// ---- Page data for a test tool (options page → 開發者) ----

test("a test tool's request is relayed and the result posted back", async (t) => {
  const s = setup(t);
  s.chrome._.runtimeMessageHandler = (msg) => (msg.type === "devCapture" ? { ok: true, filename: `${msg.name}.json` } : undefined);
  const results = [];
  s.page.window.addEventListener("message", (e) => e.data?.type === "kindle-translator-dev-capture-result" && results.push(plain(e.data)));
  s.page.window.postMessage({ type: "kindle-translator-dev-capture", id: 7, name: "alice-p1" }, "*");
  await waitFor(() => results.length);
  assert.deepEqual(plain(s.sent("devCapture")), [{ type: "devCapture", name: "alice-p1" }]);
  assert.deepEqual(results, [{ type: "kindle-translator-dev-capture-result", id: 7, ok: true, filename: "alice-p1.json" }]);
});

test("a failed relay is reported back, not thrown", async (t) => {
  const s = setup(t);
  s.chrome._.runtimeMessageHandler = (msg) => {
    if (msg.type === "devCapture") throw new Error("Extension context invalidated.");
  };
  const results = [];
  s.page.window.addEventListener("message", (e) => e.data?.type === "kindle-translator-dev-capture-result" && results.push(plain(e.data)));
  s.page.window.postMessage({ type: "kindle-translator-dev-capture", id: 1 }, "*");
  await waitFor(() => results.length);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /Extension context invalidated/);
});

test("requests from another window are ignored", async (t) => {
  const s = setup(t);
  s.page.fire(s.page.window, "message", { data: { type: "kindle-translator-dev-capture", id: 1 }, source: {} });
  await sleep(10);
  assert.equal(s.sent("devCapture").length, 0);
});
