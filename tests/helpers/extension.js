// Runs background.js against fakes for everything around it: the Kindle tab
// (screen + content script), the offscreen OCR document, the side panel and
// the Claude API. Flow tests drive it like a user would: open the panel, turn
// pages, press the button, and then look at what was sent where.

const { loadScripts, waitFor, plain } = require("./load");
const { createChrome } = require("./chrome");
const { createClaude } = require("./claude");
const { imageGlobals, screenUrl, decodeDrawn } = require("./images");

const READER_TAB = { id: 1, windowId: 1, url: "https://read.amazon.com/?asin=B0TESTBOOK", active: true };

// The book's text per page; pages not listed get generated paragraphs.
function defaultParagraphs(page) {
  return [1, 2, 3, 4].map((i) => `${page} paragraph ${i}. ${"Lorem ipsum dolor sit amet ".repeat(4).trim()}.`);
}

// OCR lines (as offscreen.js returns them) and layout regions for one
// column's paragraphs, in the OCR image's pixels.
function ocrColumn(paragraphs, rect) {
  const lines = [];
  const regions = [];
  let y = 20;
  for (const text of paragraphs) {
    const words = text.split(" ");
    const rows = [];
    let row = "";
    for (const w of words) {
      if (row && (row + " " + w).length > 48) {
        rows.push(row);
        row = w;
      } else row = row ? `${row} ${w}` : w;
    }
    if (row) rows.push(row);
    const top = y;
    rows.forEach((r, i) => {
      const x0 = rect.left + 10 + (i === 0 ? 24 : 0);
      lines.push({ x0, y0: y, x1: Math.min(rect.left + rect.width - 10, x0 + r.length * 8), y1: y + 16, text: r, confidence: 92, maxGap: 9, firstWord: 40 });
      y += 24;
    });
    regions.push({ cls: "plain text", conf: 0.9, x0: rect.left + 5, y0: top - 3, x1: rect.left + rect.width - 5, y1: y - 5 });
    y += 12;
  }
  return { lines, regions };
}

const tick = () => new Promise((r) => setTimeout(r, 1));

function startExtension({ settings = {}, session = {}, panel = true, page = "p1", book = {}, screen = {}, claude: handler } = {}) {
  const chrome = createChrome({ sync: { apiKey: "sk-ant-test", ...settings }, session, asyncPorts: true });
  const claude = createClaude(handler);
  const images = imageGlobals();
  // The test-screenshot receiver (tests/tools/receive-fixtures.js).
  const received_shots = [];
  const receiver = async (url, init) => {
    received_shots.push({ url, body: JSON.parse(init.body) });
    return { ok: ext.receiverStatus === 200, status: ext.receiverStatus };
  };
  const ctx = loadScripts(["background.js"], {
    chrome,
    fetch: (url, init) =>
      url.startsWith("data:")
        ? images.fetchDataUrl(url)
        : url.startsWith("http://127.0.0.1:")
          ? receiver(url, init)
          : claude.fetch(url, init),
    createImageBitmap: images.createImageBitmap,
    OffscreenCanvas: images.OffscreenCanvas,
  });

  // The Kindle tab: what's on screen, and its content script's overlay.
  const tab = {
    page,
    screen: { ...screen },
    turn: 0,
    overlay: null, // blocks drawn
    enabled: true,
    // Called for the "overlay" message; return a reply to override.
    onOverlay: null,
    // What content.js's pageGeometry reports: the book page image covering
    // 10–90% of the 960×600 screen (the synthetic text sits inside it).
    geometry: { viewport: { width: 960, height: 600 }, dpr: 1, page: { left: 96, top: 60, right: 864, bottom: 540 } },
  };
  chrome._.activeTab = { ...READER_TAB };
  chrome._.screen = () => screenUrl({ ...tab.screen, page: tab.page, overlay: tab.overlay && tab.enabled ? tab.overlay.page : null });
  chrome._.tabMessageHandler = async (tabId, msg) => {
    switch (msg.type) {
      case "clearOverlay":
        tab.overlay = null;
        return { turn: tab.turn };
      case "overlayState":
        return { shown: tab.enabled && !!tab.overlay };
      case "overlay": {
        if (tab.onOverlay) {
          const r = await tab.onOverlay(msg);
          if (r) return r;
        }
        if (msg.turn !== undefined && msg.turn !== tab.turn) return { shown: false, reason: "請求期間翻頁了，已丟棄舊頁的譯文" };
        if (!msg.blocks.length) return { shown: false, reason: "Claude 沒有在這張截圖裡找到內文區塊" };
        tab.overlay = { page: tab.page, blocks: msg.blocks };
        return { shown: true };
      }
      case "geometry":
        return tab.geometry;
      case "debugLog":
        return undefined;
    }
    throw new Error(`unexpected tab message ${msg.type}`);
  };

  // The offscreen document: OCR of the page that was drawn into the PNG.
  const ocr = { calls: [], handler: null, ms: 7 };
  chrome._.runtimeMessageHandler = async (msg) => {
    if (msg.target !== "offscreen" || msg.type !== "ocr") return undefined;
    const drawn = decodeDrawn(msg.image);
    ocr.calls.push({ ...msg, drawn });
    if (ocr.handler) {
      const r = await ocr.handler(msg, drawn);
      if (r) return r;
    }
    const pageName = drawn.screen.page;
    const paras = book[pageName] ?? defaultParagraphs(pageName);
    const perColumn = msg.rects.length > 1 ? [paras.slice(0, Math.ceil(paras.length / 2)), paras.slice(Math.ceil(paras.length / 2))] : [paras];
    const cols = msg.rects.map((rect, i) => ocrColumn(perColumn[i] || [], rect));
    return { columns: cols.map((c) => c.lines), layout: { regions: cols.map((c) => c.regions), ms: ocr.ms } };
  };

  // Side panel: everything the worker posts to it.
  const received = [];
  let port = null;
  function openPanel() {
    chrome._.contexts.SIDE_PANEL = 1;
    port = chrome.runtime.connect({ name: "sidepanel" });
    port.onMessage.addListener((m) => received.push(m));
    return port;
  }
  function closePanel() {
    chrome._.contexts.SIDE_PANEL = 0;
    port?.disconnect();
    port = null;
  }
  if (panel) openPanel();

  const ext = {
    ctx,
    shots: received_shots,
    receiverStatus: 200,
    chrome,
    claude,
    tab,
    ocr,
    book,
    received,
    openPanel,
    closePanel,
    get port() {
      return port;
    },
    // Panel messages of a type, e.g. ext.msgs("result").
    msgs: (type) => received.filter((m) => m.type === type),
    logs: () => received.filter((m) => m.type === "log").map((m) => m.text),
    hasLog: (re) => received.some((m) => m.type === "log" && re.test(m.text)),
    // What overlays were sent to the page.
    overlaysSent: () => chrome._.tabMessages.filter((m) => m.msg.type === "overlay").map((m) => m.msg),
    // A page-turn hint from the content script, as the user turns to `toPage`.
    async turnTo(toPage, reason = "key") {
      if (toPage !== undefined) {
        tab.page = toPage;
        if (reason !== "dom") {
          tab.turn++;
          tab.overlay = null; // a user action hides the overlay at once
        }
      }
      // What the onMessage listener hands it to; awaited here so the job has
      // started (the listener itself can't return the promise).
      await ctx.onPageTurned({ type: "pageTurned", reason }, { tab: { ...chrome._.activeTab } });
    },
    // The side panel's button (also Alt+T); resolves once the worker has it.
    async pressTranslate() {
      port.postMessage({ type: "translateNow" });
      await tick();
    },
    // Let messages in flight to the panel arrive.
    tick,
    // No job running, queued or in the background.
    async idle(timeout) {
      await waitFor(() => ctx.run("current === null && background.size === 0 && pending === null"), { timeout, what: "idle worker" });
      await new Promise((r) => setTimeout(r, 5));
      if (!ctx.run("current === null && background.size === 0 && pending === null")) return ext.idle(timeout);
    },
    async translate(opts = { force: true }) {
      await ctx.translateActivePage(opts);
      await ext.idle();
    },
    session: () => plain(Object.fromEntries(chrome.storage.session.data)),
    cachedPages: () => plain(chrome.storage.session.data.get("pageIndex") || []).length,
  };
  return ext;
}

module.exports = { startExtension, defaultParagraphs, ocrColumn, READER_TAB };
