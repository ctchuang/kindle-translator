const FIELDS = { apiKey: "", effort: "low", targetLang: "繁體中文（台灣用語）" };
// Numbers, saved with the rest; an empty or out-of-range one saves the
// nearest allowed value (the default when empty).
const NUMBERS = { referenceTokens: { def: 16000, min: 2000, max: 100000 } };
// The page's one "translation mode" select maps onto two stored settings the
// background reads: engine ("ocr" | "vision") and the OCR quality level.
const MODE_SETTINGS = { engine: "ocr", quality: "review" };

// Checkboxes, saved with the rest.
const CHECKS = { prefetch: true, referencePages: false };

const mode = document.getElementById("mode");
const showEffort = () => (document.getElementById("effortRow").hidden = mode.value !== "vision");
mode.onchange = showEffort;

const numberDefaults = Object.fromEntries(Object.entries(NUMBERS).map(([k, n]) => [k, n.def]));

chrome.storage.sync.get({ ...FIELDS, ...numberDefaults, ...MODE_SETTINGS, ...CHECKS }).then((v) => {
  for (const k of [...Object.keys(FIELDS), ...Object.keys(NUMBERS)]) document.getElementById(k).value = v[k];
  for (const k of Object.keys(CHECKS)) document.getElementById(k).checked = v[k];
  mode.value = v.engine === "vision" ? "vision" : v.quality;
  if (!mode.value) mode.value = MODE_SETTINGS.quality; // unknown stored level
  showEffort();
});

document.getElementById("save").onclick = async () => {
  const v = {};
  for (const k of Object.keys(FIELDS)) v[k] = document.getElementById(k).value.trim();
  for (const [k, n] of Object.entries(NUMBERS)) {
    const x = Math.round(Number(document.getElementById(k).value.trim() || n.def));
    v[k] = Number.isFinite(x) ? Math.min(n.max, Math.max(n.min, x)) : n.def;
    document.getElementById(k).value = v[k];
  }
  for (const k of Object.keys(CHECKS)) v[k] = document.getElementById(k).checked;
  if (mode.value === "vision") v.engine = "vision";
  else Object.assign(v, { engine: "ocr", quality: mode.value });
  await chrome.storage.sync.set(v);
  await chrome.storage.sync.remove(["model", "textModel"]); // replaced by engine / quality
  document.getElementById("saved").textContent = "已儲存";
  setTimeout(() => (document.getElementById("saved").textContent = ""), 1500);
};

// Developer switch: on this computer only, so it's in local storage and
// takes effect at once rather than on 儲存.
const devCapture = document.getElementById("devCapture");
chrome.storage.local.get({ devCapture: false }).then((v) => {
  devCapture.checked = v.devCapture;
  if (v.devCapture) document.getElementById("developer").open = true;
});
devCapture.onchange = () => chrome.storage.local.set({ devCapture: devCapture.checked });

// The reference pages and name lists kept on this computer (background.js
// bookUpdate): all books, at once.
document.getElementById("clearReference").onclick = async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => /^(ref|names):/.test(k) || k === "refBooks" || k === "nameBooks");
  await chrome.storage.local.remove(keys);
  const books = new Set(keys.filter((k) => k.includes(":")).map((k) => k.slice(k.indexOf(":") + 1))).size;
  document.getElementById("cleared").textContent = books ? `已刪除 ${books} 本書的參考段落和人名對照表` : "沒有存下的參考段落或人名對照表";
};
