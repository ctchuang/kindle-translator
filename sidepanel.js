const port = chrome.runtime.connect({ name: "sidepanel" });
const list = document.getElementById("list");
const status = document.getElementById("status");
const auto = document.getElementById("auto");

function setStatus(text, isErr = false) {
  status.textContent = text;
  status.className = isErr ? "err" : "";
}

function addPage(text, cached) {
  list.querySelector(".empty")?.remove();
  const el = document.createElement("article");
  el.className = "page";
  const meta = document.createElement("div");
  meta.className = "meta";
  const time = document.createElement("span");
  time.textContent = new Date().toLocaleTimeString() + (cached ? "（快取）" : "");
  const copy = document.createElement("a");
  copy.textContent = "複製";
  copy.onclick = () => navigator.clipboard.writeText(text).then(() => (copy.textContent = "已複製"));
  meta.append(time, copy);
  const body = document.createElement("div");
  body.textContent = text;
  el.append(meta, body);
  list.prepend(el); // newest page on top
}

port.onMessage.addListener((msg) => {
  if (msg.type === "working") setStatus("辨識並翻譯中…");
  if (msg.type === "result") {
    setStatus("");
    addPage(msg.text, msg.cached);
  }
  if (msg.type === "warn") setStatus(msg.text, true);
  if (msg.type === "error") {
    setStatus(msg.text, true);
    if (msg.needsKey) chrome.runtime.openOptionsPage();
  }
});

document.getElementById("translate").onclick = () => port.postMessage({ type: "translateNow" });
document.getElementById("options").onclick = () => chrome.runtime.openOptionsPage();
document.getElementById("clear").onclick = () => {
  list.innerHTML = '<p class="empty">已清空。</p>';
};

chrome.storage.sync.get({ autoTranslate: true }).then(({ autoTranslate }) => (auto.checked = autoTranslate));
auto.onchange = () => chrome.storage.sync.set({ autoTranslate: auto.checked });
