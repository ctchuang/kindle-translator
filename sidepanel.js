const list = document.getElementById("list");
const status = document.getElementById("status");
const auto = document.getElementById("auto");

const logEl = document.getElementById("log");
const MAX_LOG_LINES = 300;

let workingSince = null;
let ticker = null;

function setStatus(text, isErr = false) {
  stopTicker();
  status.textContent = text;
  status.className = isErr ? "err" : "";
}

// While a page is being translated, show how long we've been waiting.
function startTicker() {
  stopTicker();
  workingSince = Date.now();
  const tick = () => (status.textContent = `辨識並翻譯中… ${Math.round((Date.now() - workingSince) / 1000)} 秒`);
  tick();
  status.className = "busy";
  ticker = setInterval(tick, 1000);
}

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}

let lastLogAt = null;

function addLog(text, at = Date.now(), isErr = false, image = null) {
  const line = document.createElement("div");
  const gap = lastLogAt ? ` +${((at - lastLogAt) / 1000).toFixed(1)}s` : "";
  lastLogAt = at;
  const t = new Date(at);
  const hms = t.toLocaleTimeString("zh-TW", { hour12: false }) + "." + String(t.getMilliseconds()).padStart(3, "0");
  line.textContent = `${hms}${gap}  ${text}`;
  if (isErr) line.className = "err";
  if (image) {
    const img = document.createElement("img");
    img.src = image;
    img.title = "點一下放大／縮小";
    img.onclick = () => img.classList.toggle("big");
    img.onload = () => (logEl.scrollTop = logEl.scrollHeight); // it adds height once loaded
    line.append(img);
  }
  logEl.append(line);
  while (logEl.childElementCount > MAX_LOG_LINES) logEl.firstElementChild.remove();
  logEl.scrollTop = logEl.scrollHeight; // always show the newest line
}

function addPage(text, cached, fallbackModel, summary) {
  list.querySelector(".empty")?.remove();
  const el = document.createElement("article");
  el.className = "page";
  const meta = document.createElement("div");
  meta.className = "meta";
  const time = document.createElement("span");
  time.textContent =
    new Date().toLocaleTimeString() +
    (cached ? "（快取）" : "") +
    (summary ? "（摘要，非完整翻譯）" : "") +
    (fallbackModel ? `（被拒後由 ${fallbackModel} 完成）` : "");
  const copy = document.createElement("a");
  copy.textContent = "複製";
  copy.onclick = () => navigator.clipboard.writeText(text).then(() => (copy.textContent = "已複製"));
  meta.append(time, copy);
  const body = document.createElement("div");
  body.textContent = text;
  el.append(meta, body);
  list.prepend(el); // newest page on top
}

function onMessage(msg) {
  if (msg.type === "log") addLog(msg.text, msg.at, /^失敗|沒有顯示|沒有可用|中斷|超過/.test(msg.text), msg.image);
  if (msg.type === "working") startTicker();
  // The button retranslates (skipping the cache) only while the translation on
  // screen is for the page still showing; otherwise it's the plain action.
  if (msg.type === "pageState") {
    // retranslate: the screen shows a page that already has a translation.
    translateBtn.textContent = msg.retranslate ? "重新翻譯本頁" : "翻譯這一頁";
    document.getElementById("overlayHint").hidden = msg.retranslate;
  }
  if (msg.type === "idle" && ticker) setStatus("");
  if (msg.type === "result") {
    setStatus("");
    addPage(msg.text, msg.cached, msg.fallbackModel, msg.summary);
  }
  if (msg.type === "warn") setStatus(msg.text, true);
  if (msg.type === "error") {
    setStatus(msg.text, true);
    if (msg.needsKey) chrome.runtime.openOptionsPage();
  }
}

// Chrome may stop the background service worker; that drops the port and any
// request it was running. Say so in the log and reconnect.
let port;
function connect() {
  port = chrome.runtime.connect({ name: "sidepanel" });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    // Chrome stops an idle service worker every ~30 s; that's normal and not
    // worth logging. It only matters if a translation was in progress.
    if (ticker) {
      addLog("翻譯進行中背景程式被中斷（service worker 被 Chrome 停掉），這次請求遺失", Date.now(), true);
      setStatus("背景程式中斷，請再按一次「翻譯這一頁」", true);
    }
    setTimeout(connect, 500);
  });
}
connect();

const translateBtn = document.getElementById("translate");
translateBtn.onclick = () => port.postMessage({ type: "translateNow" });
document.getElementById("options").onclick = () => chrome.runtime.openOptionsPage();
document.getElementById("clearLog").onclick = (e) => {
  e.preventDefault(); // don't toggle the <details>
  logEl.replaceChildren();
  lastLogAt = null;
};
document.getElementById("clear").onclick = () => {
  list.innerHTML = '<p class="empty">已清空。</p>';
};

chrome.storage.sync.get({ autoTranslate: true }).then(({ autoTranslate }) => (auto.checked = autoTranslate));
auto.onchange = () => chrome.storage.sync.set({ autoTranslate: auto.checked });

// Translation / original switch. The setting is the single source of truth:
// the page's floating button writes it too, and the background and the page
// react to the change.
const overlayButtons = document.querySelectorAll("#overlay button");
function showOverlayState(on) {
  for (const b of overlayButtons) b.setAttribute("aria-checked", String(b.dataset.on === String(on)));
}
chrome.storage.sync.get({ overlay: true }).then((v) => showOverlayState(v.overlay));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.overlay) showOverlayState(changes.overlay.newValue);
});
for (const b of overlayButtons) b.onclick = () => chrome.storage.sync.set({ overlay: b.dataset.on === "true" });
