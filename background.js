// Service worker: captures the visible Kindle page, asks Claude to transcribe
// and translate it, and pushes results to the side panel.

const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "low",
  autoTranslate: true,
  targetLang: "繁體中文（台灣用語）",
};

const READER_RE = /^https:\/\/read\.amazon\.(com|co\.jp|co\.uk|de|ca|com\.au)\//;

let panelPorts = new Set();
let lastHash = null;
let busy = false;
let pending = false;
const cache = new Map(); // screenshot hash -> translation (session only)

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

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
    const hash = await sha256(dataUrl);
    if (!force && hash === lastHash) return; // page didn't actually change
    lastHash = hash;

    if (cache.has(hash)) {
      broadcast({ type: "result", text: cache.get(hash), cached: true, thumb: dataUrl });
      return;
    }

    broadcast({ type: "working", thumb: dataUrl });
    const text = await callClaude(settings, dataUrl.split(",")[1]);
    cache.set(hash, text);
    broadcast({ type: "result", text, thumb: dataUrl });
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

function buildPrompt(targetLang) {
  return `這是 Kindle Cloud Reader 的一張螢幕截圖。
1. 辨識截圖中的書本內文（忽略閱讀器介面、選單、頁碼、閱讀進度百分比等）。
2. 把內文完整翻譯成${targetLang}。保留段落分隔；標題、對話、清單維持原本的結構。
3. 只輸出譯文本身，不要加說明、不要附原文。
如果截圖中沒有書本內文（例如目錄載入中或空白頁），只輸出：（此頁無內文）`;
}

async function callClaude(settings, base64Jpeg) {
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
      output_config: { effort: settings.effort },
      fallbacks: "default",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Jpeg } },
            { type: "text", text: buildPrompt(settings.targetLang) },
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
  const text = (body.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (body.stop_reason === "max_tokens") return text + "\n\n（輸出被截斷）";
  return text || "（沒有取得譯文）";
}
