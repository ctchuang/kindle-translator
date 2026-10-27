const FIELDS = { apiKey: "", effort: "low", targetLang: "繁體中文（台灣用語）" };
// The page's one "translation mode" select maps onto two stored settings the
// background reads: engine ("ocr" | "vision") and the OCR quality level.
const MODE_SETTINGS = { engine: "ocr", quality: "review" };

// Checkboxes, saved with the rest.
const CHECKS = { prefetch: true };

const mode = document.getElementById("mode");
const showEffort = () => (document.getElementById("effortRow").hidden = mode.value !== "vision");
mode.onchange = showEffort;

chrome.storage.sync.get({ ...FIELDS, ...MODE_SETTINGS, ...CHECKS }).then((v) => {
  for (const k of Object.keys(FIELDS)) document.getElementById(k).value = v[k];
  for (const k of Object.keys(CHECKS)) document.getElementById(k).checked = v[k];
  mode.value = v.engine === "vision" ? "vision" : v.quality;
  if (!mode.value) mode.value = MODE_SETTINGS.quality; // unknown stored level
  showEffort();
});

document.getElementById("save").onclick = async () => {
  const v = {};
  for (const k of Object.keys(FIELDS)) v[k] = document.getElementById(k).value.trim();
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
