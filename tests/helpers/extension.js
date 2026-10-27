// Runs background.js against fakes for everything around it: the Kindle tab
// (its content script, answering from a synthetic book's page data), the
// offscreen OCR document, the side panel and the Claude API. Flow tests drive
// it like a user would: open the panel, show screens, press the button, and
// then look at what was sent where.

const { loadScripts, waitFor, plain } = require("./load");
const { createChrome } = require("./chrome");
const { createClaude } = require("./claude");
const { makeBook, words } = require("./kindle");
const R = require("../../page-render.js");

const READER_TAB = { id: 1, windowId: 1, url: "https://read.amazon.com/?asin=B0TESTBOOK", active: true };

const tick = () => new Promise((r) => setTimeout(r, 1));

// A book whose screens hold six to eight paragraphs, with a chapter heading
// now and then.
function testBook(opts = {}) {
  return makeBook({ paragraphs: Array.from({ length: 80 }, (_, i) => (i % 20 === 0 ? { text: `Chapter ${i / 20 + 1}`, heading: true } : `${words(i, 8 + (i % 5) * 3)}.`)), ...opts });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What content.js reports for a screen.
function screenInfo(layout, page) {
  return {
    key: layout.key,
    start: page.startPositionId,
    end: page.endPositionId,
    asin: layout.params.asin,
    revision: layout.params.revision,
    width: page.width,
    height: page.height,
    fill: R.cssColor(page.fillColor, "#ffffff"),
    ink: R.cssColor(page.inkColor, "#000000"),
  };
}

// The text OCR reads in each of a screen's paragraphs (what the background
// sends to Claude), in paragraph order.
function paragraphTexts(layout, page) {
  const runs = page.children.filter((c) => c.type === "run");
  return R.pageParagraphs(page).map((p) =>
    runs
      .filter((r) => (r.elementId ?? `@${r.startPositionId}`) === p.id)
      .map((r) => layout.lineText.get(r.startPositionId))
      .join(" ")
  );
}

// The canvas and bitmap the vision engine's prepareImage uses.
function visionImages() {
  return {
    async createImageBitmap(blob) {
      return { width: blob.width ?? 2000, height: blob.height ?? 1400 };
    },
    OffscreenCanvas: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage() {} };
      }
      async convertToBlob({ type }) {
        return new Blob([JSON.stringify({ type, width: this.width, height: this.height })], { type });
      }
    },
  };
}

function startExtension({ settings = {}, session = {}, panel = true, book = testBook(), layout: layoutOpts = {}, claude: handler } = {}) {
  const chrome = createChrome({ sync: { apiKey: "sk-ant-test", prefetch: false, ...settings }, session, asyncPorts: true });
  const claude = createClaude(handler);
  const images = visionImages();
  // The page-data receiver (tests/tools/receive-pages.js).
  const receiverPosts = [];
  const ctx = loadScripts(["background.js"], {
    chrome,
    fetch: async (url, init) => {
      if (url.startsWith("data:")) return { ok: true, status: 200, blob: async () => ({ width: ext.shot.width, height: ext.shot.height }) };
      if (url.startsWith("http://127.0.0.1:")) {
        receiverPosts.push({ url, body: JSON.parse(init.body) });
        return { ok: ext.receiverStatus === 200, status: ext.receiverStatus };
      }
      return claude.fetch(url, init);
    },
    createImageBitmap: images.createImageBitmap,
    OffscreenCanvas: images.OffscreenCanvas,
  });

  // The Kindle tab: which screen it shows, and its content script.
  const first = book.layout(layoutOpts);
  const tab = {
    book,
    layout: first,
    layouts: new Map([[first.key, first]]),
    index: 0,
    error: null, // what currentPage answers instead of a screen
    overlay: null, // the overlay message drawn
    enabled: true,
    cleared: 0,
    // Hooks: return a reply to override the default.
    onOverlay: null,
    onPageData: null,
    // content.js's pageGeometry: the page image (300×200 CSS px at ×2) in a 1000×700 viewport.
    geometry: { viewport: { width: 1000, height: 700 }, dpr: 2, page: { left: 200, top: 150, right: 800, bottom: 550 } },
    dump: null,
  };
  const screen = () => tab.layout.screens[tab.index];
  chrome._.activeTab = { ...READER_TAB };
  chrome._.screen = () => "data:image/jpeg;base64,c2NyZWVu";
  chrome._.tabMessageHandler = async (tabId, msg) => {
    switch (msg.type) {
      case "currentPage":
        return tab.error ? { error: tab.error } : { page: screenInfo(tab.layout, screen()) };
      case "pageData": {
        if (tab.onPageData) {
          const r = await tab.onPageData(msg);
          if (r) return r;
        }
        const layout = tab.layouts.get(msg.key);
        if (!layout) return { error: "這個版面的頁面資料已經不在了" };
        let page = layout.screens.find((s) => s.startPositionId === msg.start);
        if (msg.next) {
          const after = page && R.screenAfter(layout.screens, msg.start);
          page = after && after.startPositionId - page.endPositionId <= 5 ? after : null;
        }
        if (!page) return { error: msg.next ? "頁面資料裡還沒有下一頁" : "頁面資料裡沒有這一頁" };
        const out = { page: screenInfo(layout, page), paragraphs: plain(R.pageParagraphs(page)), columns: R.pageColumns(page) };
        if (msg.image) {
          out.image = `data:image/png;base64,${Buffer.from(JSON.stringify({ key: layout.key, start: page.startPositionId })).toString("base64")}`;
          out.scale = Number(layout.params.rasterScale);
        }
        return out;
      }
      case "overlay": {
        if (tab.onOverlay) {
          const r = await tab.onOverlay(msg);
          if (r) return r;
        }
        const now = screenInfo(tab.layout, screen());
        if (msg.page?.key !== now.key || msg.page?.start !== now.start) return { shown: false, stale: true, reason: "畫面已經換頁，這份譯文不畫" };
        if (!msg.blocks.length) return { shown: false, reason: "這一頁沒有可以畫的譯文" };
        tab.overlay = msg;
        return { shown: true };
      }
      case "overlayState":
        return { shown: tab.enabled && !!tab.overlay };
      case "clearOverlay":
        tab.overlay = null;
        tab.cleared++;
        return {};
      case "geometry":
        return tab.geometry;
      case "dumpPage":
        return tab.dump ?? { filename: `kindle-B0TESTBOOK-${screen().startPositionId}.json`, data: { params: tab.layout.params, page: screen(), fonts: {} } };
      case "debugLog":
        return undefined;
    }
    throw new Error(`unexpected tab message ${msg.type}`);
  };

  // The offscreen document: the lines Tesseract would read in each column
  // of the drawn screen, in image pixels.
  const ocr = { calls: [], handler: null };
  chrome._.runtimeMessageHandler = async (msg) => {
    if (msg.target !== "offscreen" || msg.type !== "ocr") return undefined;
    const drawn = JSON.parse(Buffer.from(msg.image.split(",")[1], "base64").toString());
    ocr.calls.push({ ...msg, drawn });
    if (ocr.handler) {
      const r = await ocr.handler(msg, drawn);
      if (r) return r;
    }
    const layout = tab.layouts.get(drawn.key);
    const page = layout.screens.find((s) => s.startPositionId === drawn.start);
    const scale = Number(layout.params.rasterScale);
    const lines = page.children
      .filter((c) => c.type === "run")
      .map((r) => {
        const b = R.boxOf(r);
        return { x0: b.x0 * scale, y0: b.y0 * scale, x1: b.x1 * scale, y1: b.y1 * scale, text: layout.lineText.get(r.startPositionId), confidence: 92 };
      });
    return {
      columns: msg.rects.map((rect) => lines.filter((l) => (l.x0 + l.x1) / 2 >= rect.left && (l.x0 + l.x1) / 2 < rect.left + rect.width)),
    };
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

  const busy = () => ctx.run("current !== null || background.size > 0 || prefetching !== null");

  const ext = {
    ctx,
    chrome,
    claude,
    tab,
    ocr,
    book,
    received,
    receiverPosts,
    receiverStatus: 200,
    shot: { width: 2000, height: 1400 },
    openPanel,
    closePanel,
    get port() {
      return port;
    },
    // The layout and screen on show.
    get layout() {
      return tab.layout;
    },
    screen,
    info: (index = tab.index, layout = tab.layout) => screenInfo(layout, layout.screens[index]),
    texts: (index = tab.index, layout = tab.layout) => paragraphTexts(layout, layout.screens[index]),
    // Panel messages of a type, e.g. ext.msgs("result").
    msgs: (type) => received.filter((m) => m.type === type),
    logs: () => received.filter((m) => m.type === "log").map((m) => m.text),
    hasLog: (re) => received.some((m) => m.type === "log" && re.test(m.text)),
    // What overlays were sent to the page.
    overlaysSent: () => chrome._.tabMessages.filter((m) => m.msg.type === "overlay").map((m) => m.msg),
    // The reader shows screen `index` (of `layout`, which becomes the
    // current layout): content.js clears its overlay and reports it.
    async show(index, layout = tab.layout) {
      if (!tab.layouts.has(layout.key)) tab.layouts.set(layout.key, layout);
      tab.layout = layout;
      tab.index = index;
      tab.error = null;
      tab.overlay = null;
      await ctx.onPageShown({ type: "pageShown", page: screenInfo(layout, layout.screens[index]), tried: 2, ms: 5 }, { tab: { ...chrome._.activeTab } });
      await tick(); // let what it posted reach the panel
    },
    // content.js couldn't identify the screen.
    async showError(error) {
      tab.error = error;
      tab.overlay = null;
      await ctx.onPageShown({ type: "pageShown", error }, { tab: { ...chrome._.activeTab } });
      await tick();
    },
    // A layout of the same book (another font size, theme…), known to the tab.
    relayout(opts) {
      const l = book.layout(opts);
      tab.layouts.set(l.key, l);
      return l;
    },
    // The side panel's button (also Alt+T); resolves once the worker has it.
    async pressTranslate() {
      port.postMessage({ type: "translateNow" });
      await tick();
    },
    tick,
    sleep,
    // Nothing running, and nothing about to start (the settle and prefetch
    // timers are 24 and 40 ms in test time).
    async idle(timeout = 4000) {
      const until = Date.now() + timeout;
      for (;;) {
        await waitFor(() => !busy(), { timeout: Math.max(1, until - Date.now()), what: "idle worker" });
        await sleep(150);
        if (!busy()) return;
      }
    },
    async translate(opts = { force: true }) {
      await ctx.translateActivePage(opts);
      await ext.idle();
    },
    session: () => plain(Object.fromEntries(chrome.storage.session.data)),
    cachedParas: () => [...chrome.storage.session.data.keys()].filter((k) => k.startsWith("para:")),
    cachedScreens: () => [...chrome.storage.session.data.keys()].filter((k) => k.startsWith("page:")),
  };
  return ext;
}

module.exports = { startExtension, screenInfo, paragraphTexts, testBook, READER_TAB };
