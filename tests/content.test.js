const test = require("node:test");
const assert = require("node:assert/strict");
const { TIME_SCALE, plain, waitFor, source } = require("./helpers/load");
const { createChrome } = require("./helpers/chrome");
const { loadPage } = require("./helpers/dom");

// content.js waits 1200 ms after the last hint before reporting a turn.
const DEBOUNCE = 1200 / TIME_SCALE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(DEBOUNCE * 3);

function setup(t, { sync = {}, top, innerWidth = 1000, innerHeight = 800, globals } = {}) {
  const chrome = createChrome({ sync });
  // The background answers pageTurned with nothing; without a handler the
  // fake rejects, which would be an unhandled rejection here.
  chrome._.runtimeMessageHandler = () => undefined;
  const page = loadPage(["content.js"], { chrome, top, innerWidth, innerHeight, globals });
  t.after(() => page.close());
  const turns = () => chrome._.runtimeMessages.filter((m) => m.type === "pageTurned").map((m) => m.reason);
  // Send a runtime message the way the background's tabs.sendMessage does.
  const send = (msg) => {
    const replies = [];
    const [ret] = chrome.runtime.onMessage.dispatch(msg, {}, (r) => replies.push(plain(r)));
    return { ret, replies };
  };
  const overlay = () => page.$("kindle-translator-overlay");
  const toggle = () => page.$("kindle-translator-toggle");
  return { chrome, page, turns, send, overlay, toggle };
}

const key = (s, k) => s.page.fire(s.page.document, "keydown", { key: k });

// Two paragraphs of one column, a heading above and a short single line below.
const BLOCKS = [
  { kind: "heading", box: [0.1, 0.05, 0.9, 0.1], lines: 1, text: "第一章", bg: "#ffffff", fg: "#000000" },
  { kind: "paragraph", box: [0.1, 0.15, 0.9, 0.4], lines: 5, text: "他走進房間。".repeat(20), bg: "#fafafa", fg: "#111111" },
  { kind: "paragraph", box: [0.1, 0.45, 0.9, 0.7], lines: 5, text: "她沒有回頭。".repeat(20), bg: "#fafafa", fg: "#111111" },
  { kind: "paragraph", box: [0.1, 0.75, 0.3, 0.8], lines: 1, text: "好。", bg: "#eeeeee", fg: "#222222" },
];

// Shows `blocks` and waits for the after-paint reply.
function show(s, blocks = BLOCKS, turn) {
  const r = s.send({ type: "overlay", blocks, turn });
  s.page.frame();
  s.page.frame();
  return r;
}

// ---- Loading ----

test("the guard refuses to run a second time in the same window", (t) => {
  assert.throws(() => setup(t, { globals: { __kindleTranslatorLoaded: true } }), /already loaded/);
});

test("re-injecting into the same page doesn't add a second set of listeners", async (t) => {
  const s = setup(t);
  // Its top-level const declarations already exist, so the script fails
  // before running; either way nothing is registered twice.
  assert.throws(() => s.page.ctx.run(source("content.js")));
  assert.equal(s.page.document._listeners.filter((l) => l.type === "keydown").length, 1);
  key(s, "ArrowRight");
  await settle();
  assert.deepEqual(s.turns(), ["key"]);
});

// ---- Page-turn hints ----

test("navigation keys report a page turn after the debounce", async (t) => {
  for (const k of ["ArrowLeft", "ArrowRight", "PageUp", "PageDown", " ", "Enter"]) {
    const s = setup(t);
    key(s, k);
    assert.deepEqual(s.turns(), [], "waits for the page to settle");
    await settle();
    assert.deepEqual(s.turns(), ["key"], k);
  }
});

test("other keys are not page turns", async (t) => {
  const s = setup(t);
  for (const k of ["a", "Shift", "ArrowUp", "Escape"]) key(s, k);
  await settle();
  assert.deepEqual(s.turns(), []);
});

test("click and wheel report their reason", async (t) => {
  const s = setup(t);
  s.page.document.body.click();
  await settle();
  s.page.fire(s.page.document.body, "wheel", { deltaY: 100 });
  await settle();
  assert.deepEqual(s.turns(), ["click", "wheel"]);
});

test("a burst of hints collapses into one message with the last reason", async (t) => {
  const s = setup(t);
  key(s, "ArrowRight");
  key(s, "ArrowRight");
  s.page.fire(s.page.document.body, "wheel");
  s.page.document.body.click();
  await settle();
  assert.deepEqual(s.turns(), ["click"]);
});

test("a user action clears the overlay and bumps the turn counter", async (t) => {
  const s = setup(t);
  show(s, BLOCKS, 0);
  assert.equal(s.overlay().childElementCount, BLOCKS.length);
  key(s, "ArrowRight");
  assert.equal(s.overlay().childElementCount, 0, "cleared at once, before the debounce");
  const { replies } = s.send({ type: "clearOverlay" });
  s.page.frame();
  s.page.frame();
  assert.deepEqual(replies, [{ turn: 1 }]);
  // The overlay translated for turn 0 is now stale.
  assert.deepEqual(s.send({ type: "overlay", blocks: BLOCKS, turn: 0 }).replies, [
    { shown: false, reason: "請求期間翻頁了，已丟棄舊頁的譯文" },
  ]);
});

// ---- DOM mutations ----

test("fewer than two significant changes are ignored", async (t) => {
  const s = setup(t);
  const body = s.page.document.body;
  const node = s.page.document.createElement("span");
  s.page.mutate([{ type: "childList", target: body, addedNodes: [node], removedNodes: [] }]);
  s.page.mutate([{ type: "attributes", target: body, attributeName: "style", addedNodes: [], removedNodes: [] }]);
  await settle();
  assert.deepEqual(s.turns(), []);
});

test("two or more significant changes report 'dom' without clearing the overlay", async (t) => {
  const s = setup(t);
  show(s);
  const body = s.page.document.body;
  const [a, b] = [s.page.document.createElement("div"), s.page.document.createElement("div")];
  s.page.mutate([{ type: "childList", target: body, addedNodes: [a], removedNodes: [b] }]);
  await settle();
  s.page.mutate([
    { type: "attributes", target: a, attributeName: "src", addedNodes: [], removedNodes: [] },
    { type: "attributes", target: a, attributeName: "style", addedNodes: [], removedNodes: [] },
  ]);
  await settle();
  assert.deepEqual(s.turns(), ["dom", "dom"]);
  assert.equal(s.overlay().childElementCount, BLOCKS.length);
});

test("changes to the overlay and the toggle button are not page changes", async (t) => {
  const s = setup(t);
  show(s);
  await waitFor(s.toggle, { what: "toggle" });
  const boxes = s.overlay().children;
  s.page.mutate([
    { type: "childList", target: s.overlay(), addedNodes: boxes, removedNodes: [] },
    { type: "attributes", target: boxes[0], attributeName: "style", addedNodes: [], removedNodes: [] },
    { type: "childList", target: s.page.document.documentElement, addedNodes: [s.overlay(), s.toggle()], removedNodes: [] },
    { type: "childList", target: s.toggle(), addedNodes: ["顯示原文", "x"], removedNodes: ["顯示譯文"] },
  ]);
  await settle();
  assert.deepEqual(s.turns(), []);
});

test("a user action is not overwritten by the re-render that follows it", async (t) => {
  const s = setup(t);
  const body = s.page.document.body;
  const churn = () =>
    s.page.mutate([{ type: "childList", target: body, addedNodes: [{}, {}], removedNodes: [] }]);
  key(s, "ArrowRight");
  churn();
  await settle();
  // ...but a user action does replace a pending "dom".
  churn();
  s.page.document.body.click();
  await settle();
  assert.deepEqual(s.turns(), ["key", "click"]);
});

// ---- Resize ----

test("a real window resize is a page turn; a same-size resize only re-checks", async (t) => {
  const s = setup(t);
  show(s);
  s.page.resize(1000, 800);
  await settle();
  assert.deepEqual(s.turns(), ["dom"]);
  assert.equal(s.overlay().childElementCount, BLOCKS.length, "toolbar slide keeps the overlay");
  s.page.resize(1200, 800);
  assert.equal(s.overlay().childElementCount, 0);
  await settle();
  assert.deepEqual(s.turns(), ["dom", "resize"]);
});

// ---- Frames ----

test("an iframe forwards user actions to the top frame, which reports them", async (t) => {
  const top = setup(t);
  show(top);
  const frame = setup(t, { top: top.page.window });
  key(frame, "ArrowRight");
  await waitFor(() => top.overlay().childElementCount === 0, { what: "top frame clears its overlay" });
  await settle();
  assert.deepEqual(top.turns(), ["key"]);
  assert.deepEqual(frame.turns(), [], "the iframe doesn't report user actions itself");
  // The iframe sets up no overlay, toggle or message handling of its own.
  assert.equal(frame.chrome.runtime.onMessage.listeners.length, 0);
  assert.equal(frame.page.$("kindle-translator-toggle"), null);
});

test("an iframe reports its own DOM churn directly", async (t) => {
  const top = setup(t);
  const frame = setup(t, { top: top.page.window });
  frame.page.mutate([{ type: "childList", target: frame.page.document.body, addedNodes: [{}, {}], removedNodes: [] }]);
  await settle();
  assert.deepEqual(frame.turns(), ["dom"]);
  assert.deepEqual(top.turns(), []);
});

test("the top frame accepts turn messages without a reason as 'frame'", async (t) => {
  const s = setup(t);
  s.page.window.postMessage({ type: "kindle-translator-turn" }, "*");
  s.page.window.postMessage({ type: "something-else", reason: "key" }, "*");
  await settle();
  assert.deepEqual(s.turns(), ["frame"]);
});

// ---- Orphaned script ----

test("after the extension reloads, the orphaned script does nothing", async (t) => {
  const s = setup(t);
  show(s);
  s.chrome.runtime.id = undefined;
  key(s, "ArrowRight");
  s.page.document.body.click();
  s.page.resize(1200, 900);
  s.page.mutate([{ type: "childList", target: s.page.document.body, addedNodes: [{}, {}], removedNodes: [] }]);
  await settle();
  assert.deepEqual(s.turns(), []);
  assert.equal(s.overlay().childElementCount, BLOCKS.length, "keeps the translation rather than leaving English");
});

// ---- Messages from the background ----

test("clearOverlay replies with the turn only after the next paint", (t) => {
  const s = setup(t);
  show(s);
  const { ret, replies } = s.send({ type: "clearOverlay" });
  assert.equal(ret, true, "keeps the channel open");
  assert.equal(s.overlay().childElementCount, 0);
  assert.deepEqual(replies, []);
  s.page.frame();
  assert.deepEqual(replies, [], "the first frame runs before the paint");
  s.page.frame();
  assert.deepEqual(replies, [{ turn: 0 }]);
});

test("clearOverlay still replies, once, in a tab that doesn't paint", async (t) => {
  const s = setup(t);
  const { replies } = s.send({ type: "clearOverlay" });
  await waitFor(() => replies.length, { what: "fallback reply" });
  s.page.frame();
  s.page.frame();
  await sleep(600 / TIME_SCALE);
  assert.deepEqual(replies, [{ turn: 0 }]);
});

test("overlayState says whether translated boxes are showing", async (t) => {
  const s = setup(t);
  await waitFor(s.toggle, { what: "toggle" });
  assert.deepEqual(s.send({ type: "overlayState" }).replies, [{ shown: false }]);
  show(s);
  assert.deepEqual(s.send({ type: "overlayState" }).replies, [{ shown: true }]);
  await s.chrome.storage.sync.set({ overlay: false });
  assert.deepEqual(s.send({ type: "overlayState" }).replies, [{ shown: false }]);
});

test("an overlay with no blocks is refused with a reason", (t) => {
  const s = setup(t);
  assert.deepEqual(s.send({ type: "overlay", blocks: [], turn: 0 }).replies, [
    { shown: false, reason: "Claude 沒有在這張截圖裡找到內文區塊" },
  ]);
  assert.equal(s.overlay(), null);
});

test("overlay boxes are placed from the block fractions", (t) => {
  const s = setup(t);
  const { ret, replies } = show(s, BLOCKS, 0);
  assert.equal(ret, true);
  assert.deepEqual(replies, [{ shown: true }]);
  const root = s.overlay();
  assert.equal(root.style.pointerEvents, "none", "clicks still reach the reader");
  const [heading, a, b, single] = root.children;
  const geom = (el) => [el.style.left, el.style.top, el.style.width, el.style.height];
  // 1000x800 viewport, 3px padding, line height 40px (5 lines in 200px), so
  // each box grows by up to half a line (20px) towards a neighbour and not
  // past the first or last block.
  assert.deepEqual(geom(heading), ["97px", "37px", "806px", "66px"]);
  assert.deepEqual(geom(a), ["97px", "97px", "806px", "246px"]);
  assert.deepEqual(geom(b), ["97px", "337px", "806px", "246px"]);
  // The short single line runs to the column's right edge (900px).
  assert.deepEqual(geom(single), ["97px", "577px", "806px", "66px"]);

  assert.equal(heading.style.fontWeight, "700");
  assert.equal(a.style.fontWeight, "400");
  assert.equal(a.style.lineHeight, "1.5");
  assert.equal(a.style.whiteSpace, "pre-wrap");
  assert.equal(single.style.lineHeight, "1.2");
  assert.equal(single.style.whiteSpace, "pre");
  assert.equal(single.style.display, "flex");
  assert.equal(heading.style.display, undefined, "a heading is never treated as a single line");
  assert.deepEqual([a.style.background, a.style.color], ["#fafafa", "#111111"]);
  assert.deepEqual([single.style.background, single.style.color], ["#eeeeee", "#222222"]);
  assert.equal(a.textContent, BLOCKS[1].text);
});

test("blocks without a line count are judged single by height", (t) => {
  const s = setup(t);
  const blocks = BLOCKS.map(({ lines, ...b }) => b);
  show(s, blocks);
  const [heading, a, , single] = s.overlay().children;
  // The shortest body box (40px) is taken as one line.
  assert.equal(single.style.whiteSpace, "pre");
  assert.equal(a.style.whiteSpace, "pre-wrap");
  assert.equal(heading.style.whiteSpace, "pre-wrap");
});

test("body text shares one size, never larger than a box can hold", (t) => {
  const s = setup(t);
  const para = (y, text) => ({ kind: "paragraph", box: [0.1, y, 0.9, y + 0.15], lines: 3, text, bg: "#fff", fg: "#000" });
  const blocks = [
    { kind: "heading", box: [0.1, 0.02, 0.9, 0.08], lines: 1, text: "第二章", bg: "#fff", fg: "#000" },
    para(0.1, "長".repeat(400)),
    para(0.3, "中".repeat(200)),
    para(0.5, "短".repeat(60)),
    // A single line doesn't vote, and a cut-off one-word line doesn't get huge.
    { kind: "paragraph", box: [0.1, 0.7, 0.9, 0.75], lines: 1, text: "嗯", bg: "#fff", fg: "#000" },
  ];
  show(s, blocks);
  const boxes = s.overlay().children;
  const sizes = boxes.map((b) => parseFloat(b.style.fontSize));
  const fits = boxes.map((b) => s.page.ctx.fitText(b));
  // Paragraph fits ascend with less text; the median (the middle one) is the page size.
  assert.ok(fits[1] < fits[2] && fits[2] < fits[3], `fits ${fits}`);
  assert.deepEqual(sizes.slice(1), [fits[1], fits[2], fits[2], fits[2]]);
  assert.ok(fits[4] > fits[2], "the single line could have been larger");
  assert.equal(sizes[0], fits[0], "headings keep their own size");
  for (const b of boxes) {
    assert.ok(b.scrollHeight <= b.clientHeight && b.scrollWidth <= b.clientWidth, "text fits its box");
  }
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

// ---- Floating toggle ----

test("the toggle button's label follows the setting", async (t) => {
  const s = setup(t, { sync: { overlay: false } });
  await waitFor(s.toggle, { what: "toggle" });
  assert.equal(s.toggle().textContent, "顯示譯文");
  await s.chrome.storage.sync.set({ overlay: true });
  assert.equal(s.toggle().textContent, "顯示原文");
  assert.equal(s.page.document.querySelectorAll("#kindle-translator-toggle").length, 1);
});

test("clicking the toggle flips the setting and is not a page turn", async (t) => {
  const s = setup(t);
  show(s);
  await waitFor(s.toggle, { what: "toggle" });
  s.toggle().click();
  await waitFor(async () => (await s.chrome.storage.sync.get("overlay")).overlay === false, { what: "overlay off" });
  assert.equal(s.overlay().style.display, "none");
  assert.equal(s.toggle().textContent, "顯示譯文");
  assert.equal(s.overlay().childElementCount, BLOCKS.length, "only hidden, so switching back is instant");
  s.toggle().click();
  await waitFor(async () => (await s.chrome.storage.sync.get("overlay")).overlay === true, { what: "overlay on" });
  assert.equal(s.overlay().style.display, "");
  await settle();
  assert.deepEqual(s.turns(), []);
});

test("storage changes from elsewhere hide and show the overlay", async (t) => {
  const s = setup(t);
  show(s);
  await waitFor(s.toggle, { what: "initial setting read" });
  await s.chrome.storage.sync.set({ overlay: false });
  assert.equal(s.overlay().style.display, "none");
  // Other keys and areas are ignored.
  await s.chrome.storage.sync.set({ autoTranslate: false });
  await s.chrome.storage.local.set({ overlay: true });
  assert.equal(s.overlay().style.display, "none");
  await s.chrome.storage.sync.set({ overlay: true });
  assert.equal(s.overlay().style.display, "");
});

test("a button left by an orphaned script is replaced", async (t) => {
  const chrome = createChrome();
  const page = loadPage(["content.js"], {
    chrome,
    html: '<html><body><button id="kindle-translator-toggle">old</button><div id="kindle-translator-overlay"><div></div></div></body></html>',
  });
  t.after(() => page.close());
  await waitFor(() => page.$("kindle-translator-toggle")?.textContent === "顯示原文", { what: "new toggle" });
  assert.equal(page.document.querySelectorAll("#kindle-translator-toggle").length, 1);
  chrome.runtime.onMessage.dispatch({ type: "overlay", blocks: BLOCKS }, {}, () => {});
  assert.equal(page.document.querySelectorAll("#kindle-translator-overlay").length, 1);
  assert.equal(page.$("kindle-translator-overlay").childElementCount, BLOCKS.length);
});

// ---- Pure helpers ----

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
  // Overlapping boxes give no room rather than negative room.
  const overlap = [
    { x0: 0, y0: 0, x1: 100, y1: 20 },
    { x0: 0, y0: 20, x1: 100, y1: 40 },
  ];
  assert.deepEqual(plain(verticalRoom(overlap, 0, 10)), { above: 0, below: 0 });
});

test("columnRight: the right edge of the widest block in the column", (t) => {
  const { columnRight } = setup(t).page.ctx;
  const rects = [
    { x0: 100, y0: 0, x1: 150, y1: 10 }, // short line
    { x0: 100, y0: 20, x1: 480, y1: 60 },
    { x0: 90, y0: 70, x1: 470, y1: 90 },
    { x0: 520, y0: 0, x1: 900, y1: 90 }, // right-hand column
  ];
  assert.equal(columnRight(rects, 0), 480);
  assert.equal(columnRight(rects, 3), 900);
  assert.equal(columnRight([{ x0: 0, y0: 0, x1: 10, y1: 10 }], 0), 10);
});

// ---- Where the book is drawn ----

// An element at a fixed box, as the reader places its page images.
function place(s, tag, [left, top, width, height]) {
  const el = s.page.document.createElement(tag);
  Object.assign(el.style, { position: "absolute", left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  s.page.document.documentElement.append(el);
  return el;
}

test("geometry reports the book page image in CSS pixels", (t) => {
  const s = setup(t, { innerWidth: 1571, innerHeight: 974 });
  // Kindle Cloud Reader's page image, as measured in a 1571×974 window.
  place(s, "img", [157, 60, 1257, 824]);
  place(s, "img", [50, 22, 18, 18]); // an icon
  const [g] = s.send({ type: "geometry" }).replies;
  assert.deepEqual(g.viewport, { width: 1571, height: 974 });
  assert.deepEqual(g.page, { left: 157, top: 60, right: 1414, bottom: 884 });
  assert.equal(typeof g.dpr, "number");
});

test("geometry covers both pages of a spread drawn as two images", (t) => {
  const s = setup(t, { innerWidth: 1600, innerHeight: 1000 });
  place(s, "img", [160, 60, 630, 820]);
  place(s, "canvas", [810, 60, 630, 820]);
  assert.deepEqual(s.send({ type: "geometry" }).replies[0].page, { left: 160, top: 60, right: 1440, bottom: 880 });
});

test("geometry ignores small and off-screen images", (t) => {
  const s = setup(t, { innerWidth: 1000, innerHeight: 800 });
  place(s, "img", [100, 100, 100, 600]); // too narrow
  place(s, "img", [100, 100, 800, 100]); // too short
  place(s, "img", [1200, 0, 800, 800]); // off screen (the next page, preloaded)
  assert.equal(s.send({ type: "geometry" }).replies[0].page, null);
});

test("geometry is null without page images", (t) => {
  const s = setup(t);
  const [g] = s.send({ type: "geometry" }).replies;
  assert.equal(g.page, null);
  assert.deepEqual(g.viewport, { width: 1000, height: 800 });
});
