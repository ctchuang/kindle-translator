const FIELDS = { apiKey: "", effort: "low", targetLang: "繁體中文（台灣用語）" };
// The page's one "translation mode" select maps onto two stored settings the
// background reads: engine ("ocr" | "vision") and the OCR quality level.
const MODE_SETTINGS = { engine: "ocr", quality: "haiku" };

const mode = document.getElementById("mode");
const showEffort = () => (document.getElementById("effortRow").hidden = mode.value !== "vision");
mode.onchange = showEffort;

chrome.storage.sync.get({ ...FIELDS, ...MODE_SETTINGS }).then((v) => {
  for (const k of Object.keys(FIELDS)) document.getElementById(k).value = v[k];
  mode.value = v.engine === "vision" ? "vision" : v.quality;
  if (!mode.value) mode.value = MODE_SETTINGS.quality; // unknown stored level
  showEffort();
});

document.getElementById("save").onclick = async () => {
  const v = {};
  for (const k of Object.keys(FIELDS)) v[k] = document.getElementById(k).value.trim();
  if (mode.value === "vision") v.engine = "vision";
  else Object.assign(v, { engine: "ocr", quality: mode.value });
  await chrome.storage.sync.set(v);
  await chrome.storage.sync.remove(["model", "textModel"]); // replaced by engine / quality
  document.getElementById("saved").textContent = "已儲存";
  setTimeout(() => (document.getElementById("saved").textContent = ""), 1500);
};
