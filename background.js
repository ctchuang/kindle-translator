// Service worker: captures the visible Kindle page, asks Claude to locate each
// text block and translate it, then pushes the blocks to the page (overlay)
// and the side panel.

const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "low",
  autoTranslate: true,
  targetLang: "繁體中文（台灣用語）",
  overlay: true,
};

// Longest image edge we send. Within the model's limit, returned coordinates
// map 1:1 to our pixels; above it the API would downscale and boxes would drift.
const MAX_EDGE = { default: 2576, haiku: 1568 };

const READER_RE = /^https:\/\/read\.amazon\.(com|co\.jp|co\.uk|de|ca|com\.au)\//;

let panelPorts = new Set();
let lastHash = null;
let busy = false;
let pending = false;
const cache = new Map(); // screenshot hash -> blocks (session only)

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.type === "translateNow") translateActivePage({ force: true });
  });
});

chrome.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg.type !== "pageTurned") return;
  const { autoTranslate } = await getSettings();
  // Only translate when the panel is open, so we don't spend tokens silently.
  if (autoTranslate && panelPorts.size > 0 && sender.tab?.active) translateActivePage({ force: false });
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "translate-page") translateActivePage({ force: true });
});

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

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function translateActivePage({ force }) {
  if (busy) {
    pending = true; // run once more after the current request finishes
    return;
  }
  busy = true;
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
      } catch (_) {
        // Reported later by showOnPage; still translate for the side panel.
      }
    }
    await new Promise((r) => setTimeout(r, 80));

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
    const hash = await sha256(dataUrl);
    const sameAsLast = hash === lastHash;
    lastHash = hash;

    if (cache.has(hash)) {
      const blocks = cache.get(hash);
      // Same screen re-captured (e.g. after a stray DOM change): just restore the overlay.
      if (force || !sameAsLast) broadcast({ type: "result", text: blocksToText(blocks), cached: true, thumb: dataUrl });
      if (settings.overlay) await showOnPage(tab.id, blocks, turn);
      return;
    }
    if (!force && sameAsLast) return; // page didn't actually change

    broadcast({ type: "working", thumb: dataUrl });
    const image = await prepareImage(dataUrl, settings.model);
    const raw = await callClaude(settings, image);
    const blocks = finishBlocks(raw, image);
    cache.set(hash, blocks);
    broadcast({ type: "result", text: blocksToText(blocks), thumb: dataUrl });
    if (settings.overlay) await showOnPage(tab.id, blocks, turn);
  } catch (err) {
    broadcast({ type: "error", text: String(err.message || err) });
  } finally {
    busy = false;
    if (pending) {
      pending = false;
      translateActivePage({ force: false });
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
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  }
}

async function showOnPage(tabId, blocks, turn) {
  let res;
  try {
    res = await sendToPage(tabId, { type: "overlay", blocks, turn });
  } catch (err) {
    broadcast({ type: "warn", text: `譯文沒辦法疊到頁面上（${err.message}）。請重新整理 Kindle 分頁再試。` });
    return;
  }
  if (!res?.shown) broadcast({ type: "warn", text: `覆蓋層沒有顯示：${res?.reason || "頁面沒有回應"}` });
}

// Downscale the screenshot to the size we send, and keep its pixels so we can
// sample background / text colors for each block afterwards.
async function prepareImage(dataUrl, model) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const maxEdge = model.includes("haiku") ? MAX_EDGE.haiku : MAX_EDGE.default;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
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
          text: { type: "string" },
        },
        required: ["kind", "x0", "y0", "x1", "y1", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["blocks"],
  additionalProperties: false,
};

function buildPrompt(targetLang, width, height) {
  return `這是 Kindle Cloud Reader 的一張螢幕截圖，大小 ${width}×${height} 像素。
1. 找出截圖中書本內文的每個區塊：標題、段落、引文、清單項目、圖說、註腳各算一個區塊。忽略閱讀器介面、選單、頁碼、閱讀進度百分比；圖片和表格本身不要框。
2. 每個區塊給出緊貼原文字的外框 x0, y0（左上）與 x1, y1（右下），單位是這張截圖的像素。雙頁或多欄時每欄分開框，不要一個框橫跨兩欄。
3. text 是該區塊翻成${targetLang}的譯文，只放譯文、不附原文。區塊在頁首或頁尾被切斷時，只翻看得到的部分。
4. 依閱讀順序排列。如果截圖中沒有書本內文（例如載入中或空白頁），回傳空的 blocks。`;
}

async function callClaude(settings, image) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "server-side-fallback-2026-07-01",
      // Required for calling the API directly from a browser context.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 16000,
      output_config: {
        effort: settings.effort,
        format: { type: "json_schema", schema: BLOCKS_SCHEMA },
      },
      fallbacks: "default",
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

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || res.statusText;
    if (res.status === 401) throw new Error("API key 無效（401）。請到設定頁檢查。");
    if (res.status === 429) throw new Error("請求太頻繁或額度不足（429），請稍後再試。");
    throw new Error(`Claude API 錯誤 ${res.status}：${msg}`);
  }
  if (body.stop_reason === "refusal") {
    throw new Error("Claude 拒絕處理這一頁" + (body.stop_details?.explanation ? `：${body.stop_details.explanation}` : "。"));
  }
  if (body.stop_reason === "max_tokens") throw new Error("輸出被截斷（max_tokens），這一頁可能內容太多。");
  const text = (body.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    return JSON.parse(text).blocks || [];
  } catch (_) {
    throw new Error("無法解析 Claude 回傳的區塊資料。");
  }
}
