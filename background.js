// Service worker: captures the visible Kindle page, asks Claude to locate each
// text block and translate it, then pushes the blocks to the page (overlay)
// and the side panel.

// Only Opus: in testing, Sonnet 5.5 and Haiku 5.5 declined to translate
// screenshots of Kindle book pages (citing copyright) and returned no blocks.
const MODEL = "claude-opus-5-5";

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

const READER_RE = /^https:\/\/read\.amazon\.(com|co\.jp|co\.uk|de|ca|com\.au)\//;

let panelPorts = new Set();
let busy = false;
let pending = null; // { force } of a request waiting for the current one
let inflight = null; // AbortController of the current API call
let inflightPage = null; // { hash, windowId } of the screen being translated

// Chrome stops this service worker after ~30 s idle, wiping module state, so
// the page cache and last screenshot hash live in session storage (cleared
// when the browser closes).
async function cacheGet(hash) {
  const blocks = (await chrome.storage.session.get(`page:${hash}`))[`page:${hash}`];
  return blocks?.length ? blocks : undefined; // empty results were never meant to stick
}

async function cacheSet(hash, blocks) {
  await chrome.storage.session.set({ [`page:${hash}`]: blocks });
}

async function swapLastHash(hash) {
  const { lastHash } = await chrome.storage.session.get("lastHash");
  await chrome.storage.session.set({ lastHash: hash });
  return lastHash;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.type === "translateNow") {
      log("手動翻譯：按下「翻譯這一頁」");
      translateActivePage({ force: true });
    }
    if (msg.type === "overlayChanged") onOverlayChanged(msg.on);
  });
});

chrome.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg.type !== "pageTurned") return;
  const { autoTranslate } = await getSettings();
  // Only translate when the panel is open, so we don't spend tokens silently.
  if (!autoTranslate || panelPorts.size === 0 || !sender.tab?.active) return;
  log(`偵測到翻頁（${msg.reason}）`);
  translateActivePage({ force: false });
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== "translate-page") return;
  log("手動翻譯：Alt+T");
  translateActivePage({ force: true });
});

// Side-panel switch. Off: remove the overlay now. On: re-capture; a cached
// page shows its overlay right away without a new API call.
async function onOverlayChanged(on) {
  if (on) return translateActivePage({ force: false });
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && READER_RE.test(tab.url || "")) await sendToPage(tab.id, { type: "clearOverlay" }).catch(() => {});
}

// Step-by-step trace shown at the bottom of the side panel. `image` (a data
// URL) is shown as a thumbnail under the line.
function log(text, image) {
  broadcast({ type: "log", text, at: Date.now(), image });
}

function broadcast(msg) {
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
// change is noticed however it happened (arrow, Enter, slider, table of contents).
async function contentHash(dataUrl) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const sx = bitmap.width * CONTENT_CROP.x0;
  const sy = bitmap.height * CONTENT_CROP.y0;
  const sw = bitmap.width * (CONTENT_CROP.x1 - CONTENT_CROP.x0);
  const sh = bitmap.height * (CONTENT_CROP.y1 - CONTENT_CROP.y0);
  const w = 480;
  const h = Math.round((w * sh) / sw);
  const ctx = new OffscreenCanvas(w, h).getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  const buf = await crypto.subtle.digest("SHA-256", ctx.getImageData(0, 0, w, h).data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function captureHash(windowId) {
  return contentHash(await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 85 }));
}

// While a request runs, any page-turn signal (even plain DOM churn, or an
// Enter on the arrow button that no key handler recognises) re-captures the
// screen: if the text area changed, the running request is for a page that's
// gone, so cancel it.
async function cancelIfPageChanged() {
  const page = inflightPage;
  if (!page) return;
  try {
    if ((await captureHash(page.windowId)) === page.hash || inflightPage !== page) return;
  } catch (_) {
    return; // tab not capturable right now (e.g. another tab is in front)
  }
  log("畫面已換頁：取消進行中的請求，改翻目前畫面");
  inflight?.abort();
}

async function translateActivePage({ force }) {
  if (busy) {
    // Run once more after the current request finishes, keeping "force" if
    // any queued trigger asked for it.
    pending = { force: force || !!pending?.force };
    if (force && inflight) {
      // A manual retranslate wins: cancel the running API call instead of
      // waiting for it. Tokens it already used are still billed.
      log("手動翻譯：取消進行中的請求，改翻目前畫面");
      inflight.abort();
    } else {
      log("前一個請求還沒結束，排隊；同時檢查畫面是否已換頁");
      cancelIfPageChanged();
    }
    return;
  }
  busy = true;
  // Calling an extension API resets the service worker's 30 s idle timer;
  // reading a response stream alone doesn't.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !READER_RE.test(tab.url || "")) {
      broadcast({ type: "error", text: "目前分頁不是 Kindle Cloud Reader。" });
      return;
    }
    const settings = await getSettings();
    if (!settings.apiKey) {
      broadcast({ type: "error", text: "請先到設定頁填入 Anthropic API key。", needsKey: true });
      return;
    }

    // Hide our own overlay first so it doesn't end up in the screenshot.
    // The page answers with its page-turn counter; an overlay tagged with an
    // older counter (user turned the page mid-request) gets dropped there.
    let turn;
    if (settings.overlay) {
      try {
        turn = (await sendToPage(tab.id, { type: "clearOverlay" }))?.turn;
        log("已清掉頁面上的覆蓋層");
      } catch (err) {
        // Reported again by showOnPage; still translate for the side panel.
        log(`清除覆蓋層失敗：${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 80));

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
    log(`截圖完成（${Math.round((dataUrl.length * 3) / 4 / 1024)} KB）`);
    const hash = await contentHash(dataUrl);
    const sameAsLast = (await swapLastHash(hash)) === hash;

    const cached = await cacheGet(hash);
    if (cached) {
      const blocks = cached;
      log(`命中快取（${blocks.length} 個區塊），不呼叫 API`);
      // Same screen re-captured (e.g. after a stray DOM change): just restore the overlay.
      if (force || !sameAsLast) broadcast({ type: "result", text: blocksToText(blocks), cached: true, thumb: dataUrl });
      if (settings.overlay) await showOnPage(tab.id, blocks, turn);
      return;
    }
    if (!force && sameAsLast) {
      log("畫面跟上次一樣，略過");
      return;
    }

    broadcast({ type: "working", thumb: dataUrl });
    const image = await prepareImage(dataUrl);
    log(`縮圖為 ${image.width}×${image.height}（${Math.round((image.base64.length * 3) / 4 / 1024)} KB）`);
    inflightPage = { hash, windowId: tab.windowId };
    let reply;
    try {
      reply = await callClaude(settings, image);
    } finally {
      inflightPage = null;
    }
    const blocks = finishBlocks(reply.blocks, image);
    log(`Claude 回傳 ${reply.blocks.length} 個區塊，可用 ${blocks.length} 個`);
    if (reply.notes) log(`Claude 的說明：${reply.notes}`);
    const fallbackModel = reply.model && reply.model !== MODEL ? reply.model : null;
    if (!blocks.length) {
      // Not cached: it may be a bad capture or a model quietly declining, and a
      // cached empty page would never be retried. Show what Claude was sent.
      const why = reply.notes || "沒有說明";
      log(`沒有可用的區塊（${reply.model}；${why}），送出的截圖：`, `data:image/jpeg;base64,${image.base64}`);
      broadcast({ type: "warn", text: `Claude 沒有回傳任何譯文區塊（${reply.model}）：${why}` });
      return;
    }
    await cacheSet(hash, blocks);
    broadcast({ type: "result", text: blocksToText(blocks), thumb: dataUrl, fallbackModel });
    if (settings.overlay) {
      // The page may have changed in the last moments without a signal we
      // caught; never draw one page's translation over another.
      let now = hash;
      try {
        now = await captureHash(tab.windowId);
      } catch (_) {}
      if (now === hash) await showOnPage(tab.id, blocks, turn);
      else {
        log("翻譯期間畫面已換頁，這份譯文不畫上去（已存快取）");
        pending ??= { force: false };
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      // Forget this screen so the queued run doesn't skip it as "unchanged".
      await chrome.storage.session.remove("lastHash");
      log("已取消前一個請求");
    } else {
      broadcast({ type: "error", text: String(err.message || err) });
      log(`失敗：${err.message || err}`);
    }
  } finally {
    clearInterval(keepAlive);
    busy = false;
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
  }
}

// Downscale the screenshot to the size we send, and keep its pixels so we can
// sample background / text colors for each block afterwards.
async function prepareImage(dataUrl) {
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
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return { width, height, pixels, base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
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
  },
  required: ["blocks", "notes"],
  additionalProperties: false,
};

function buildPrompt(targetLang, width, height) {
  return `這是 Kindle Cloud Reader 的一張螢幕截圖，大小 ${width}×${height} 像素。畫面上是使用者正在閱讀的一本已出版的書，請逐段翻譯給使用者閱讀。
1. 找出截圖中書本內文的每個區塊：標題、段落、引文、清單項目、圖說、註腳各算一個區塊。忽略閱讀器介面、選單、頁碼、閱讀進度百分比；圖片和表格本身不要框。
2. 每個區塊給出緊貼原文字的外框 x0, y0（左上）與 x1, y1（右下），單位是這張截圖的像素。雙頁或多欄時每欄分開框，不要一個框橫跨兩欄。lines 是這個區塊的原文在截圖中佔幾行。
3. text 是該區塊翻成${targetLang}的譯文，只放譯文、不附原文。區塊在頁首或頁尾被切斷時，只翻看得到的部分。
4. 依閱讀順序排列。如果截圖中沒有書本內文（例如載入中或空白頁），回傳空的 blocks。
5. notes：如果有任何看得到的內文沒有放進 blocks（包括你決定不翻譯的段落），用一句話說明是哪些、為什麼；全部都有放就留空字串。`;
}

async function callClaude(settings, image) {
  const fbNote = FALLBACK.fallbacks.map((f) => f.model).join(" → ");
  log(`送出 API 請求（${MODEL}，effort ${settings.effort}，備援：${fbNote}），等待回應…`);
  const started = Date.now();
  inflight = new AbortController();
  let res;
  let body;
  try {
    // Streamed: Chrome stops a service worker whose fetch() gets no response
    // within 30 s, and a page often takes longer than that. With streaming the
    // headers arrive right away and the content trickles in.
    // Without a timeout a hung request keeps `busy` set and blocks every
    // later page. The controller lets a manual retranslate cancel it.
    const signal = AbortSignal.any([inflight.signal, AbortSignal.timeout(API_TIMEOUT_MS)]);
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": FALLBACK.beta,
        // Required for calling the API directly from a browser context.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        stream: true,
        output_config: {
          effort: settings.effort,
          format: { type: "json_schema", schema: BLOCKS_SCHEMA },
        },
        fallbacks: FALLBACK.fallbacks,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.base64 } },
              { type: "text", text: buildPrompt(settings.targetLang, image.width, image.height) },
            ],
          },
        ],
      }),
    });
    log(`API 開始回應：HTTP ${res.status}，${seconds(started)} 秒`);
    // Errors come back as plain JSON, not an event stream.
    body = res.ok ? await readStream(res, started, signal) : await res.json().catch(() => ({}));
  } catch (err) {
    if (err.name === "AbortError") throw err; // cancelled by a manual retranslate or page turn
    if (err.name === "TimeoutError") throw new Error(`等候 Claude 回應超過 ${API_TIMEOUT_MS / 1000} 秒，已中止。`);
    if (err.apiError) throw err;
    throw new Error(`連不上 Claude API：${err.message}`);
  } finally {
    inflight = null;
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
    throw new Error("無法解析 Claude 回傳的區塊資料。");
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
  return { blocks: out.blocks || [], notes: (out.notes || "").trim() };
}

// Reassemble a Messages API event stream into the shape of a non-streamed
// response: { model, content, stop_reason, stop_details, usage }.
async function readStream(res, started, signal) {
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
