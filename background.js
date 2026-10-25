// Service worker: captures the visible Kindle page, finds and translates each
// text block, then pushes the blocks to the page (overlay) and the side panel.
// Two engines:
// - "ocr": Tesseract reads the text and its positions locally, then Haiku
//   translates the text alone, optionally with Sonnet reviewing the draft. Fast, and the model never sees a book page.
// - "vision": Opus reads the screenshot and translates it in one call.

importScripts("ocr-layout.js", "page-sig.js");

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
  quality: "haiku",
  effort: "low",
  autoTranslate: true,
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

// Part of the viewport OCR reads. Wider than CONTENT_CROP, which cuts off the
// first and last lines of a page in some window shapes, but still clear of the
// title bar, the footer ("N mins left") and the page arrows. The "Back to"
// button and progress slider can fall inside; OCR noise filtering drops them. Larger crops are scaled down: Tesseract's time grows with
// pixels, and body text stays well above the size it needs.
const OCR_CROP = { x0: 0.09, y0: 0.06, x1: 0.93, y1: 0.94 };
const OCR_MAX_PIXELS = 5_000_000;

// Claude sometimes answers a page with a summary instead of a translation,
// citing copyright, and the same page often translates fine on the next
// try. Retry that many times; after that show the summary, uncached.
const SUMMARY_RETRIES = 1;

const READER_RE = /^https:\/\/read\.amazon\.(com|co\.jp|co\.uk|de|ca|com\.au)\//;

let panelPorts = new Set();
let pending = null; // { force, reason } of a request waiting for the current one

// The foreground job translates what's on screen; only it draws the overlay
// and posts results. When the page changes under it, it isn't cancelled but
// moved to the background: it finishes, fills the cache, and turning back to
// that page is then instant. Each job: { controller (cancels its OCR wait and
// API calls), page: { sig, windowId } once captured, detached, done (resolves
// to the blocks it cached, or null) }.
let current = null;
const background = new Set();
// Pages turned past while they were translating keep going, up to this many;
// beyond it the oldest is cancelled, so paging on doesn't pile up requests.
const MAX_BACKGROUND = 1;

// Chrome stops this service worker after ~30 s idle, wiping module state, so
// the page cache and last screen fingerprint live in session storage
// (cleared when the browser closes). Pages are found by fingerprint
// (samePage), so the cache keeps an index of [id, fingerprint] and the
// blocks under page:<id>.
const CACHE_PAGES = 500;
let cacheChain = Promise.resolve(); // index updates one at a time

async function cacheGet(sig) {
  const { pageIndex = [] } = await chrome.storage.session.get("pageIndex");
  const hit = pageIndex.find(([, s]) => samePage(s, sig));
  if (!hit) {
    if (pageIndex.length) log(`快取裡沒有這一頁（最接近的差異 ${diffText(Math.min(...pageIndex.map(([, s]) => pageDiff(s, sig))))}）`);
    return undefined;
  }
  log(`快取裡有這一頁（差異 ${pct(hit[1], sig)}）`);
  const blocks = (await chrome.storage.session.get(`page:${hit[0]}`))[`page:${hit[0]}`];
  return blocks?.length ? blocks : undefined; // empty results were never meant to stick
}

// Difference between two fingerprints for the log, e.g. "3%".
function pct(a, b) {
  return diffText(pageDiff(a, b));
}

function diffText(d) {
  return `${Math.round(d * 100)}%`;
}

function cacheSet(sig, blocks) {
  const run = cacheChain.then(async () => {
    const { pageIndex = [] } = await chrome.storage.session.get("pageIndex");
    let entry = pageIndex.find(([, s]) => samePage(s, sig));
    if (!entry) {
      entry = [crypto.randomUUID(), sig];
      pageIndex.push(entry);
    }
    const dropped = pageIndex.splice(0, Math.max(0, pageIndex.length - CACHE_PAGES));
    if (dropped.length) await chrome.storage.session.remove(dropped.map(([id]) => `page:${id}`));
    await chrome.storage.session.set({ pageIndex, [`page:${entry[0]}`]: blocks });
  });
  cacheChain = run.catch(() => {});
  return run;
}

// Fingerprint of the page whose translation is currently shown. While the
// screen still matches it, the side-panel button retranslates (skipping the
// cache) and is labelled that way.
async function getShownSig() {
  return (await chrome.storage.session.get("shownSig")).shownSig;
}

async function setShownSig(sig) {
  if (sig) await chrome.storage.session.set({ shownSig: sig });
  else await chrome.storage.session.remove("shownSig");
  broadcast({ type: "pageState", retranslate: !!sig });
}

async function swapLastSig(sig) {
  const { lastSig } = await chrome.storage.session.get("lastSig");
  await chrome.storage.session.set({ lastSig: sig });
  return lastSig;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  injectIntoOpenReaders();
});

// Installing or reloading the extension cuts off the content scripts in tabs
// already open, so page turns there would go unnoticed until something
// reinjects them. Give those tabs a live copy now.
async function injectIntoOpenReaders() {
  const { content_scripts: [cs] } = chrome.runtime.getManifest();
  for (const tab of await chrome.tabs.query({ url: cs.matches })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: cs.js }).catch(() => {});
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  for (const msg of unsent.splice(0)) port.postMessage(msg);
  // Button label and "not translated yet" hint for a freshly opened panel.
  getShownSig().then((sig) => port.postMessage({ type: "pageState", retranslate: !!sig })).catch(() => {});
  port.onMessage.addListener((msg) => {
    if (msg.type === "translateNow") {
      log("手動翻譯：按下「翻譯這一頁」");
      translateActivePage({ force: true });
    }
  });
});

chrome.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg.type !== "pageTurned") return;
  const { autoTranslate } = await getSettings();
  // Only translate when the panel is open, so we don't spend tokens silently.
  if (!(await panelOpen()) || !sender.tab?.active) return;
  logTabId = sender.tab.id;
  if (!autoTranslate) return refreshButtonState(sender.tab.windowId);
  // Key, click, wheel and window resize hide the overlay on the page at once;
  // "dom" leaves it up until the check below.
  const cleared = msg.reason !== "dom" ? "，書頁上的譯文已先清掉" : "";
  log(`偵測到翻頁（${msg.reason}${cleared}）`);
  translateActivePage({ force: false, reason: msg.reason });
});

// Whether a side panel is open. Not panelPorts: Chrome stops this worker
// after 30 s idle, and the page-turn message that wakes it arrives before the
// panel has reconnected, so a click after a pause was dropped and the page,
// its overlay already hidden, stayed in English.
async function panelOpen() {
  if (panelPorts.size) return true;
  return (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).length > 0;
}

// Without auto-translate nothing else re-checks the screen after a page turn,
// so do it here to keep the button label honest.
async function refreshButtonState(windowId) {
  if (current) return;
  try {
    const shown = await getShownSig();
    if (!shown) return;
    const now = await captureSig(windowId);
    const { overlaySig } = await chrome.storage.session.get("overlaySig");
    if (!samePage(now, shown) && !samePage(now, overlaySig)) await setShownSig(null);
  } catch (_) {}
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
// page hides and shows its overlay itself. When it comes back on, check that
// it still matches the screen; a cached page is redrawn without an API call.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.overlay?.newValue) translateActivePage({ force: false, reason: "overlay" });
});

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

// Part of the viewport that holds the book text, as fractions. Leaves out the
// title bar, the progress bar / "Learning reading speed…" footer, the page
// arrows (which get a focus ring after a key press) and the bookmark ribbon.
const CONTENT_CROP = { x0: 0.09, y0: 0.08, x1: 0.91, y1: 0.91 };

// Identifies the page by its text area only, so reader-UI changes don't make
// the same page look new (cache miss, paid retranslation) and a real page
// change is noticed however it happened (arrow, Enter, slider, table of
// contents). A coarse fingerprint compared with samePage (page-sig.js), not
// an exact hash: toolbar animation, hover effects and JPEG noise change a few
// pixels of the same page.
async function pageSigOf(dataUrl) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const sx = bitmap.width * CONTENT_CROP.x0;
  const sy = bitmap.height * CONTENT_CROP.y0;
  const sw = bitmap.width * (CONTENT_CROP.x1 - CONTENT_CROP.x0);
  const sh = bitmap.height * (CONTENT_CROP.y1 - CONTENT_CROP.y0);
  const w = SIG_WIDTH;
  const h = Math.round((w * sh) / sw);
  const ctx = new OffscreenCanvas(w, h).getContext("2d");
  ctx.imageSmoothingQuality = "high"; // average the area, like the Node tests
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
  return pageSignature({ width: w, height: h, data });
}

// Chrome allows only 2 captureVisibleTab calls per second
// (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) and throws past that. Several
// frames can report a page turn at once, each triggering a check, so every
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

async function captureSig(windowId) {
  return pageSigOf(await capture(windowId));
}

// While a request runs, any page-turn signal (even plain DOM churn, or an
// Enter on the arrow button that no key handler recognises) re-captures the
// screen: if the text area changed, the running request is for a page that's
// gone, so cancel it.
let checking = false;
let recheck = false;

async function detachIfPageChanged() {
  // Collapse a burst of signals into one running check plus one follow-up,
  // so they don't pile up captures ahead of the next real translation.
  if (checking) {
    recheck = true;
    return;
  }
  checking = true;
  try {
    do {
      recheck = false;
      await checkPageOnce();
    } while (recheck);
  } finally {
    checking = false;
  }
}

async function checkPageOnce() {
  const job = current;
  const page = job?.page;
  if (!page) return;
  let now;
  try {
    now = await captureSig(page.windowId);
  } catch (_) {
    return; // tab not capturable right now (e.g. another tab is in front)
  }
  if (current !== job) return;
  if (samePage(now, page.sig)) log(`檢查：還是同一頁（差異 ${pct(now, page.sig)}），繼續`);
  else detach(job, now, pct(now, page.sig));
}

// Let the foreground job finish in the background and start on the new page,
// whose content sig is `now`.
function detach(job, now, diff) {
  job.detached = true;
  if (job.waiting) {
    // It was only waiting on a background job, which keeps going anyway.
    log("畫面已換頁：不再等背景翻譯，先翻目前畫面");
    release(job);
    return;
  }
  background.add(job);
  log(`畫面已換頁（差異 ${diff}）：先前那一頁改在背景翻完並存快取，先翻目前畫面`);
  if (background.size > MAX_BACKGROUND) {
    // Not the one for the page now on screen: turning back to it waits for it.
    const oldest = [...background].find((j) => !samePage(j.page.sig, now));
    background.delete(oldest);
    oldest.controller.abort();
    log(oldest === job ? "背景翻譯已達上限，取消剛翻走的那一頁" : "背景翻譯已達上限，取消最早的一個");
  }
  release(job);
}

// The foreground is free: run the queued request, if any.
function release(job) {
  if (current !== job) return;
  current = null;
  if (pending) {
    const next = pending;
    pending = null;
    log("處理排隊中的請求");
    translateActivePage(next);
  } else {
    // Lets the side panel stop its "translating… N s" timer even when this
    // run ended without a result (cancelled, skipped).
    broadcast({ type: "idle" });
  }
}

// Turning back to a page whose translation is still running in the
// background: wait for it rather than paying for the page twice.
async function backgroundResult(job, sig, windowId) {
  const running = [...background].find((j) => j.page && samePage(j.page.sig, sig));
  if (!running) return undefined;
  log("這一頁還在背景翻譯，等它完成");
  broadcast({ type: "working" });
  job.page = { sig, windowId }; // so turning away again releases the wait
  job.waiting = true;
  try {
    return (await running.done) ?? undefined;
  } finally {
    job.waiting = false;
  }
}

// `reason` is the page-turn signal: "dom" is the reader re-rendering on its
// own (reading-progress updates every 15 s or so), not a user action.
async function translateActivePage({ force, reason }) {
  if (current) {
    // Run once more after the current request finishes, keeping "force" if
    // any queued trigger asked for it, and "dom" only if every trigger was
    // reader churn (so the queued run can skip without hiding the overlay).
    pending = {
      force: force || !!pending?.force,
      reason: !pending || pending.reason === "dom" ? reason : pending.reason,
    };
    if (reason === "overlay") return; // nothing to cancel: the screen didn't change
    if (force) {
      // A manual retranslate wins: cancel the running API call instead of
      // waiting for it. Tokens it already used are still billed.
      log("手動翻譯：取消進行中的請求，改翻目前畫面");
      current.controller.abort();
    } else {
      log("前一個請求還沒結束，排隊；同時檢查畫面是否已換頁");
      detachIfPageChanged();
    }
    return;
  }
  const job = { controller: new AbortController(), page: null, detached: false };
  job.done = new Promise((resolve) => (job.finish = resolve));
  current = job;
  // Calling an extension API resets the service worker's 30 s idle timer;
  // reading a response stream alone doesn't.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    await runJob(job, { force, reason });
  } catch (err) {
    if (err.name === "AbortError") {
      // Forget this screen so the queued run doesn't skip it as "unchanged".
      if (!job.detached) await chrome.storage.session.remove("lastSig");
      log(job.detached ? "已取消一個背景翻譯" : "已取消前一個請求");
    } else if (job.detached) {
      log(`背景翻譯失敗：${err.message || err}`);
    } else {
      broadcast({ type: "error", text: String(err.message || err) });
      log(`失敗：${err.message || err}`);
    }
  } finally {
    clearInterval(keepAlive);
    job.finish(null); // no-op if it already resolved with blocks
    background.delete(job);
    release(job);
  }
}

async function runJob(job, { force, reason }) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && READER_RE.test(tab.url || "")) logTabId = tab.id;
  if (!tab || !READER_RE.test(tab.url || "")) {
    broadcast({ type: "error", text: "目前分頁不是 Kindle Cloud Reader。" });
    return;
  }
  const settings = await getSettings();
  if (!settings.apiKey) {
    broadcast({ type: "error", text: "請先到設定頁填入 Anthropic API key。", needsKey: true });
    return;
  }

  // The reader re-renders now and then without the page changing. Hiding
  // the overlay to check made the original text flash, so compare the
  // screen as it is, overlay included, with how it looked when drawn. Ask
  // the page too: a sig taken while the overlay happened to be hidden would
  // otherwise match the bare page and keep the translation off for good.
  if (!force && (reason === "dom" || reason === "overlay") && settings.overlay) {
    const { overlaySig } = await chrome.storage.session.get("overlaySig");
    try {
      const shown = (await sendToPage(tab.id, { type: "overlayState" }))?.shown;
      const now = overlaySig && shown ? await captureSig(tab.windowId) : null;
      if (now && samePage(now, overlaySig)) {
        log(`畫面沒變（譯文還在，差異 ${pct(now, overlaySig)}），略過`);
        return;
      }
      log(
        !overlaySig
          ? "重新檢查：沒有譯文畫面的紀錄"
          : !shown
            ? "重新檢查：頁面上沒有顯示譯文"
            : `重新檢查：畫面跟畫上譯文時不同（差異 ${Math.round(pageDiff(overlaySig, now) * 100)}%）`
      );
    } catch (err) {
      log(`重新檢查失敗：${err.message}`);
    }
  }

  // Hide our own overlay first so it doesn't end up in the screenshot.
  // The page answers with its page-turn counter; an overlay tagged with an
  // older counter (user turned the page mid-request) gets dropped there.
  let turn;
  if (settings.overlay) {
    try {
      turn = (await sendToPage(tab.id, { type: "clearOverlay" }))?.turn;
      await chrome.storage.session.remove("overlaySig");
      log("已清掉頁面上的覆蓋層");
    } catch (err) {
      // Reported again by showOnPage; still translate for the side panel.
      log(`清除覆蓋層失敗：${err.message}`);
    }
  }

  const dataUrl = await capture(tab.windowId);
  const capturedAt = Date.now();
  log(`截圖完成（${Math.round((dataUrl.length * 3) / 4 / 1024)} KB）`);
  const sig = await pageSigOf(dataUrl);
  const lastSig = await swapLastSig(sig);
  const sameAsLast = samePage(lastSig, sig);
  if (lastSig) log(`跟上一次截圖的差異 ${pct(lastSig, sig)}`);

  // The button reads "重新翻譯本頁" while the shown translation is for this
  // very screen; pressing it then means "ask Claude again", not "use cache".
  const retranslate = force && samePage(sig, await getShownSig());
  if (retranslate) log(`畫面沒變（差異 ${pct(sig, await getShownSig())}）：重新翻譯本頁，不使用快取`);
  const cached = retranslate ? null : (await cacheGet(sig)) ?? (await backgroundResult(job, sig, tab.windowId));
  if (job.detached) return; // turned away while waiting for the background job
  if (cached) {
    const blocks = cached;
    log(`命中快取（${blocks.length} 個區塊），不呼叫 API`);
    // Same screen re-captured (e.g. after a stray DOM change): just restore the overlay.
    if (force || !sameAsLast) broadcast({ type: "result", text: blocksToText(blocks), cached: true, thumb: dataUrl });
    if (settings.overlay) await showOnPage(tab.id, blocks, turn);
    await setShownSig(sig);
    return;
  }
  if (!force && sameAsLast) {
    log("畫面跟上次一樣，略過");
    return;
  }

  broadcast({ type: "working", thumb: dataUrl });
  await setShownSig(null);
  const vision = settings.engine === "vision";
  const image = await prepareImage(dataUrl, vision);
  job.page = { sig, windowId: tab.windowId };
  const signal = job.controller.signal;
  const translate = vision ? visionTranslator(settings, image, signal) : await ocrTranslator(settings, dataUrl, image, signal);
  let reply;
  for (let attempt = 0; ; attempt++) {
    reply = await translate();
    if (!isSummary(reply)) break;
    if (attempt >= SUMMARY_RETRIES) {
      log(`重試後仍然只給摘要，先顯示摘要（不存快取）：${reply.notes || "沒有說明"}`);
      break;
    }
    log(`Claude 這次只給摘要，不是翻譯（${reply.notes || "沒有說明"}），自動重新請求`);
  }
  const summary = isSummary(reply);
  const blocks = finishBlocks(reply.blocks, image);
  if (job.detached) {
    // Turned away from this page: just keep the translation for later.
    if (blocks.length && !summary) {
      await cacheSet(sig, blocks);
      job.finish(blocks);
      log(`背景翻完先前那一頁，已存快取（${blocks.length} 個區塊，從截圖起共 ${seconds(capturedAt)} 秒）`);
    } else {
      log("背景翻完先前那一頁，但沒有完整譯文，不存快取");
    }
    return;
  }
  log(`Claude 回傳 ${reply.blocks.length} 個區塊，可用 ${blocks.length} 個（從截圖起共 ${seconds(capturedAt)} 秒）`);
  if (reply.notes) log(`Claude 的說明：${reply.notes}`);
  const fallbackModel = reply.model && reply.model !== reply.requested ? reply.model : null;
  if (!blocks.length) {
    // Not cached: it may be a bad capture or a model quietly declining, and a
    // cached empty page would never be retried. Show what Claude was sent.
    const why = reply.notes || "沒有說明";
    log(`沒有可用的區塊（${reply.model}；${why}），這次的截圖：`, dataUrl);
    broadcast({ type: "warn", text: `沒有任何譯文區塊（${reply.model}）：${why}` });
    return;
  }
  // A summary isn't cached, so revisiting the page asks for a translation again.
  if (!summary) {
    await cacheSet(sig, blocks);
    job.finish(blocks);
  }
  broadcast({ type: "result", text: blocksToText(blocks), thumb: dataUrl, fallbackModel, summary });
  // After the result, which clears the status line.
  if (summary) broadcast({ type: "warn", text: "Claude 只給了摘要，不是完整翻譯。可以按「重新翻譯本頁」再試。" });
  if (!settings.overlay) await setShownSig(sig); // shown in the side panel only
  if (settings.overlay) {
    // The page may have changed in the last moments without a signal we
    // caught; never draw one page's translation over another.
    let now = sig;
    try {
      now = await captureSig(tab.windowId);
    } catch (_) {}
    if (samePage(now, sig)) {
      if (now !== sig) log(`畫上譯文前再確認：同一頁（差異 ${pct(now, sig)}）`);
      await showOnPage(tab.id, blocks, turn);
      await setShownSig(sig);
    } else {
      log(`翻譯期間畫面已換頁（差異 ${pct(now, sig)}），這份譯文不畫上去（已存快取）`);
      pending ??= { force: false };
    }
  }
}

async function sendToPage(tabId, msg) {
  // Only the top frame draws the overlay; it covers the whole viewport.
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch (err) {
    // Tabs opened before the extension was (re)loaded have no live content
    // script. Inject one and retry once.
    if (!/Receiving end does not exist/.test(err.message)) throw err;
    log("頁面沒有 content script，重新注入");
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  }
}

async function showOnPage(tabId, blocks, turn) {
  // The switch may have been turned off while the request was in flight.
  if (!(await getSettings()).overlay) {
    log("覆蓋層開關已關閉，不畫");
    return;
  }
  let res;
  try {
    res = await sendToPage(tabId, { type: "overlay", blocks, turn });
  } catch (err) {
    broadcast({ type: "warn", text: `譯文沒辦法疊到頁面上（${err.message}）。請重新整理 Kindle 分頁再試。` });
    return;
  }
  if (!res?.shown) {
    broadcast({ type: "warn", text: `覆蓋層沒有顯示：${res?.reason || "頁面沒有回應"}` });
    log(`覆蓋層沒有顯示：${res?.reason || "頁面沒有回應"}`);
  } else {
    log(`覆蓋層已畫上 ${blocks.length} 個區塊`);
    await rememberOverlaySig(tabId);
  }
}

// Hash of the screen with the overlay on it, for the "dom" re-check above.
// Not if the overlay was switched off meanwhile: that would be the bare page.
async function rememberOverlaySig(tabId) {
  try {
    const { windowId } = await chrome.tabs.get(tabId);
    const sig = await captureSig(windowId);
    if ((await sendToPage(tabId, { type: "overlayState" }))?.shown) await chrome.storage.session.set({ overlaySig: sig });
  } catch (_) {}
}

// Downscale the screenshot to the size we send, and keep its pixels so we can
// sample background / text colors for each block afterwards. The JPEG is only
// needed when the screenshot itself goes to Claude (vision engine).
async function prepareImage(dataUrl, encode) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(
    1,
    MAX_EDGE / Math.max(bitmap.width, bitmap.height),
    Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height))
  );
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  if (!encode) return { width, height, pixels };
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  log(`縮圖為 ${width}×${height}（${Math.round((base64.length * 3) / 4 / 1024)} KB）`);
  return { width, height, pixels, base64 };
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Clamp boxes, convert them to viewport fractions, and pick colors so the
// overlay matches the reader theme (white / sepia / dark).
function finishBlocks(raw, image) {
  const { width: W, height: H } = image;
  const out = [];
  for (const b of raw) {
    const x0 = clamp(Math.min(b.x0, b.x1), 0, W);
    const x1 = clamp(Math.max(b.x0, b.x1), 0, W);
    const y0 = clamp(Math.min(b.y0, b.y1), 0, H);
    const y1 = clamp(Math.max(b.y0, b.y1), 0, H);
    if (x1 - x0 < 4 || y1 - y0 < 4 || !b.text?.trim()) continue;
    const bg = sampleBackground(image, x0, y0, x1, y1);
    out.push({
      kind: b.kind,
      text: b.text.trim(),
      lines: Math.max(1, Math.round(Number(b.lines) || 1)),
      box: [x0 / W, y0 / H, x1 / W, y1 / H],
      bg: rgb(bg),
      fg: rgb(sampleInk(image, x0, y0, x1, y1, bg)),
    });
  }
  return out;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
}

function pixelAt({ width, height, pixels }, x, y) {
  const i = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2]];
}

// Median color of a ring just outside the box: the page background there.
function sampleBackground(image, x0, y0, x1, y1) {
  const pad = 4;
  const pts = [];
  for (let i = 0; i <= 20; i++) {
    const x = x0 + ((x1 - x0) * i) / 20;
    const y = y0 + ((y1 - y0) * i) / 20;
    pts.push(pixelAt(image, x, y0 - pad), pixelAt(image, x, y1 + pad));
    pts.push(pixelAt(image, x0 - pad, y), pixelAt(image, x1 + pad, y));
  }
  return [0, 1, 2].map((c) => pts.map((p) => p[c]).sort((a, b) => a - b)[pts.length >> 1]);
}

// The pixel inside the box that differs most from the background: the ink.
function sampleInk(image, x0, y0, x1, y1, bg) {
  let best = null;
  let bestDist = -1;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const p = pixelAt(image, x, y);
      const d = Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]);
      if (d > bestDist) [best, bestDist] = [p, d];
    }
  }
  // Fall back to black/white if the box is blank (bad coordinates).
  if (bestDist < 120) return bg[0] + bg[1] + bg[2] > 384 ? [0, 0, 0] : [255, 255, 255];
  return best;
}

function rgb([r, g, b]) {
  return `rgb(${r},${g},${b})`;
}

function blocksToText(blocks) {
  return blocks.map((b) => b.text).join("\n\n") || "（此頁無內文）";
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

function buildTextPrompt(targetLang, paras) {
  return `以下是使用者正在閱讀的一本已出版的書目前這一頁的文字，由 OCR 從螢幕截圖辨識出來，可能有少量辨識錯誤。請逐段翻譯給使用者閱讀。
輸入是 JSON 陣列，每個元素是一段：id 和 text。
1. translations：每一段一個元素，id 對應輸入，text 是該段翻成${targetLang}的譯文，只放譯文、不附原文。不要合併或拆開段落，每個 id 都要有。
2. 依上下文修正明顯的 OCR 錯字後再翻譯。段落在頁首或頁尾被切斷時，只翻看得到的部分，不要補完。
3. 看起來不是書本內文的雜訊（亂碼、閱讀器介面文字），text 留空字串。
4. notes：如果有任何段落沒有翻譯（包括你決定不翻譯的），用一句話說明是哪些、為什麼；全部都有翻就留空字串。
5. summarized：如果任何段落放的是摘要或改寫，而不是逐句翻譯，設為 true；否則 false。
6. 譯文是中文時，引號用「」，引號裡面的引號用『』。

${JSON.stringify(paras)}`;
}

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

function buildReviewPrompt(targetLang, items) {
  return `以下是使用者正在閱讀的一本已出版的書目前這一頁的文字（由 OCR 從螢幕截圖辨識，可能有少量辨識錯誤），以及另一個模型翻成${targetLang}的初稿。請校對初稿給使用者閱讀。
輸入是 JSON 陣列，每個元素是一段：id、source（原文）、draft（初稿譯文）。
1. 檢查誤譯、漏譯、語意不清、不通順或不像${targetLang}的說法，以及同一頁人名、用語前後不一致。
2. corrections：只列出需要修改的段落，text 放修改後的完整譯文（不是只放改動的部分）。初稿沒問題的段落不要列出；全部都沒問題就給空陣列。
3. 不要只為了換個說法而修改；意思正確、讀起來自然就保留初稿。
4. 依上下文修正明顯的 OCR 錯字造成的誤譯。段落在頁首或頁尾被切斷時，只翻看得到的部分，不要補完。
5. 譯文是中文時，引號用「」，引號裡面的引號用『』。
6. notes：用一句話說明主要改了什麼；沒有修改就留空字串。

${JSON.stringify(items)}`;
}

// Each translator returns a function that asks Claude once and resolves to
// { blocks (screenshot pixels, as in BLOCKS_SCHEMA), notes, summarized,
// model, requested }, so a summary can be retried without redoing the OCR.

function visionTranslator(settings, image, signal) {
  return async () => {
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
    return {
      blocks: out.blocks || [],
      notes: (out.notes || "").trim(),
      summarized: out.summarized === true,
      model: out.model,
      requested: MODEL,
    };
  };
}

async function ocrTranslator(settings, dataUrl, image, jobSignal) {
  const plan = qualityOf(settings);
  const textModel = plan.translate;
  const started = Date.now();
  log("OCR 辨識中（Tesseract）…");
  const ocr = await ocrPage(dataUrl);
  log(`OCR 完成：${seconds(started)} 秒，${ocr.size}，${ocr.columns} 欄，${ocr.blocks.length} 段`);
  if (ocr.blocks.length) log(`OCR 文字：${ocr.blocks.map((b) => b.text).join(" ¶ ").slice(0, 400)}`);
  const paras = ocr.blocks.map((b, id) => ({ id, text: b.text }));
  const chunks = splitParas(paras, ocr.blocks);
  return async () => {
    if (!paras.length) {
      return { blocks: [], notes: "OCR 沒有辨識到任何文字", summarized: false, model: "tesseract", requested: "tesseract" };
    }
    // Output speed is the bottleneck, so translate the chunks side by side.
    const failed = new AbortController(); // one chunk failing stops the others
    const signal = AbortSignal.any([jobSignal, failed.signal]);
    let outs;
    try {
      outs = await Promise.all(
        chunks.map(async (chunk, i) => {
          const tag = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : "";
          const draft = await translateChunk(settings, chunk, tag, signal);
          // An Opus fallback's translation doesn't need a Sonnet review.
          return plan.review && !draft.byOpus ? reviewChunk(settings, plan.review, chunk, draft, tag, signal) : draft;
        })
      );
    } catch (err) {
      failed.abort(); // don't leave the other calls running
      throw err;
    }
    const out = {
      translations: outs.flatMap((o) => o.translations || []),
      notes: outs.map((o) => (o.notes || "").trim()).filter(Boolean).join(" "),
      summarized: outs.some((o) => o.summarized === true),
      model: outs.find((o) => o.model !== textModel)?.model ?? outs[0].model, // shows when Opus stepped in
    };
    const byId = new Map(out.translations.map((t) => [t.id, t.text]));
    return {
      blocks: ocr.blocks.map((b, id) => ({
        kind: b.kind,
        lines: b.lines,
        text: byId.get(id) || "",
        x0: b.box[0] * image.width,
        y0: b.box[1] * image.height,
        x1: b.box[2] * image.width,
        y1: b.box[3] * image.height,
      })),
      notes: (out.notes || "").trim(),
      summarized: out.summarized === true,
      model: out.model,
      requested: textModel,
    };
  };
}

// The text model sometimes declines a chunk (copyright) or answers with a
// summary; Haiku did in testing. Opus usually translates the same text, so
// hand it just that chunk instead of retrying, which tends to decline again.
async function translateChunk(settings, chunk, tag, signal) {
  const model = qualityOf(settings).translate;
  const content = [{ type: "text", text: buildTextPrompt(settings.targetLang, chunk) }];
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

// Apply `model`'s corrections to a chunk's draft. A failed or declined review
// keeps the draft: it's already a usable translation.
async function reviewChunk(settings, model, chunk, draft, tag, signal) {
  const texts = new Map((draft.translations || []).map((t) => [t.id, t.text]));
  const items = chunk
    .map((p) => ({ id: p.id, source: p.text, draft: texts.get(p.id) || "" }))
    .filter((p) => p.draft.trim()); // noise the draft left blank
  if (!items.length) return draft;
  const started = Date.now();
  let out;
  try {
    out = await callClaude(settings, {
      signal,
      tag,
      model,
      effort: "low",
      thinking: TEXT_MODELS[model],
      schema: REVIEW_SCHEMA,
      content: [{ type: "text", text: buildReviewPrompt(settings.targetLang, items) }],
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
  return { ...draft, translations: [...texts].map(([id, text]) => ({ id, text })) };
}

// Fewer than half of the paragraphs translated, or flagged as a summary.
function isDeclined(out, chunk) {
  const done = (out.translations || []).filter((t) => t.text?.trim()).length;
  return out.summarized === true || done < chunk.length / 2 || /摘要/.test(out.notes || "");
}

// Split a page into two requests: by column on a two-page spread, otherwise
// in half by length. A page has a few hundred words, so more requests would
// mostly add overhead.
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

// Text paragraphs of the screenshot with boxes as viewport fractions.
async function ocrPage(dataUrl) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const sx = bitmap.width * OCR_CROP.x0;
  const sy = bitmap.height * OCR_CROP.y0;
  const sw = bitmap.width * (OCR_CROP.x1 - OCR_CROP.x0);
  const sh = bitmap.height * (OCR_CROP.y1 - OCR_CROP.y0);
  const scale = Math.min(1, Math.sqrt(OCR_MAX_PIXELS / (sw * sh)));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
  const columns = findColumns({ width: w, height: h, data: gray });
  const png = await canvas.convertToBlob({ type: "image/png" });
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "ocr",
    image: `data:image/png;base64,${bytesToBase64(new Uint8Array(await png.arrayBuffer()))}`,
    rects: columns.map(([x0, x1]) => ({ left: x0, top: 0, width: x1 - x0, height: h })),
  });
  if (!res || res.error) throw new Error(`OCR 失敗：${res?.error || "offscreen 文件沒有回應"}`);
  const fx = (x) => (sx + x / scale) / bitmap.width;
  const fy = (y) => (sy + y / scale) / bitmap.height;
  const blocks = res.columns.flatMap((lines, column) =>
    groupParagraphs(lines).map((b) => ({ ...b, column, box: [fx(b.x0), fy(b.y0), fx(b.x1), fy(b.y1)] }))
  );
  return { blocks, columns: columns.length, size: `${w}×${h}` };
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
      `tokens 輸入 ${u.input_tokens ?? "-"} / 輸出 ${u.output_tokens ?? "-"}`
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
// only in the notes or by labelling blocks "（摘要）".
function isSummary(reply) {
  return (
    reply.summarized ||
    /摘要/.test(reply.notes) ||
    reply.blocks.some((b) => /^[（(]\s*摘要/.test((b.text || "").trim()))
  );
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
