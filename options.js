const FIELDS = { apiKey: "", effort: "low", targetLang: "繁體中文（台灣用語）" };

chrome.storage.sync.get(FIELDS).then((v) => {
  for (const k of Object.keys(FIELDS)) document.getElementById(k).value = v[k];
});

document.getElementById("save").onclick = async () => {
  const v = {};
  for (const k of Object.keys(FIELDS)) v[k] = document.getElementById(k).value.trim();
  await chrome.storage.sync.set(v);
  await chrome.storage.sync.remove("model"); // left over from when the model was selectable
  document.getElementById("saved").textContent = "已儲存";
  setTimeout(() => (document.getElementById("saved").textContent = ""), 1500);
};
