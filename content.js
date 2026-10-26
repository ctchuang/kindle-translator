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
const DEV_CAPTURE = "kindle-translator-dev-capture";

let timer = null;
let pendingReason = null;

// userAction: a key/click/wheel/resize that may have turned the page, so the
// current overlay is stale. Plain DOM churn (toolbar fading, progress updates)
// only asks for a re-check; the background skips it if the screen is unchanged.
function notify(reason, userAction = true) {
  // Reloading the extension leaves this script running but cut off. Doing
  // nothing then matters: hiding the overlay without being able to ask the
  // background to redraw it left the page in English.
  if (!chrome.runtime?.id) return;
  if (userAction && !IS_TOP) {
    // The reader content may live in an iframe; the top frame owns the
    // overlay, so it hides it and reports the turn itself.
    window.top.postMessage({ type: TURN_MSG, reason }, "*");
    return;
  }
  if (userAction) onTurnHint();
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

document.addEventListener("click", (e) => isToggle(e.target) || notify("click"), true);

document.addEventListener("wheel", () => notify("wheel"), { capture: true, passive: true });

// The reader fires resize events when its toolbar slides in or out, without
// the page moving. Only a real change of the top window's size moves the
// text; anything else is just a re-check, which keeps the overlay up.
let lastSize = `${innerWidth}x${innerHeight}`;
window.addEventListener("resize", () => {
  const size = `${innerWidth}x${innerHeight}`;
  const changed = size !== lastSize;
  lastSize = size;
  if (IS_TOP && changed) notify("resize");
  else notify("dom", false);
});

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
let enabled = true; // the side panel's translation / original switch

function isOverlayNode(node) {
  return (root !== null && (node === root || root.contains(node))) || isToggle(node);
}

// ---- Floating translation / original button (top frame only) ----

// It sits in the bottom-right corner, outside the areas the background hashes
// and OCRs, so its label changing doesn't look like a new page.
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
    bottom: "8px", // ~32px tall: stays below the OCR crop (bottom 6%) in a 540px+ tall window
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

function onTurnHint() {
  turn++;
  clearOverlay();
}

function ensureRoot() {
  if (root) return root;
  document.getElementById("kindle-translator-overlay")?.remove(); // left by a script orphaned by a reload
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

// Turning the switch to "original" only hides the overlay, so switching back
// shows the same page's translation instantly (the background then checks
// it still matches the screen).
function applyEnabled() {
  if (root) root.style.display = enabled ? "" : "none";
  showToggle();
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

// Where the reader draws the book (one image per page, two side by side on
// a spread), in CSS pixels, so the background OCRs just that area: a fixed
// share of the screen cut through the first line in tall windows and took in
// the title bar in short ones. page is null in a reader mode without images.
function pageGeometry() {
  let page = null;
  for (const el of document.querySelectorAll("img, canvas")) {
    if (root?.contains(el)) continue;
    const r = el.getBoundingClientRect();
    // Skip icons, covers in menus and anything off screen.
    if (r.width < innerWidth * 0.15 || r.height < innerHeight * 0.3) continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
    page = page
      ? { left: Math.min(page.left, r.left), top: Math.min(page.top, r.top), right: Math.max(page.right, r.right), bottom: Math.max(page.bottom, r.bottom) }
      : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  // Whole pixels: the fingerprint's size follows this box, and a sub-pixel
  // wobble between two reports must not make the same page look different.
  if (page) for (const k of Object.keys(page)) page[k] = Math.round(page[k]);
  return { viewport: { width: innerWidth, height: innerHeight }, dpr: window.devicePixelRatio || 1, page };
}

if (IS_TOP) {
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
    if (e.data?.type === TURN_MSG) notify(e.data.reason || "frame");
    // A test tool driving this page asks for a test screenshot (the
    // background refuses unless the options page's developer switch is on).
    if (e.data?.type === DEV_CAPTURE && e.source === window) {
      const { id, name } = e.data;
      const reply = (r) => window.postMessage({ type: `${DEV_CAPTURE}-result`, id, ...r }, location.origin);
      chrome.runtime.sendMessage({ type: "devCapture", name }).then(reply, (err) => reply({ ok: false, error: String(err?.message || err) }));
    }
  });

  // Reply once the change is on screen: the background takes a screenshot
  // next, and a fixed short wait sometimes caught the old overlay still
  // painted (a large page at 3x takes a while), so OCR read our own Chinese.
  // A frame callback runs before the next paint; the second one runs after
  // it. The timeout covers a hidden tab, which doesn't paint at all.
  const afterPaint = (reply) => {
    let done = false;
    const send = () => done || ((done = true), reply());
    requestAnimationFrame(() => requestAnimationFrame(send));
    setTimeout(send, 500);
    return true; // keep the channel open for the async reply
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "clearOverlay") {
      clearOverlay();
      return afterPaint(() => sendResponse({ turn }));
    } else if (msg.type === "debugLog") {
      console.log(`[Kindle 翻譯] ${msg.text}`);
    } else if (msg.type === "geometry") {
      sendResponse(pageGeometry());
    } else if (msg.type === "overlayState") {
      sendResponse({ shown: enabled && !!root?.childElementCount });
    } else if (msg.type === "overlay") {
      if (msg.turn !== undefined && msg.turn !== turn) {
        sendResponse({ shown: false, reason: "請求期間翻頁了，已丟棄舊頁的譯文" });
      } else if (!msg.blocks.length) {
        sendResponse({ shown: false, reason: "Claude 沒有在這張截圖裡找到內文區塊" });
      } else {
        showOverlay(msg.blocks);
        return afterPaint(() => sendResponse({ shown: true }));
      }
    }
  });
}
