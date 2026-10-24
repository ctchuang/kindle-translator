const FIELDS = { apiKey: "", model: "claude-opus-5-5", effort: "low", targetLang: "繁體中文（台灣用語）" };

chrome.storage.sync.get(FIELDS).then((v) => {
  for (const k of Object.keys(FIELDS)) document.getElementById(k).value = v[k];
});
chrome.storage.sync.get({ overlay: true }).then(({ overlay }) => (document.getElementById("overlay").checked = overlay));

document.getElementById("save").onclick = async () => {
  const v = {};
  for (const k of Object.keys(FIELDS)) v[k] = document.getElementById(k).value.trim();
  v.overlay = document.getElementById("overlay").checked;
  await chrome.storage.sync.set(v);
  document.getElementById("saved").textContent = "已儲存";
  setTimeout(() => (document.getElementById("saved").textContent = ""), 1500);
};
