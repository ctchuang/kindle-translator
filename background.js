// Service worker: translates the screen Kindle Cloud Reader shows. The page
// script (content.js) says which screen that is ("pageShown", from the
// reader's own page data) and hands over its paragraphs and a clean drawing
// of it. Two engines:
// - "ocr": Tesseract reads each paragraph locally, then Haiku translates the
//   text alone, optionally with Sonnet reviewing the draft. Fast, and the
//   model never sees a book page. Translations are cached per paragraph, by
//   its position range in the book, so they're reused whatever the layout.
// - "vision": Opus reads a screenshot and translates it in one call.
// See docs/design.md and docs/page-pipeline-v2.md.

importScripts("ocr-layout.js", "styled-text.js", "context-pages.js");

// Vision engine: only Opus. In testing, Sonnet 5.5 and Haiku 5.5 declined to
// translate screenshots of Kindle book pages (citing copyright).
const MODEL = "claude-opus-5-5";

// OCR engine: models for translating and reviewing plain text, with the
// lowest thinking setting each accepts (a straight translation; thinking only
// adds latency). Sonnet 5.5 rejects "disabled".
const TEXT_MODELS = {
  "claude-sonnet-5-5": { type: "between_tools" },
  "claude-haiku-5-5": { type: "disabled" },
};

// Translation quality levels (options page): who drafts, and who reviews the
// draft. The reviewer returns only the paragraphs it changes, which keeps its
// output, and so its latency and cost, small.
const QUALITY = {
  haiku: { translate: "claude-haiku-5-5" },
  review: { translate: "claude-haiku-5-5", review: "claude-sonnet-5-5" },
};

// Server-side fallback when a safety classifier declines the request.
// Opus 5.5 runs a biology classifier that Opus 5 doesn't, so "default"
// routing can leave benign pages (e.g. a history of biological warfare)
// declined; naming Opus 5 / Opus 4.8 explicitly retries them there.
const FALLBACK = {
  beta: "server-side-fallback-2026-06-01",
  fallbacks: [{ model: "claude-opus-5" }, { model: "claude-opus-4-8" }],
};

const DEFAULTS = {
  apiKey: "",
  engine: "ocr",
  quality: "review",
  effort: "low",
  autoTranslate: true,
  prefetch: true,
  referencePages: false,
  referenceTokens: 16000,
  targetLang: "繁體中文（台灣用語）",
  overlay: true,
};

// Image size we send. Within the model's limits, returned coordinates map 1:1
// to our pixels; above either limit the API downscales again and every box
// shrinks toward the top-left (seen: 2576×1593 = 4.1 MP came back at ~0.956×).
// The pixel cap sits a little under the documented 3.75 MP.
const MAX_EDGE = 2576;
const MAX_PIXELS = 3_700_000;

const API_TIMEOUT_MS = 180_000;

// A screen's translation is only requested once it has stayed on screen this
// long, so pages flipped past quickly are never sent. Drawing a cached
// translation doesn't wait.
const SETTLE_MS = 1200;

// The next screen is translated ahead once the current one has been on
// screen this long (and is translated), so flipping through translated pages
// doesn't start and cancel a request on each.
const PREFETCH_DWELL_MS = 2000;

// Claude sometimes answers a page with a summary instead of a translation,
// citing copyright, and the same page often translates fine on the next
// try. Retry that many times; after that show the summary, uncached.
const SUMMARY_RETRIES = 1;

const READER_RE = /^https:\/\/read\.amazon\.(com|co\.jp|co\.uk|de|ca|com\.au)\//;

let panelPorts = new Set();

// Jobs. The foreground job translates the screen on show; only it draws. When
// the reader moves on, it isn't cancelled but moved to the background: it
// finishes, fills the cache, and its paragraphs are then free wherever they
// show up again. A prefetch job translates the next screen ahead. Each job:
// { kind: "page" | "prefetch", page (screen), force, controller (cancels its
// OCR wait and API calls), detached, done }.
let current = null;
const background = new Set();
let prefetching = null;
// Translations being requested, by paragraph cache key, so a job that needs
// a paragraph another job is already paying for waits for it instead.
const inflight = new Map();
// Screens being read (OCR), by record key, for the same reason.
const reading = new Map();
// Screens turned past while translating keep going, up to this many; beyond
// it the oldest is cancelled, so paging on doesn't pile up requests.
const MAX_BACKGROUND = 1;

let settleTimer = null;
let prefetchTimer = null;

// ---- Screens ----

// A screen as content.js names it: { key (layout), start, end (position
// range), asin, revision, width, height (CSS px), fill, ink }, plus the tab
// it's in ({ tabId, windowId }) once the worker knows it.
function screenId(page) {
  return page ? `${page.key}|${page.start}` : null;
}

function sameScreen(a, b) {
  return !!a && !!b && screenId(a) === screenId(b);
}

function describeScreen(page) {
  return `位置 ${page.start}–${page.end}`;
}

// Chrome stops this service worker after ~30 s idle, wiping module state, so
// what's on screen, what's drawn and the cache live in session storage
// (cleared when the browser closes).
async function getShown() {
  return (await chrome.storage.session.get("shown")).shown ?? null;
}

async function setShown(page) {
  if (page) await chrome.storage.session.set({ shown: page });
  else await chrome.storage.session.remove("shown");
}

// The screen whose translation is on the page (or, with the overlay off, in
// the side panel). While it's the one on screen, the side panel's button
// retranslates (skipping the cache) and is labelled that way.
async function getDrawn() {
  return (await chrome.storage.session.get("drawn")).drawn ?? null;
}

async function setDrawn(page) {
  if (page) await chrome.storage.session.set({ drawn: screenId(page) });
  else await chrome.storage.session.remove("drawn");
  broadcast({ type: "pageState", retranslate: !!page });
}

// ---- Cache ----

// Per paragraph: { source, text, savedAt } under its position range in the
// book, the same in any layout (plus a hash of the highlights over it, which
// the reader can add or remove any time). Per screen: how the screen splits
// into paragraphs, with their boxes and OCR words (its "record"), under the
// layout key and its start. The vision engine's whole-screen results under
// vision:.
const CACHE_PARAS = 5000;
const CACHE_PAGES = 500;
let cacheChain = Promise.resolve(); // index updates one at a time

function paraKey(page, p) {
  return `para:${page.asin}:${page.revision}:${p.start}-${p.end}`;
}

// Whether a record paragraph has any words to translate.
function hasText(p) {
  return (p.words || []).length > 0;
}

// A record paragraph as sent to Claude: its words, the italic and bold ones
// and those under a highlight marked (<i>, <b>, <h1>, <h2>… one number per
// highlight colour, docs/text-styles.md), the colour of each highlight mark,
// and its cache key, which changes with the highlights over it.
function paraSource(page, p) {
  const highlights = (page.highlights || []).filter((h) => h.start <= p.end && h.end >= p.start);
  const colors = [...new Set(highlights.map((h) => h.color))];
  const marks = Object.fromEntries(colors.map((c, i) => [`h${i + 1}`, c]));
  const words = (p.words || []).map((w) => {
    const styles = [...(w.styles || [])];
    for (const h of highlights) if (h.boxes.some((b) => centreIn(w, b))) styles.push(`h${colors.indexOf(h.color) + 1}`);
    return { text: w.text, styles };
  });
  const source = words.some((w) => w.styles.length) ? tagWords(words) : wordsText(words);
  const marked = highlights.length ? `:h${hashOf(highlights.map((h) => `${h.start}-${h.end}-${h.color}`).sort().join(";"))}` : "";
  return { key: paraKey(page, p) + marked, source, marks };
}

function centreIn(w, b) {
  const x = (w.x0 + w.x1) / 2;
  const y = (w.y0 + w.y1) / 2;
  return x >= b.x0 - 2 && x <= b.x1 + 2 && y >= b.y0 - 2 && y <= b.y1 + 2;
}

function hashOf(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function recordKey(page) {
  return `page:${page.key}:${page.start}`;
}

function visionKey(page) {
  return `vision:${page.key}:${page.start}`;
}

// Store `items` (key → value) and keep the newest CACHE_PARAS paragraphs and
// CACHE_PAGES screens.
function cacheWrite(items) {
  const run = cacheChain.then(async () => {
    const { cacheIndex = { paras: [], pages: [] } } = await chrome.storage.session.get("cacheIndex");
    for (const key of Object.keys(items)) {
      const list = key.startsWith("para:") ? cacheIndex.paras : cacheIndex.pages;
      const i = list.indexOf(key);
      if (i >= 0) list.splice(i, 1);
      list.push(key);
    }
    const dropped = [
      ...cacheIndex.paras.splice(0, Math.max(0, cacheIndex.paras.length - CACHE_PARAS)),
      ...cacheIndex.pages.splice(0, Math.max(0, cacheIndex.pages.length - CACHE_PAGES)),
    ];
    const kept = { ...items };
    for (const key of dropped) delete kept[key]; // past the limit in this very write
    if (dropped.length) await chrome.storage.session.remove(dropped);
    try {
      await chrome.storage.session.set({ ...kept, cacheIndex });
    } catch (err) {
      // Chrome caps session storage (10 MB), which the counts above can
      // outgrow on a long read: then nothing could be cached any more and
      // every screen failed. Make room and try once more.
      if (!/quota/i.test(err?.message || "")) throw err;
      const freed = [];
      for (const list of [cacheIndex.paras, cacheIndex.pages]) {
        const older = list.slice(0, Math.floor(list.length / 2)).filter((k) => !(k in items));
        freed.push(...older);
        for (const k of older) list.splice(list.indexOf(k), 1);
      }
      await chrome.storage.session.remove(freed);
      log(`快取空間已滿${await sessionBytes()}，丟掉較舊的一半（${freed.length} 筆）`);
      await chrome.storage.session.set({ ...kept, cacheIndex });
    }
  });
  cacheChain = run.catch(() => {});
  return run;
}

// "（用了 9.8 MB）", or nothing when Chrome can't say.
async function sessionBytes() {
  try {
    return `（用了 ${((await chrome.storage.session.getBytesInUse(null)) / 1048576).toFixed(1)} MB）`;
  } catch (_) {
    return "";
  }
}

async function cacheRead(keys) {
  return keys.length ? chrome.storage.session.get(keys) : {};
}

// The cached translation of each of the record's paragraphs that has text
// (blank for what Claude took for noise), as paragraph key → text; null
// when any is missing.
async function cachedTexts(page, record) {
  const keys = record.paras.filter(hasText).map((p) => paraSource(page, p).key);
  const have = await cacheRead(keys);
  const texts = new Map();
  for (const k of keys) if (have[k]) texts.set(k, have[k].text);
  return texts.size === keys.length ? texts : null;
}

// Whether everything `page` needs is in the cache (a screen without text
// needs nothing).
async function screenDone(page) {
  const record = (await chrome.storage.session.get(recordKey(page)))[recordKey(page)];
  return !!record && (!record.paras.some(hasText) || !!(await cachedTexts(page, record)));
}

// Draw `page` from the cache if everything it needs is there. `post`: also
// add it to the side panel's list (not when merely redrawing).
async function drawFromCache(page, settings, { post = true } = {}) {
  if (settings.engine === "vision") {
    const record = (await chrome.storage.session.get(visionKey(page)))[visionKey(page)];
    if (!record) return false;
    log(`命中快取（看圖模式，${record.paras.length} 個區塊），不呼叫 API`);
    await draw(page, record, (p) => p.text, { cached: true, post });
    return true;
  }
  const record = (await chrome.storage.session.get(recordKey(page)))[recordKey(page)];
  if (!record) return false;
  const texts = await cachedTexts(page, record);
  if (!texts) return false;
  log(`命中快取（${texts.size} 段），不呼叫 API`);
  await draw(page, record, (p) => texts.get(paraSource(page, p).key), { cached: true, post });
  return true;
}

// ---- Reference pages ----

// With the options page's switch on, two things are kept per book in local
// storage (context-pages.js):
// - the paragraphs drawn on screen (source and final translation), for a
//   week; the review is sent the ones before its page. Index refBooks.
// - the names the review settled on (source → translation), for 30 days
//   after each was last seen; every translation and review is sent the ones
//   on its page. Index nameBooks.
// An index maps each book's key to when it was last written, so books not
// read for that long are dropped too.
let bookChain = Promise.resolve(); // one read-modify-write at a time

function refKey(page) {
  return `ref:${page.asin}:${page.revision}`;
}

function namesKey(page) {
  return `names:${page.asin}:${page.revision}`;
}

// Read `key` (or `empty`), let `change(book, now)` edit it, write it back,
// and drop the books in `index` not written for `maxAge`.
function bookUpdate(key, index, maxAge, empty, change) {
  const run = bookChain.then(async () => {
    const now = Date.now();
    const { [key]: book = empty, [index]: books = {} } = await chrome.storage.local.get([key, index]);
    const out = change(book, now);
    const stale = Object.keys(books).filter((k) => k !== key && now - books[k] > maxAge);
    for (const k of stale) delete books[k];
    if (stale.length) await chrome.storage.local.remove(stale);
    await chrome.storage.local.set({ [key]: book, [index]: { ...books, [key]: now } });
    return out;
  });
  bookChain = run.catch(() => {});
  return run;
}

function refUpdate(page, change) {
  return bookUpdate(refKey(page), "refBooks", REF_MAX_AGE_MS, { paras: [], refStart: null }, change);
}

// The book's listed names that appear in `texts` ([{ source, text }]), or
// none: switch off, unknown book, nothing listed, or storage unreadable.
async function bookNames(settings, page, texts) {
  if (!settings.referencePages || !page?.asin) return [];
  try {
    const key = namesKey(page);
    const { [key]: book } = await chrome.storage.local.get(key);
    return namesIn(mergeNames(book?.names, [], Date.now()).names, texts);
  } catch (err) {
    log(`讀不到人名對照表（${err.message || err}），這次不用`);
    return [];
  }
}

// Add the names a review found; a name already listed keeps its translation.
async function saveNames(page, found, tag) {
  const res = await bookUpdate(namesKey(page), "nameBooks", NAMES_MAX_AGE_MS, { names: {} }, (book, now) => {
    const res = mergeNames(book.names, found, now);
    book.names = res.names;
    return res;
  });
  if (res.added.length) log(`${tag}人名對照表新增：${res.added.map((n) => `${n.source} → ${n.text}`).join("、")}`);
  if (res.conflicts.length) log(`${tag}人名對照表已有別的譯法，沿用原本的：${res.conflicts.map((c) => `${c.source} → ${c.kept}（這次是 ${c.text}）`).join("、")}`);
  return res;
}

// The review used another translation for a listed name (`conflicts` from
// mergeNames): put the listed one back in the paragraphs (`items`, { id,
// source }) where the name appears, in `texts` (id → text). A one-character
// translation is left alone (申 would hit 申請), as is one inside the
// listed name (拉夫 in 格拉夫). Returns how many were replaced.
function restoreNames(conflicts, items, texts) {
  let n = 0;
  for (const c of conflicts) {
    if ([...c.text].length < 2 || c.kept.includes(c.text)) continue;
    for (const p of items) {
      const text = texts.get(p.id);
      if (!text?.includes(c.text) || !namesIn({ [c.source]: { text: c.kept } }, [p.source]).length) continue;
      n += text.split(c.text).length - 1;
      texts.set(p.id, text.replaceAll(c.text, c.kept));
    }
  }
  return n;
}

// Keep the paragraphs of a screen just drawn (OCR engine only).
async function saveReference(page, record, textOf) {
  if (!page.asin) return;
  const paras = record.paras
    .filter(hasText)
    .map((p) => ({ start: p.start, end: p.end, source: paraSource(page, p).source, text: textOf(p) || "" }))
    .filter((p) => stripMarks(p.text).trim());
  if (!paras.length) return;
  await refUpdate(page, (book, now) => {
    book.paras = mergeParas(book.paras, paras, now);
  });
}

// The content blocks that put the book's earlier paragraphs before the
// review prompt, or null (logged why) when there are none to send. Cache
// breakpoints go on the last closed block, which stays the same until the
// set is trimmed, and on the last block.
async function referenceContent(settings, page, tag) {
  if (!page?.asin) {
    log(`${tag}校對沒有參考前面的頁：不知道是哪一本書`);
    return null;
  }
  const max = Math.min(100_000, Math.max(2000, Number(settings.referenceTokens) || DEFAULTS.referenceTokens));
  const pick = await refUpdate(page, (book) => {
    const pick = pickReference(book.paras, page.start, book.refStart, max);
    book.refStart = pick.refStart;
    return pick;
  });
  if (!pick.paras.length) {
    log(`${tag}校對沒有參考前面的頁：這本書在${describeScreen(page)}之前還沒有翻過的段落`);
    return null;
  }
  const how = pick.trimmed ? "，超過上限，丟掉較舊的一半" : pick.reset ? "，重新起算" : "";
  log(`${tag}校對參考前面的頁：${pick.paras.length} 段（位置 ${pick.paras[0].start}–${pick.paras.at(-1).end}），約 ${pick.tokens} tokens${how}`);
  const blocks = referenceBlocks(pick.paras);
  const lastFull = blocks.findLastIndex((b) => b.full);
  return [
    { type: "text", text: REFERENCE_INTRO },
    ...blocks.map((b, i) => ({
      type: "text",
      text: b.text,
      ...((i === lastFull || i === blocks.length - 1) && { cache_control: { type: "ephemeral" } }),
    })),
  ];
}

const REFERENCE_INTRO = "以下是同一本書在這一頁之前、使用者已經讀過的段落，依書中的順序排列，每行一段：source 是原文，text 是已經定稿的譯文。這些段落只供參考，用來統一人名、專有名詞、稱呼和語氣。";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  injectIntoOpenReaders();
});

// Installing or reloading the extension cuts off the content scripts in tabs
// already open. Give those tabs live copies now. They missed the page data
// fetched so far, so the screen is known again from the reader's next batch,
// or after reloading the tab.
async function injectIntoOpenReaders() {
  const scripts = chrome.runtime.getManifest().content_scripts;
  for (const tab of await chrome.tabs.query({ url: scripts[0].matches })) {
    for (const cs of scripts) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: cs.js, world: cs.world || "ISOLATED" }).catch(() => {});
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  for (const msg of unsent.splice(0)) port.postMessage(msg);
  // Button label and "not translated yet" hint for a freshly opened panel.
  Promise.all([getShown(), getDrawn()])
    .then(([shown, drawn]) => port.postMessage({ type: "pageState", retranslate: !!shown && drawn === screenId(shown) }))
    .catch(() => {});
  port.onMessage.addListener((msg) => {
    if (msg.type === "translateNow") {
      log("手動翻譯：按下「翻譯這一頁」");
      translateActivePage({ force: true });
    }
    if (msg.type === "captureNow") savePageData(port);
  });
});

// Not an async listener: Chrome takes a listener's returned promise as its
// reply, so an async one answered every message, devCapture's included, with
// undefined before the right listener could.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "pageShown") onPageShown(msg, sender);
  if (msg.type === "pageLog") onPageLog(msg, sender);
});

// The reader shows another screen (or one couldn't be identified).
async function onPageShown(msg, sender) {
  const tab = sender.tab;
  if (!tab?.active) return;
  clearTimeout(settleTimer);
  clearTimeout(prefetchTimer);
  // The page cleared its overlay: it belonged to the screen that's gone.
  await setDrawn(null);
  if (msg.error) {
    await setShown(null);
    if (!(await panelOpen())) return;
    logTabId = tab.id;
    log(`無法辨識目前這一頁：${msg.error}`);
    broadcast({ type: "warn", text: msg.error });
    return;
  }
  const page = { ...msg.page, tabId: tab.id, windowId: tab.windowId };
  await setShown(page);
  // Only translate when the panel is open, so we don't spend tokens silently.
  if (!(await panelOpen())) return;
  logTabId = tab.id;
  const how = msg.tried ? `（比對 ${msg.tried} 個畫面，${msg.ms ?? "?"} 毫秒）` : "";
  if (msg.highlights) log(`螢光標記改變了（${describeScreen(page)}，${page.highlights?.length ?? 0} 個）`);
  else log(`畫面換到${describeScreen(page)}${how}`);
  if (current && !sameScreen(current.page, page)) detach(current);
  const settings = await getSettings();
  if (await drawFromCache(page, settings)) return;
  if (!settings.autoTranslate) return;
  if (current) return; // already translating this very screen
  settleTimer = setTimeout(async () => {
    if (sameScreen(await getShown(), page)) translateActivePage({ force: false });
  }, SETTLE_MS);
}

function onPageLog(msg, sender) {
  if (!sender.tab?.active) return;
  panelOpen().then((open) => open && log(msg.text));
}

// Whether a side panel is open. Not panelPorts: Chrome stops this worker
// after 30 s idle, and the message that wakes it arrives before the panel
// has reconnected, so a page turn after a pause would be dropped.
async function panelOpen() {
  if (panelPorts.size) return true;
  return (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).length > 0;
}

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === "toggle-overlay") {
    const { overlay } = await chrome.storage.sync.get({ overlay: DEFAULTS.overlay });
    await chrome.storage.sync.set({ overlay: !overlay }); // the page and side panel react to the change
    return;
  }
  if (cmd !== "translate-page") return;
  log("手動翻譯：Alt+T");
  translateActivePage({ force: true });
});

// Translation / original switch (side panel or the button on the page). The
// page hides and shows its overlay itself; a translation made while it was
// off was never drawn, so draw it from the cache when it comes back on.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.overlay?.newValue) redrawShown();
});

async function redrawShown() {
  const shown = await getShown();
  if (!shown || current) return;
  await drawFromCache(shown, await getSettings(), { post: false });
}

// Step-by-step trace shown at the bottom of the side panel. `image` (a data
// URL) is shown as a thumbnail under the line.
function log(text, image) {
  broadcast({ type: "log", text, at: Date.now(), image });
}

// Messages sent while the panel is reconnecting (the worker just woke up)
// are kept and delivered when it's back, so the log has no holes.
const unsent = [];

// The log also goes to the reader tab's console ("[Kindle 翻譯]"), so it can
// be read alongside the page's own state when debugging.
let logTabId = null;

function broadcast(msg) {
  if (msg.type === "log" && logTabId !== null) {
    chrome.tabs.sendMessage(logTabId, { type: "debugLog", text: `${new Date(msg.at).toTimeString().slice(0, 8)}.${String(msg.at % 1000).padStart(3, "0")} ${msg.text}` }, { frameId: 0 }).catch(() => {});
  }
  if (!panelPorts.size && msg.type !== "pageState") {
    unsent.push(msg);
    if (unsent.length > 100) unsent.shift();
    return;
  }
  for (const p of panelPorts) {
    try {
      p.postMessage(msg);
    } catch (_) {}
  }
}

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}

// The active tab if it's a Kindle reader, else null.
async function readerTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab && READER_RE.test(tab.url || "") ? tab : null;
}

// Development aid: the shown screen's page data, as content.js keeps it
// (with the glyphs it uses), to debug or build tests with on this computer.
// 存下頁面資料 in the side panel: the panel saves the file.
async function savePageData(port) {
  const tab = await readerTab();
  if (!tab) {
    broadcast({ type: "error", text: "目前分頁不是 Kindle Cloud Reader。" });
    return;
  }
  let dump;
  try {
    dump = await sendToPage(tab.id, { type: "dumpPage" });
  } catch (err) {
    dump = { error: err.message };
  }
  if (!dump || dump.error) {
    broadcast({ type: "error", text: `存不了頁面資料：${dump?.error || "頁面沒有回應"}` });
    return;
  }
  const json = JSON.stringify(dump.data);
  log(`已存下頁面資料：${dump.filename}（${Math.round(json.length / 1024)} KB）`);
  try {
    port.postMessage({ type: "savePage", filename: dump.filename, json });
  } catch (_) {} // the panel closed meanwhile
}

// The same, asked for by a test tool driving the reader page (content.js
// relays it), sent straight to a receiver on this computer
// (tests/tools/receive-pages.js) instead of the downloads folder. Off unless
// the options page's developer switch is on; the page only learns whether it
// worked, never the data.
const DEV_RECEIVER = "http://127.0.0.1:8765/page";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "devCapture") return;
  devCapture(sender.tab, msg.name).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // replies asynchronously
});

async function devCapture(tab, name) {
  const { devCapture: enabled } = await chrome.storage.local.get({ devCapture: false });
  if (!enabled) return { ok: false, error: "開發者開關沒有開啟（設定頁）" };
  if (!tab?.active || !READER_RE.test(tab.url || "")) return { ok: false, error: "只能存目前顯示的 Kindle 分頁" };
  const dump = await sendToPage(tab.id, { type: "dumpPage" });
  if (!dump || dump.error) return { ok: false, error: dump?.error || "頁面沒有回應" };
  const safe = typeof name === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/.test(name) ? name : undefined;
  const filename = safe ? `${safe}.json` : dump.filename;
  const res = await fetch(DEV_RECEIVER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename, data: dump.data }),
  });
  if (!res.ok) return { ok: false, error: `接收程式回應 HTTP ${res.status}` };
  return { ok: true, filename };
}

// ---- Screenshots (vision engine only) ----

// Chrome allows only 2 captureVisibleTab calls per second
// (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) and throws past that, so every
// capture goes through this queue and is spaced out.
const CAPTURE_GAP_MS = 600;
let captureChain = Promise.resolve();
let lastCaptureAt = 0;

function capture(windowId) {
  const run = captureChain.then(async () => {
    const wait = lastCaptureAt + CAPTURE_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 85 });
    } finally {
      lastCaptureAt = Date.now();
    }
  });
  captureChain = run.catch(() => {});
  return run;
}

// ---- Jobs ----

// Translate the screen on show. `force` (the button, Alt+T): on a screen
// whose translation is already drawn, ask Claude again instead of using the
// cache; and cancel a request already running for it.
async function translateActivePage({ force = false } = {}) {
  const tab = await readerTab();
  if (!tab) {
    broadcast({ type: "error", text: "目前分頁不是 Kindle Cloud Reader。" });
    return;
  }
  logTabId = tab.id;
  const settings = await getSettings();
  if (!settings.apiKey) {
    broadcast({ type: "error", text: "請先到設定頁填入 Anthropic API key。", needsKey: true });
    return;
  }
  let res;
  try {
    res = await sendToPage(tab.id, { type: "currentPage" });
  } catch (err) {
    res = { error: err.message };
  }
  if (!res?.page) {
    const why = res?.error || "頁面沒有回應";
    log(`無法辨識目前這一頁：${why}`);
    broadcast({ type: "error", text: `無法辨識目前這一頁：${why}` });
    return;
  }
  const page = { ...res.page, tabId: tab.id, windowId: tab.windowId };
  await setShown(page);
  const retranslate = force && (await getDrawn()) === screenId(page);
  if (retranslate) log(`重新翻譯本頁（${describeScreen(page)}），不使用快取`);
  else if (await drawFromCache(page, settings)) return;
  if (current) {
    if (sameScreen(current.page, page)) {
      // Already on it: wait for it rather than pay twice, then see whether
      // anything is still missing (a highlight added meanwhile). Only a
      // retranslate (pressed again on a screen just redone) cancels it and
      // starts over; tokens it already used are still billed.
      if (!retranslate) {
        await current.done;
        if (current || ((await getDrawn()) === screenId(page) && (await screenDone(page)))) return;
        return translateActivePage({ force: false });
      }
      log("手動翻譯：取消進行中的請求，改翻目前畫面");
      current.controller.abort();
      current = null;
    } else {
      detach(current);
    }
  }
  const job = startJob("page", page, { force: retranslate, settings });
  await job.done;
}

function startJob(kind, page, { force = false, settings }) {
  const job = { kind, page, force, controller: new AbortController(), detached: false };
  job.done = new Promise((resolve) => (job.finish = resolve));
  if (kind === "page") current = job;
  else prefetching = job;
  // Calling an extension API resets the service worker's 30 s idle timer;
  // reading a response stream alone doesn't.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  (async () => {
    try {
      await runJob(job, settings);
    } catch (err) {
      const what = job.kind === "prefetch" ? "預讀" : job.detached ? "背景翻譯" : null;
      if (err.name === "AbortError") log(what ? `已取消${what}（${describeScreen(job.page)}）` : "已取消前一個請求");
      else if (what) log(`${what}失敗：${err.message || err}`);
      else {
        broadcast({ type: "error", text: String(err.message || err) });
        log(`失敗：${err.message || err}`);
      }
    } finally {
      clearInterval(keepAlive);
      background.delete(job);
      if (prefetching === job) prefetching = null;
      if (current === job) {
        current = null;
        // Lets the side panel stop its "translating… N s" timer even when this
        // run ended without a result (cancelled, failed).
        if (!job.drew) broadcast({ type: "idle" });
      }
      job.finish();
    }
  })();
  return job;
}

// The reader moved on while `job` translated: let it finish in the
// background, caching what it gets, and free the foreground.
function detach(job) {
  if (current === job) current = null;
  job.detached = true;
  background.add(job);
  log(`畫面已換頁：先前那一頁（${describeScreen(job.page)}）改在背景翻完並存快取`);
  broadcast({ type: "idle" });
  if (background.size > MAX_BACKGROUND) {
    const oldest = [...background][0];
    background.delete(oldest);
    oldest.controller.abort();
    log(oldest === job ? "背景翻譯已達上限，取消剛翻走的那一頁" : "背景翻譯已達上限，取消最早的一個");
  }
}

async function runJob(job, settings) {
  if (settings.engine === "vision") return runVision(job, settings);
  const started = Date.now();
  if (job.kind === "page") broadcast({ type: "working" });
  const record = await screenRecord(job);
  if (!record.paras.some(hasText)) {
    log(`這一頁沒有文字（${describeScreen(job.page)}），不用翻譯`);
    if (job.kind === "page" && !job.detached) schedulePrefetch(job.page);
    return;
  }
  const out = await translateRecord(job, record, settings);
  const what = job.kind === "prefetch" ? "預讀完成" : job.detached ? "背景翻完先前那一頁" : "翻譯完成";
  log(`${what}：${describeScreen(job.page)}，${out.sent} 段送出、${out.reused} 段沿用快取或其他請求，從開始共 ${seconds(started)} 秒${out.summary ? "（只拿到摘要，不存快取）" : ""}`);
  if (out.notes) log(`Claude 的說明：${out.notes}`);
  if (job.kind !== "page" || job.detached) return;
  // Drawn only if the reader still shows it; the page checks that again.
  if (!sameScreen(await getShown(), job.page)) {
    log("翻譯期間畫面已換頁，這份譯文不畫上去（已存快取）");
    return;
  }
  job.drew = true;
  await draw(job.page, record, (p) => out.texts.get(paraSource(job.page, p).key), { fallbackModel: out.fallbackModel, summary: out.summary });
  // After the result, which clears the status line.
  if (out.summary) broadcast({ type: "warn", text: "Claude 只給了摘要，不是完整翻譯。可以按「重新翻譯本頁」再試。" });
}

// How `job.page` splits into paragraphs, with each one's OCR text: from the
// cache, from another job reading it right now, or read here.
async function screenRecord(job) {
  const key = recordKey(job.page);
  const cached = (await chrome.storage.session.get(key))[key];
  if (cached) return cached;
  if (reading.has(key)) {
    log("這一頁正由其他請求辨識，等它完成");
    const r = await reading.get(key);
    if (r) return r;
  }
  let done;
  reading.set(key, new Promise((r) => (done = r)));
  try {
    const record = await readScreen(job);
    await cacheWrite({ [key]: record });
    done(record);
    return record;
  } catch (err) {
    done(null);
    throw err;
  } finally {
    reading.delete(key);
  }
}

// Ask the page for the screen's paragraphs and a drawing of it, and OCR it.
async function readScreen(job) {
  const { page } = job;
  const data = await sendToPage(page.tabId, { type: "pageData", key: page.key, start: page.start, image: true });
  if (!data || data.error) throw new Error(`拿不到這一頁的頁面資料：${data?.error || "頁面沒有回應"}`);
  job.controller.signal.throwIfAborted();
  const record = { size: { width: data.page.width, height: data.page.height }, bg: data.page.fill, paras: [] };
  if (!data.paragraphs.length) return record;
  const started = Date.now();
  const { scale } = data;
  log(`OCR 辨識中（${data.paragraphs.length} 段，${data.columns.length} 欄）…`);
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "ocr",
    image: data.image,
    rects: data.columns.map(([x0, x1]) => ({
      left: Math.round(x0 * scale),
      top: 0,
      width: Math.round((x1 - x0) * scale),
      height: Math.round(data.page.height * scale),
    })),
  });
  if (!res || res.error) throw new Error(`OCR 失敗：${res?.error || "offscreen 文件沒有回應"}`);
  job.controller.signal.throwIfAborted();
  // A tenth of a pixel is plenty, and keeps the cached screen small.
  const px = (v) => Math.round((v / scale) * 10) / 10;
  const toPage = (b) => ({ x0: px(b.x0), y0: px(b.y0), x1: px(b.x1), y1: px(b.y1) });
  const lines = res.columns.flat().map((l) => ({ ...l, ...toPage(l), words: (l.words || []).map((w) => ({ ...w, ...toPage(w) })) }));
  const words = assignWords(lines, data.paragraphs);
  record.paras = data.paragraphs.map((p, i) => ({ start: p.start, end: p.end, kind: p.kind, column: p.column, boxes: p.boxes, fg: p.fg, words: words[i] }));
  const empty = words.filter((w) => !w.length).length;
  log(`OCR 完成：${seconds(started)} 秒，${lines.length} 行${empty ? `，${empty} 段沒有讀到字` : ""}`);
  const read = words.filter((w) => w.length).map(wordsText);
  if (read.length) log(`OCR 文字：${read.join(" ¶ ").slice(0, 400)}`);
  return record;
}

// Translations for the record's paragraphs: cached ones (unless forced),
// ones another job is requesting (waited for), and the rest requested here.
// Resolves to { texts (paragraph key → text), sent, reused, notes,
// fallbackModel, summary }.
async function translateRecord(job, record, settings) {
  const { page } = job;
  const want = record.paras.filter(hasText).map((p) => ({ ...paraSource(page, p), column: p.column }));
  const keyOf = (p) => p.key;
  const texts = new Map();
  if (!job.force) {
    const have = await cacheRead(want.map(keyOf));
    for (const p of want) if (have[keyOf(p)]) texts.set(keyOf(p), have[keyOf(p)].text);
  }
  let pending = want.filter((p) => !texts.has(keyOf(p)));
  const out = { texts, sent: 0, reused: texts.size, notes: "", fallbackModel: null, summary: false };
  if (texts.size) log(`${texts.size} 段已在快取，${pending.length} 段要翻譯`);
  for (let round = 0; pending.length; round++) {
    // Someone else paying for a paragraph: wait for theirs (first round only).
    const waits = round === 0 && !job.force ? pending.filter((p) => inflight.has(keyOf(p))) : [];
    const waited = waits.map((p) => inflight.get(keyOf(p)));
    const send = pending.filter((p) => !waits.includes(p));
    if (waits.length) log(`${waits.length} 段正由其他請求翻譯，等它們完成`);
    const own = new Map(send.map((p) => [keyOf(p), deferred()]));
    for (const [k, d] of own) inflight.set(k, d.promise);
    let got = null;
    try {
      if (send.length) {
        got = await requestTranslations(settings, send, job.controller.signal, page);
        out.sent += send.length;
        out.notes = [out.notes, got.notes].filter(Boolean).join(" ");
        out.fallbackModel ??= got.fallbackModel;
        out.summary ||= got.summary;
        const items = {};
        send.forEach((p, i) => {
          // Blank too: what Claude takes for noise stays blank, rather than
          // being asked for again every time the screen comes back.
          const text = got.texts[i] || "";
          texts.set(keyOf(p), text);
          items[keyOf(p)] = { source: p.source, text, savedAt: Date.now() };
        });
        // A summary isn't cached, so the screen is asked for again next time.
        if (!got.summary && Object.keys(items).length) await cacheWrite(items);
      }
    } finally {
      for (const [k, d] of own) {
        d.resolve(texts.has(k) ? texts.get(k) : null);
        if (inflight.get(k) === d.promise) inflight.delete(k);
      }
    }
    const results = await Promise.all(waited);
    waits.forEach((p, i) => results[i] !== null && texts.set(keyOf(p), results[i]));
    out.reused += results.filter((r) => r !== null).length;
    // Only what the other job failed to get goes round again.
    pending = waits.filter((p, i) => results[i] === null);
    if (round >= 1) break;
  }
  return out;
}

// Translate paragraphs ({ source, column }) of the screen `page` with the
// configured quality level, retrying a summary. Resolves to { texts (by
// index), notes, fallbackModel, summary }. A translation whose style marks
// don't hold up (unpaired, crossed, or not in its source) keeps its words
// without them.
async function requestTranslations(settings, paras, jobSignal, page) {
  const plan = qualityOf(settings);
  const items = paras.map((p, id) => ({ id, text: p.source }));
  const chunks = splitParas(items, paras);
  const names = await bookNames(settings, page, items.map((p) => p.text));
  if (names.length) log(`人名對照表：這一頁用到 ${names.length} 個（${names.map((n) => `${n.source} → ${n.text}`).join("、")}）`);
  let out;
  for (let attempt = 0; ; attempt++) {
    // Output speed is the bottleneck, so translate the chunks side by side.
    const failed = new AbortController(); // one chunk failing stops the others
    const signal = AbortSignal.any([jobSignal, failed.signal]);
    let outs;
    try {
      // Drafts side by side, then one review of the whole screen: it only
      // outputs what it changes, so splitting it would save little time.
      const drafts = await Promise.all(chunks.map((chunk, i) => translateChunk(settings, chunk, chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : "", signal, names)));
      outs = plan.review ? await reviewDrafts(settings, plan.review, chunks, drafts, signal, page, names) : drafts;
    } catch (err) {
      failed.abort(); // don't leave the other calls running
      throw err;
    }
    const byId = new Map(outs.flatMap((o) => o.translations || []).map((t) => [t.id, (t.text || "").trim()]));
    out = {
      texts: items.map((p) => byId.get(p.id) || ""),
      notes: outs.map((o) => (o.notes || "").trim()).filter(Boolean).join(" "),
      summarized: outs.some((o) => o.summarized === true),
      model: outs.find((o) => o.model !== plan.translate)?.model ?? outs[0].model, // shows when Opus stepped in
    };
    if (!isSummary(out)) break;
    if (attempt >= SUMMARY_RETRIES) {
      log(`重試後仍然只給摘要，先顯示摘要（不存快取）：${out.notes || "沒有說明"}`);
      break;
    }
    log(`Claude 這次只給摘要，不是翻譯（${out.notes || "沒有說明"}），自動重新請求`);
  }
  const texts = out.texts.map((text, i) => {
    const checked = checkMarks(text, items[i].text);
    if (!checked.ok) log(`第 ${i + 1} 段譯文的樣式標記不完整，改用不帶樣式的譯文`);
    return checked.text;
  });
  return { texts, notes: out.notes, fallbackModel: out.model !== plan.translate ? out.model : null, summary: isSummary(out) };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// Draw a screen's translation on the page and post it to the side panel.
// `textOf(para)` gives each record paragraph's translation (or nothing).
async function draw(page, record, textOf, { cached = false, post = true, fallbackModel = null, summary = false } = {}) {
  // Several screens can be shown in quick succession, each handled while the
  // last is still being looked up; only the one on screen now is drawn.
  if (!sameScreen(await getShown(), page)) return;
  const settings = await getSettings();
  const blocks = record.paras
    .map((p) => ({ kind: p.kind, text: textOf(p) || "", boxes: p.boxes, fg: p.fg, marks: p.words ? paraSource(page, p).marks : {} }))
    .filter((b) => stripMarks(b.text).trim());
  if (post) broadcast({ type: "result", text: blocksToText(blocks), cached, fallbackModel, summary });
  if (!blocks.length) {
    broadcast({ type: "warn", text: "這一頁沒有可以畫的譯文。" });
    return;
  }
  if (settings.overlay) await showOnPage(page, record, blocks);
  else log("覆蓋層開關已關閉，譯文只顯示在側邊欄");
  await setDrawn(page);
  // What the reader has seen, as the reference for later pages' reviews.
  if (settings.referencePages && settings.engine !== "vision" && !summary) {
    await saveReference(page, record, textOf).catch((err) => log(`參考頁沒有存下來：${err.message || err}`));
  }
  schedulePrefetch(page);
}

async function showOnPage(page, record, blocks) {
  let res;
  try {
    res = await sendToPage(page.tabId, { type: "overlay", page: { key: page.key, start: page.start }, size: record.size, bg: record.bg, blocks });
  } catch (err) {
    broadcast({ type: "warn", text: `譯文沒辦法疊到頁面上（${err.message}）。請重新整理 Kindle 分頁再試。` });
    return;
  }
  if (!res?.shown) {
    const why = res?.reason || "頁面沒有回應";
    // The reader moved on in the meantime: nothing wrong, the next screen's
    // own translation follows.
    if (!res?.stale) broadcast({ type: "warn", text: `覆蓋層沒有顯示：${why}` });
    log(`覆蓋層沒有顯示：${why}`);
  } else {
    log(`覆蓋層已畫上 ${blocks.length} 段`);
  }
}

// ---- Prefetch ----

function schedulePrefetch(page) {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    prefetchNext(page).catch((err) => log(`預讀失敗：${err.message || err}`));
  }, PREFETCH_DWELL_MS);
}

// Translate the screen after `page` ahead, if everything allows it.
async function prefetchNext(page) {
  if (!sameScreen(await getShown(), page)) return; // the reader moved on
  if (!(await panelOpen())) return;
  const settings = await getSettings();
  if (!settings.prefetch || !settings.autoTranslate || !settings.apiKey) return;
  if (settings.engine === "vision") return; // an Opus page is too costly to guess
  if (prefetching) return;
  if (background.size) {
    log("沒有預讀下一頁：背景還在翻先前那一頁");
    return;
  }
  let data;
  try {
    data = await sendToPage(page.tabId, { type: "pageData", key: page.key, start: page.start, next: true, image: false });
  } catch (err) {
    data = { error: err.message };
  }
  if (!data || data.error) {
    log(`沒有預讀下一頁：${data?.error || "頁面沒有回應"}`);
    return;
  }
  const next = { ...data.page, tabId: page.tabId, windowId: page.windowId };
  if (await screenDone(next)) {
    log(`下一頁已經翻好（${describeScreen(next)}）`);
    return;
  }
  if (!sameScreen(await getShown(), page) || prefetching) return;
  log(`預讀下一頁：開始（${describeScreen(next)}）`);
  startJob("prefetch", next, { settings });
}

// ---- Vision engine ----

// Screenshot the reader (without our overlay), have Opus find and translate
// the text blocks, and keep them in page pixels, like the OCR engine's.
async function runVision(job, settings) {
  const { page } = job;
  if (job.kind !== "page") return;
  broadcast({ type: "working" });
  const started = Date.now();
  // Hide our own overlay first so it doesn't end up in the screenshot.
  try {
    await sendToPage(page.tabId, { type: "clearOverlay" });
  } catch (err) {
    log(`清除覆蓋層失敗：${err.message}`);
  }
  // Asked right before the capture, so it matches the screenshot's layout.
  const geometry = await pageGeometry(page.tabId);
  if (!geometry?.page) throw new Error("頁面沒有回報書頁的位置，沒辦法對應截圖");
  const dataUrl = await capture(page.windowId);
  log(`截圖完成（${Math.round((dataUrl.length * 3) / 4 / 1024)} KB）`);
  if (!sameScreen(await getShown(), page)) {
    log("截圖時畫面已換頁，這張截圖不用");
    return;
  }
  const image = await prepareImage(dataUrl);
  let reply;
  for (let attempt = 0; ; attempt++) {
    reply = await visionTranslate(settings, image, job.controller.signal);
    if (!isSummary(reply)) break;
    if (attempt >= SUMMARY_RETRIES) {
      log(`重試後仍然只給摘要，先顯示摘要（不存快取）：${reply.notes || "沒有說明"}`);
      break;
    }
    log(`Claude 這次只給摘要，不是翻譯（${reply.notes || "沒有說明"}），自動重新請求`);
  }
  const summary = isSummary(reply);
  const record = { size: { width: page.width, height: page.height }, bg: page.fill, paras: visionParas(reply.blocks, image, geometry, page) };
  log(`Claude 回傳 ${reply.blocks.length} 個區塊，可用 ${record.paras.length} 個（從截圖起共 ${seconds(started)} 秒）`);
  if (reply.notes) log(`Claude 的說明：${reply.notes}`);
  if (!record.paras.length) {
    // Not cached: it may be a bad capture or a model quietly declining, and a
    // cached empty page would never be retried. Show what Claude was sent.
    const why = reply.notes || "沒有說明";
    log(`沒有可用的區塊（${reply.model}；${why}），這次的截圖：`, dataUrl);
    broadcast({ type: "warn", text: `沒有任何譯文區塊（${reply.model}）：${why}` });
    return;
  }
  if (!summary) await cacheWrite({ [visionKey(page)]: record });
  if (job.detached || !sameScreen(await getShown(), page)) return;
  job.drew = true;
  const fallbackModel = reply.model && reply.model !== MODEL ? reply.model : null;
  await draw(page, record, (p) => p.text, { fallbackModel, summary });
  if (summary) broadcast({ type: "warn", text: "Claude 只給了摘要，不是完整翻譯。可以按「重新翻譯本頁」再試。" });
}

// Opus's blocks (screenshot pixels) as record paragraphs in page pixels:
// screenshot → viewport → the page image's box, clamped to the page, tiny
// and blank ones dropped.
function visionParas(blocks, image, geometry, page) {
  const { viewport, page: box } = geometry;
  const toX = (x) => clampTo(((x / image.width) * viewport.width - box.left) * (page.width / (box.right - box.left)), page.width);
  const toY = (y) => clampTo(((y / image.height) * viewport.height - box.top) * (page.height / (box.bottom - box.top)), page.height);
  const out = [];
  for (const b of blocks) {
    const x0 = toX(Math.min(b.x0, b.x1));
    const x1 = toX(Math.max(b.x0, b.x1));
    const y0 = toY(Math.min(b.y0, b.y1));
    const y1 = toY(Math.max(b.y0, b.y1));
    if (x1 - x0 < 2 || y1 - y0 < 2 || !b.text?.trim()) continue;
    const lines = Math.max(1, Math.round(Number(b.lines) || 1));
    out.push({ kind: b.kind === "heading" ? "heading" : "paragraph", text: b.text.trim(), boxes: [{ x0, y0, x1, y1, lines }], fg: page.ink });
  }
  return out;
}

function clampTo(v, max) {
  return Math.max(0, Math.min(max, Number.isFinite(v) ? v : 0));
}

// Where the book is drawn on the page (content.js pageGeometry), or null
// when the page can't say.
async function pageGeometry(tabId) {
  try {
    return (await sendToPage(tabId, { type: "geometry" })) ?? null;
  } catch (_) {
    return null;
  }
}

async function sendToPage(tabId, msg) {
  // Only the top frame has the page data and draws the overlay.
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch (err) {
    // Tabs opened before the extension was (re)loaded have no live content
    // script. Inject one and retry once.
    if (!/Receiving end does not exist/.test(err.message)) throw err;
    log("頁面沒有 content script，重新注入");
    for (const cs of chrome.runtime.getManifest().content_scripts) {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: cs.js, world: cs.world || "ISOLATED" });
    }
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  }
}

// Downscale the screenshot to the size we send, as a JPEG.
async function prepareImage(dataUrl) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height), Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  log(`縮圖為 ${width}×${height}（${Math.round((base64.length * 3) / 4 / 1024)} KB）`);
  return { width, height, base64 };
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function blocksToText(blocks) {
  return blocks.map((b) => stripMarks(b.text)).join("\n\n") || "（此頁無內文）";
}

const REFUSAL_CATEGORIES = {
  cyber: "網路安全",
  bio: "生物安全",
  frontier_llm: "協助開發競爭的 AI 模型",
  reasoning_extraction: "要求輸出內部推理",
  general_harms: "其他使用政策",
};

// stop_details is informational and any field may be missing or null.
function describeRefusal(body) {
  const d = body.stop_details || {};
  const parts = [];
  if (d.category) parts.push(`類別：${REFUSAL_CATEGORIES[d.category] || d.category}（${d.category}）`);
  else parts.push("沒有分類（可能是模型本身拒絕，而不是安全分類器）");
  if (d.explanation) parts.push(`說明：${d.explanation}`);
  // A model's own refusal may come with text saying why.
  const said = (body.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (said) parts.push(`模型回覆：${said.slice(0, 300)}`);
  if (d.recommended_model) parts.push(`建議改用：${d.recommended_model}`);
  parts.push(`模型：${body.model || "未知"}`);
  return "Claude 拒絕處理這一頁。\n" + parts.join("\n");
}

const BLOCKS_SCHEMA = {
  type: "object",
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["heading", "paragraph", "quote", "list_item", "caption", "footnote", "other"] },
          x0: { type: "integer" },
          y0: { type: "integer" },
          x1: { type: "integer" },
          y1: { type: "integer" },
          lines: { type: "integer" },
          text: { type: "string" },
        },
        required: ["kind", "x0", "y0", "x1", "y1", "lines", "text"],
        additionalProperties: false,
      },
    },
    notes: { type: "string" },
    summarized: { type: "boolean" },
  },
  required: ["blocks", "notes", "summarized"],
  additionalProperties: false,
};

function buildPrompt(targetLang, width, height) {
  return `這是 Kindle Cloud Reader 的一張螢幕截圖，大小 ${width}×${height} 像素。畫面上是使用者正在閱讀的一本已出版的書，請逐段翻譯給使用者閱讀。
1. 找出截圖中書本內文的每個區塊：標題、段落、引文、清單項目、圖說、註腳各算一個區塊。忽略閱讀器介面、選單、頁碼、閱讀進度百分比；圖片和表格本身不要框。
2. 每個區塊給出緊貼原文字的外框 x0, y0（左上）與 x1, y1（右下），單位是這張截圖的像素。雙頁或多欄時每欄分開框，不要一個框橫跨兩欄。lines 是這個區塊的原文在截圖中佔幾行。
3. text 是該區塊翻成${targetLang}的譯文，只放譯文、不附原文。區塊在頁首或頁尾被切斷時，只翻看得到的部分。
4. 依閱讀順序排列。如果截圖中沒有書本內文（例如載入中或空白頁），回傳空的 blocks。
5. notes：如果有任何看得到的內文沒有放進 blocks（包括你決定不翻譯的段落），用一句話說明是哪些、為什麼；全部都有放就留空字串。
6. summarized：如果任何區塊放的是摘要或改寫，而不是逐句翻譯，設為 true；否則 false。`;
}

const TRANSLATIONS_SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, text: { type: "string" } },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
    notes: { type: "string" },
    summarized: { type: "boolean" },
  },
  required: ["translations", "notes", "summarized"],
  additionalProperties: false,
};

function buildTextPrompt(targetLang, paras, names = []) {
  const rules = [];
  if (paras.some((p) => hasMarks(p.text))) rules.push(MARKS_RULE);
  if (names.length) rules.push(namesRule(names));
  return `以下是使用者正在閱讀的一本已出版的書目前這一頁的文字，由 OCR 從書頁圖片辨識出來，可能有少量辨識錯誤。請逐段翻譯給使用者閱讀。
輸入是 JSON 陣列，每個元素是一段：id 和 text。
1. translations：每一段一個元素，id 對應輸入，text 是該段翻成${targetLang}的譯文，只放譯文、不附原文。不要合併或拆開段落，每個 id 都要有。
2. 依上下文修正明顯的 OCR 錯字後再翻譯。段落在頁首或頁尾被切斷時，只翻看得到的部分，不要補完。
3. 看起來不是書本內文的雜訊（亂碼、閱讀器介面文字），text 留空字串。
4. notes：如果有任何段落沒有翻譯（包括你決定不翻譯的），用一句話說明是哪些、為什麼；全部都有翻就留空字串。
5. summarized：如果任何段落放的是摘要或改寫，而不是逐句翻譯，設為 true；否則 false。
6. 譯文是中文時，引號用「」，引號裡面的引號用『』。${rules.map((r, i) => `\n${7 + i}. ${r}`).join("")}

${JSON.stringify(paras)}`;
}

// Added to the prompts only when some paragraph has style marks, so pages
// without any are asked exactly as before.
const MARKS_RULE = `原文裡的 <i>…</i>（斜體）、<b>…</b>（粗體）、<h1>…</h1>、<h2>…</h2>（使用者畫的螢光標記）等標記，要在譯文裡包住意思對應的字。不要新增、刪除或改名標記，標記可以一層包一層，但不能交錯。`;

// Added to the prompts when the book's name list has names on the page.
function namesRule(names) {
  return `人名一律照這份對照表翻譯（source 是原文，text 是譯名），初稿或譯文不一致時改成對照表的譯名。對照表只有單一的名或姓，全名就把各部分的譯名用「・」接起來：${JSON.stringify(names)}`;
}

// Added to the review prompt with the reference switch on: the names on the
// page go into the book's name list.
const NAMES_FIELD_RULE = "names：列出這一頁原文裡出現的每一個人名，名和姓分開各列一項，不要列全名（例如 Ender Wiggin 列成 Ender 和 Wiggin 兩項）；只出現姓或名、綽號也要列。source 是原文的寫法（不含所有格的 's 和 Mr.、Colonel 等稱謂），text 是定稿譯文裡用的譯名。地名、組織、物品等其他名稱不要列。沒有人名就給空陣列。";

// Added to the review prompt when the book's earlier paragraphs come first.
const REFERENCE_RULE = "前面的參考段落是同一本書較早的部分，已經定稿：人名、專有名詞、稱呼和語氣跟參考段落不一致時，改成跟參考段落一致（參考段落本身有明顯錯誤時除外）。不要修改或翻譯參考段落，corrections 只能列下面輸入裡的 id。這一頁的意思以這一頁的原文為準，不要用參考段落補完這一頁被切斷的段落。";

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    corrections: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, text: { type: "string" } },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
    notes: { type: "string" },
  },
  required: ["corrections", "notes"],
  additionalProperties: false,
};

// With the reference switch on, the review also lists the page's names.
const REVIEW_NAMES_SCHEMA = {
  ...REVIEW_SCHEMA,
  properties: {
    ...REVIEW_SCHEMA.properties,
    names: {
      type: "array",
      items: {
        type: "object",
        properties: { source: { type: "string" }, text: { type: "string" } },
        required: ["source", "text"],
        additionalProperties: false,
      },
    },
  },
  required: [...REVIEW_SCHEMA.required, "names"],
};

function buildReviewPrompt(targetLang, items, { withReference = false, names = [], listNames = false } = {}) {
  const rules = [];
  if (items.some((p) => hasMarks(p.source))) rules.push("保留初稿裡的 <i>、<b>、<h1> 等標記；修改譯文時，把標記搬到意思對應的字上。不要新增、刪除或改名標記，標記不能交錯。");
  if (withReference) rules.push(REFERENCE_RULE);
  if (listNames) rules.push(NAMES_FIELD_RULE);
  if (names.length) rules.push(namesRule(names));
  return `以下是使用者正在閱讀的一本已出版的書目前這一頁的文字（由 OCR 從書頁圖片辨識，可能有少量辨識錯誤），以及另一個模型翻成${targetLang}的初稿。請校對初稿給使用者閱讀。
輸入是 JSON 陣列，每個元素是一段：id、source（原文）、draft（初稿譯文）。
1. 檢查誤譯、漏譯、語意不清、不通順或不像${targetLang}的說法，以及同一頁人名、用語前後不一致。
2. corrections：只列出需要修改的段落，text 放修改後的完整譯文（不是只放改動的部分）。初稿沒問題的段落不要列出；全部都沒問題就給空陣列。
3. 不要只為了換個說法而修改；意思正確、讀起來自然就保留初稿。
4. 依上下文修正明顯的 OCR 錯字造成的誤譯。段落在頁首或頁尾被切斷時，只翻看得到的部分，不要補完。
5. 譯文是中文時，引號用「」，引號裡面的引號用『』。
6. notes：用一句話說明主要改了什麼；沒有修改就留空字串。${rules.map((r, i) => `\n${7 + i}. ${r}`).join("")}

${JSON.stringify(items)}`;
}

// Ask Opus once to find and translate the screenshot's blocks. Resolves to
// { blocks (screenshot pixels, as in BLOCKS_SCHEMA), notes, summarized,
// model }.
async function visionTranslate(settings, image, signal) {
  const out = await callClaude(settings, {
    signal,
    model: MODEL,
    effort: settings.effort,
    fallbacks: FALLBACK,
    schema: BLOCKS_SCHEMA,
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.base64 } },
      { type: "text", text: buildPrompt(settings.targetLang, image.width, image.height) },
    ],
  });
  return { blocks: out.blocks || [], notes: (out.notes || "").trim(), summarized: out.summarized === true, model: out.model };
}

// The text model sometimes declines a chunk (copyright) or answers with a
// summary; Haiku did in testing. Opus usually translates the same text, so
// hand it just that chunk instead of retrying, which tends to decline again.
async function translateChunk(settings, chunk, tag, signal, names = []) {
  const model = qualityOf(settings).translate;
  const content = [{ type: "text", text: buildTextPrompt(settings.targetLang, chunk, names) }];
  const out = await callClaude(settings, {
    signal,
    tag,
    model,
    effort: "low",
    thinking: TEXT_MODELS[model],
    schema: TRANSLATIONS_SCHEMA,
    content,
  });
  if (!isDeclined(out, chunk)) return out;
  log(`${tag}${model} 沒有完整翻譯（${(out.notes || "").trim() || "沒有說明"}），這部分改用 ${MODEL}`);
  const fallback = await callClaude(settings, { signal, tag, model: MODEL, effort: "low", fallbacks: FALLBACK, schema: TRANSLATIONS_SCHEMA, content });
  return { ...fallback, byOpus: true };
}

// The configured quality level, or the default if the stored one is unknown.
function qualityOf(settings) {
  return QUALITY[settings.quality] ?? QUALITY[DEFAULTS.quality];
}

// Review the drafts of a screen's chunks in one request. An Opus fallback's
// translation is reviewed only with the reference switch on: it doesn't
// need the polish, but left out it kept names off the book's list (two
// 安德 among 333 恩德 in the Ender's Game test).
async function reviewDrafts(settings, model, chunks, drafts, signal, page, names) {
  const mine = drafts.map((d) => !d.byOpus || !!settings.referencePages);
  if (!mine.includes(true)) return drafts;
  const chunk = chunks.filter((c, i) => mine[i]).flat();
  const merged = { translations: drafts.filter((d, i) => mine[i]).flatMap((d) => d.translations || []) };
  const reviewed = new Map((await reviewChunk(settings, model, chunk, merged, "", signal, page, names)).translations.map((t) => [t.id, t.text]));
  return drafts.map((d, i) => (mine[i] ? { ...d, translations: (d.translations || []).map((t) => ({ ...t, text: reviewed.get(t.id) ?? t.text })) } : d));
}

// Apply `model`'s corrections to a draft. A failed or declined review keeps
// the draft: it's already a usable translation. With the reference switch
// on, the book's earlier paragraphs go first (see referenceContent), the
// book's names on the page go with the prompt, and the names the review
// lists go into the book's name list.
async function reviewChunk(settings, model, chunk, draft, tag, signal, page, names = []) {
  const texts = new Map((draft.translations || []).map((t) => [t.id, t.text]));
  const items = chunk
    .map((p) => ({ id: p.id, source: p.text, draft: texts.get(p.id) || "" }))
    .filter((p) => p.draft.trim()); // noise the draft left blank
  if (!items.length) return draft;
  // A reference that can't be read only costs the consistency, not the review.
  const reference = settings.referencePages
    ? await referenceContent(settings, page, tag).catch((err) => {
        log(`${tag}校對沒有參考前面的頁：讀不到存下的段落（${err.message || err}）`);
        return null;
      })
    : null;
  const listNames = !!settings.referencePages && !!page?.asin;
  const started = Date.now();
  let out;
  try {
    out = await callClaude(settings, {
      signal,
      tag,
      model,
      effort: "low",
      thinking: TEXT_MODELS[model],
      schema: listNames ? REVIEW_NAMES_SCHEMA : REVIEW_SCHEMA,
      content: [...(reference || []), { type: "text", text: buildReviewPrompt(settings.targetLang, items, { withReference: !!reference, names, listNames }) }],
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    log(`${tag}${model} 校對失敗（${err.message}），沿用初稿`);
    return draft;
  }
  const ids = new Set(items.map((p) => p.id));
  const fixes = (out.corrections || []).filter((c) => ids.has(c.id) && c.text?.trim() && c.text !== texts.get(c.id));
  const notes = (out.notes || "").trim();
  log(`${tag}${model} 校對完成：${seconds(started)} 秒，改了 ${fixes.length}/${items.length} 段${notes ? `：${notes}` : ""}`);
  for (const c of fixes) {
    log(`${tag}校對第 ${c.id + 1} 段\n  初稿：${texts.get(c.id)}\n  改為：${c.text}`);
    texts.set(c.id, c.text);
  }
  if (listNames && Array.isArray(out.names)) {
    const res = await saveNames(page, out.names, tag).catch((err) => log(`${tag}人名對照表沒有存下來：${err.message || err}`));
    const n = res ? restoreNames(res.conflicts, items, texts) : 0;
    if (n) log(`${tag}譯文裡的人名改回對照表的譯名（${n} 處）`);
  }
  return { ...draft, translations: [...texts].map(([id, text]) => ({ id, text })) };
}

// Fewer than half of the paragraphs translated, or flagged as a summary.
function isDeclined(out, chunk) {
  const done = (out.translations || []).filter((t) => t.text?.trim()).length;
  return out.summarized === true || done < chunk.length / 2 || /摘要/.test(out.notes || "");
}

// Split a screen into two requests: by column on a two-page spread, otherwise
// in half by length. A page has a few hundred words, so more requests would
// mostly add overhead. `paras` ({ id, text }) and `blocks` ({ column }) are
// parallel.
function splitParas(paras, blocks) {
  if (paras.length < 4) return paras.length ? [paras] : [];
  const firstRight = blocks.findIndex((b) => b.column > 0);
  let cut = firstRight;
  if (cut <= 0) {
    const total = paras.reduce((n, p) => n + p.text.length, 0);
    let seen = 0;
    cut = paras.findIndex((p) => (seen += p.text.length) >= total / 2) + 1;
  }
  return [paras.slice(0, cut), paras.slice(cut)].filter((c) => c.length);
}

let creatingOffscreen = null;

async function ensureOffscreen() {
  const open = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (open.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "Run Tesseract OCR in a Web Worker" })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

// One streamed Messages API call with a JSON-schema answer. Returns the
// parsed JSON plus the model that answered.
// `tag` prefixes the log lines when several calls run at once.
// `signal` cancels it (the translation job was cancelled).
async function callClaude(settings, { model, effort, thinking, fallbacks, schema, content, signal: jobSignal, tag = "" }) {
  const log = (text) => broadcast({ type: "log", text: tag + text, at: Date.now() });
  const fbNote = fallbacks ? `，備援：${fallbacks.fallbacks.map((f) => f.model).join(" → ")}` : "";
  log(`送出 API 請求（${model}，effort ${effort}${fbNote}），等待回應…`);
  const started = Date.now();
  let res;
  let body;
  try {
    // Streamed: Chrome stops a service worker whose fetch() gets no response
    // within 30 s, and a page often takes longer than that. With streaming the
    // headers arrive right away and the content trickles in.
    // Without a timeout a hung request holds the foreground job and blocks every
    // later page. The controller lets a manual retranslate cancel it.
    const signal = AbortSignal.any([jobSignal, AbortSignal.timeout(API_TIMEOUT_MS)]);
    signal.throwIfAborted(); // cancelled during OCR
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        ...(fallbacks && { "anthropic-beta": fallbacks.beta }),
        // Required for calling the API directly from a browser context.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        stream: true,
        ...(thinking && { thinking }),
        output_config: { effort, format: { type: "json_schema", schema } },
        ...(fallbacks && { fallbacks: fallbacks.fallbacks }),
        messages: [{ role: "user", content }],
      }),
    });
    log(`API 開始回應：HTTP ${res.status}，${seconds(started)} 秒`);
    // Errors come back as plain JSON, not an event stream.
    body = res.ok ? await readStream(res, started, signal, log) : await res.json().catch(() => ({}));
  } catch (err) {
    if (err.name === "AbortError") throw err; // cancelled by a manual retranslate or page turn
    if (err.name === "TimeoutError") throw new Error(`等候 Claude 回應超過 ${API_TIMEOUT_MS / 1000} 秒，已中止。`);
    if (err.apiError) throw err;
    throw new Error(`連不上 Claude API：${err.message}`);
  }

  const u = body.usage || {};
  log(
    `回應結束：${seconds(started)} 秒，` +
      `stop_reason ${body.stop_reason ?? "-"}，模型 ${body.model ?? "-"}，` +
      `tokens 輸入 ${u.input_tokens ?? "-"} / 輸出 ${u.output_tokens ?? "-"}` +
      (u.cache_read_input_tokens || u.cache_creation_input_tokens ? `，快取讀 ${u.cache_read_input_tokens ?? 0} / 寫 ${u.cache_creation_input_tokens ?? 0}` : "")
  );
  if (!res.ok) {
    const msg = body?.error?.message || res.statusText;
    if (res.status === 401) throw new Error("API key 無效（401）。請到設定頁檢查。");
    if (res.status === 429) throw new Error("請求太頻繁或額度不足（429），請稍後再試。");
    throw new Error(`Claude API 錯誤 ${res.status}：${msg}`);
  }
  if (body.stop_reason === "refusal") throw new Error(describeRefusal(body));
  if (body.stop_reason === "max_tokens") throw new Error("輸出被截斷（max_tokens），這一頁可能內容太多。");
  try {
    // body.model differs from the requested model when a fallback answered.
    return { ...parseReply(body.content), model: body.model };
  } catch (_) {
    throw new Error("無法解析 Claude 回傳的 JSON。");
  }
}

function seconds(since) {
  return ((Date.now() - since) / 1000).toFixed(1);
}

// The JSON is the concatenated text blocks. After a mid-output fallback the
// stream keeps the declined model's partial text, then a `fallback` block,
// then the fallback model's continuation; if the joined text doesn't parse,
// try the part after the last fallback marker on its own.
function parseReply(content = []) {
  const join = (list) => list.filter((b) => b.type === "text").map((b) => b.text).join("");
  let out;
  try {
    out = JSON.parse(join(content));
  } catch (err) {
    const cut = content.map((b) => b.type).lastIndexOf("fallback");
    if (cut < 0) throw err;
    out = JSON.parse(join(content.slice(cut + 1)));
  }
  return out;
}

// Claude flags summaries itself; the text checks catch the times it says so
// only in the notes or by labelling a block "（摘要）". `reply` has either
// `texts` (OCR engine) or `blocks` (vision engine).
function isSummary(reply) {
  const texts = reply.texts ?? (reply.blocks || []).map((b) => b.text || "");
  return reply.summarized === true || /摘要/.test(reply.notes || "") || texts.some((t) => /^[（(]\s*摘要/.test((t || "").trim()));
}

// Reassemble a Messages API event stream into the shape of a non-streamed
// response: { model, content, stop_reason, stop_details, usage }.
async function readStream(res, started, signal, log) {
  const msg = { content: [], usage: {} };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  // Stop reading on cancel/timeout; the check after the loop turns the early
  // end into an AbortError / TimeoutError instead of a truncated message.
  signal.addEventListener("abort", () => reader.cancel().catch(() => {}), { once: true });
  let buf = "";
  let firstText = true;
  for (;;) {
    const { value, done } = await reader.read();
    signal.throwIfAborted();
    if (done) break;
    buf += value;
    let sep;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      const ev = JSON.parse(data);
      switch (ev.type) {
        case "message_start":
          msg.model = ev.message.model;
          Object.assign(msg.usage, ev.message.usage);
          log(`串流開始：模型 ${msg.model}，${seconds(started)} 秒`);
          break;
        case "content_block_start":
          msg.content[ev.index] = { ...ev.content_block };
          if (ev.content_block.type === "fallback") log("此段被拒，改由備援模型接手");
          break;
        case "content_block_delta":
          if (ev.delta.type === "text_delta") {
            if (firstText) {
              firstText = false;
              log(`開始輸出譯文：${seconds(started)} 秒`);
            }
            msg.content[ev.index].text = (msg.content[ev.index].text || "") + ev.delta.text;
          }
          break;
        case "message_delta":
          msg.stop_reason = ev.delta.stop_reason;
          msg.stop_details = ev.delta.stop_details ?? msg.stop_details;
          Object.assign(msg.usage, ev.usage);
          break;
        case "error": {
          const err = new Error(`Claude API 串流錯誤：${ev.error?.message || ev.error?.type}`);
          err.apiError = true;
          throw err;
        }
      }
    }
  }
  return msg;
}
