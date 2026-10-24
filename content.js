// Detects page turns in Kindle Cloud Reader and tells the background worker.
// The reader re-renders the page area on every turn, so a debounced
// MutationObserver plus arrow-key / click hints is enough for a prototype.
//
// The top frame also draws the translation overlay: one box per text block,
// positioned from the fractions the background worker sends.

// Guard against double injection (manifest + background retry injection).
if (window.__kindleTranslatorLoaded) throw new Error("already loaded");
window.__kindleTranslatorLoaded = true;

const IS_TOP = window.top === window;
const TURN_MSG = "kindle-translator-turn";

let timer = null;
let pendingReason = null;

// userAction: a key/click/wheel/resize that may have turned the page, so the
// current overlay is stale. Plain DOM churn (toolbar fading, progress updates)
// only asks for a re-check; the background skips it if the screen is unchanged.
function notify(reason, userAction = true) {
  if (userAction) {
    if (IS_TOP) onTurnHint();
    else window.top.postMessage({ type: TURN_MSG }, "*"); // reader content may live in an iframe
  }
  // A page turn re-renders the page right after the click/key, so "dom" would
  // otherwise overwrite the user action and the background wouldn't cancel the
  // in-flight request.
  if (userAction || !pendingReason) pendingReason = reason;
  clearTimeout(timer);
  // Wait for the page-turn animation and image rendering to settle.
  timer = setTimeout(() => {
    const sent = pendingReason;
    pendingReason = null;
    try {
      chrome.runtime.sendMessage({ type: "pageTurned", reason: sent });
    } catch (_) {
      // Extension was reloaded; this content script is orphaned.
    }
  }, 1200);
}

document.addEventListener(
  "keydown",
  (e) => {
    if (["ArrowLeft", "ArrowRight", "PageUp", "PageDown", " ", "Enter"].includes(e.key)) notify("key");
  },
  true
);

document.addEventListener("click", () => notify("click"), true);

document.addEventListener("wheel", () => notify("wheel"), { capture: true, passive: true });

window.addEventListener("resize", () => notify("resize"));

new MutationObserver((mutations) => {
  // Ignore tiny changes (cursor blink, tooltips); react to real re-renders.
  let significant = 0;
  for (const m of mutations) {
    if (isOverlayNode(m.target) || [...m.addedNodes, ...m.removedNodes].some(isOverlayNode)) continue;
    significant += m.addedNodes.length + m.removedNodes.length;
    if (m.type === "attributes" && (m.attributeName === "src" || m.attributeName === "style")) significant++;
  }
  if (significant >= 2) notify("dom", false);
}).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["src", "style"],
});

// ---- Overlay (top frame only) ----

let root = null;
let turn = 0; // bumped on every page-turn hint; stale overlays are dropped

function isOverlayNode(node) {
  return root !== null && (node === root || root.contains(node));
}

function onTurnHint() {
  turn++;
  clearOverlay();
}

function ensureRoot() {
  if (root) return root;
  root = document.createElement("div");
  root.id = "kindle-translator-overlay";
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none", // clicks still reach the reader (page turns, menus)
  });
  document.documentElement.append(root);
  return root;
}

function clearOverlay() {
  root?.replaceChildren();
}

function showOverlay(blocks) {
  const el = ensureRoot();
  el.replaceChildren();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 3; // cover anti-aliased edges of the original glyphs
  const rects = blocks.map((b) => ({ x0: b.box[0] * vw, y0: b.box[1] * vh, x1: b.box[2] * vw, y1: b.box[3] * vh }));
  const body = blocks.map((b, i) => ({ b, r: rects[i] })).filter(({ b }) => b.kind !== "heading");
  // Height of one line of the original text. Claude reports each block's line
  // count; guessing it from box heights alone failed on pages split into a
  // few large blocks (every block looked "one line tall").
  const perLine = body.filter(({ b }) => b.lines).map(({ b, r }) => (r.y1 - r.y0) / b.lines).sort((a, c) => a - c);
  const lineHeight = perLine.length
    ? perLine[perLine.length >> 1]
    : Math.min(...body.map(({ r }) => r.y1 - r.y0)); // blocks cached before `lines` existed
  const boxes = [];
  blocks.forEach((b, i) => {
    const r = rects[i];
    // Single lines (dialogue, short quotes) get a tighter line-height and more
    // width; with the paragraph line-height of 1.5 they shrank.
    const single = b.kind !== "heading" && (b.lines ? b.lines === 1 : r.y1 - r.y0 < lineHeight * 1.6);
    // Claude's boxes hug the glyphs, some tighter than others, which left no
    // room for a full line. Grow each box into the blank space between it and
    // its neighbours in the same column: halfway to them, at most half a line,
    // and not at all past the first/last block (title bar, progress bar).
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
    box.textContent = b.text;
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

if (IS_TOP) {
  window.addEventListener("message", (e) => {
    if (e.data?.type === TURN_MSG) onTurnHint();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "clearOverlay") {
      clearOverlay();
      sendResponse({ turn });
    } else if (msg.type === "overlay") {
      if (msg.turn !== undefined && msg.turn !== turn) {
        sendResponse({ shown: false, reason: "請求期間翻頁了，已丟棄舊頁的譯文" });
      } else if (!msg.blocks.length) {
        sendResponse({ shown: false, reason: "Claude 沒有在這張截圖裡找到內文區塊" });
      } else {
        showOverlay(msg.blocks);
        sendResponse({ shown: true });
      }
    }
  });
}
