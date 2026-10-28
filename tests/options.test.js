const test = require("node:test");
const assert = require("node:assert/strict");
const { plain, waitFor } = require("./helpers/load");
const { createChrome } = require("./helpers/chrome");
const { loadPage } = require("./helpers/dom");

async function setup(t, sync = {}) {
  const chrome = createChrome({ sync });
  const page = loadPage(["options.js"], { chrome, html: "options.html" });
  t.after(() => page.close());
  const $ = page.$;
  // Loading is done once showEffort has run, which sets `hidden` either way.
  $("effortRow").hidden = null;
  await waitFor(() => $("effortRow").hidden !== null, { what: "settings loaded" });
  const stored = () => plain(Object.fromEntries(chrome.storage.sync.data));
  return { chrome, page, $, stored };
}

const save = async (s) => {
  s.$("save").click();
  await waitFor(() => s.$("saved").textContent === "已儲存", { what: "saved" });
};

test("loads the defaults into the fields", async (t) => {
  const s = await setup(t);
  assert.equal(s.$("apiKey").value, "");
  assert.equal(s.$("effort").value, "low");
  assert.equal(s.$("targetLang").value, "繁體中文（台灣用語）");
  assert.equal(s.$("mode").value, "review");
  assert.equal(s.$("effortRow").hidden, true);
  assert.equal(s.$("prefetch").checked, true, "prefetching is on by default");
});

test("loads stored fields and maps engine and quality to the mode", async (t) => {
  const s = await setup(t, { apiKey: "sk-ant-x", effort: "high", targetLang: "日本語", engine: "ocr", quality: "haiku" });
  assert.equal(s.$("apiKey").value, "sk-ant-x");
  assert.equal(s.$("effort").value, "high");
  assert.equal(s.$("targetLang").value, "日本語");
  assert.equal(s.$("mode").value, "haiku");
  assert.equal(s.$("effortRow").hidden, true);
});

test("the vision engine wins over the quality level and shows the effort row", async (t) => {
  const s = await setup(t, { engine: "vision", quality: "haiku" });
  assert.equal(s.$("mode").value, "vision");
  assert.equal(s.$("effortRow").hidden, false);
});

test("an unknown stored quality level falls back to review", async (t) => {
  const s = await setup(t, { engine: "ocr", quality: "turbo" });
  assert.equal(s.$("mode").value, "review");
});

test("the effort row follows the mode select", async (t) => {
  const s = await setup(t);
  const mode = s.$("mode");
  mode.value = "vision";
  s.page.fire(mode, "change");
  assert.equal(s.$("effortRow").hidden, false);
  mode.value = "haiku";
  s.page.fire(mode, "change");
  assert.equal(s.$("effortRow").hidden, true);
});

test("saving an OCR mode writes trimmed fields, engine and quality, and drops legacy keys", async (t) => {
  const s = await setup(t, { model: "claude-old", textModel: "claude-older", overlay: false });
  s.$("apiKey").value = "  sk-ant-new \n";
  s.$("targetLang").value = " 繁體中文（香港用語） ";
  s.$("effort").value = "medium";
  s.$("mode").value = "haiku";
  await save(s);
  assert.deepEqual(s.stored(), {
    apiKey: "sk-ant-new",
    effort: "medium",
    targetLang: "繁體中文（香港用語）",
    engine: "ocr",
    quality: "haiku",
    prefetch: true,
    referencePages: false,
    referenceTokens: 16000,
    overlay: false, // other settings are left alone
  });
});

test("the reference switch and limit show and save, the limit kept in range", async (t) => {
  const s = await setup(t, { referencePages: true, referenceTokens: 32000 });
  assert.equal(s.$("referencePages").checked, true);
  assert.equal(s.$("referenceTokens").value, "32000");
  s.$("referencePages").checked = false;
  s.$("referenceTokens").value = "500";
  await save(s);
  assert.equal(s.stored().referencePages, false);
  assert.equal(s.stored().referenceTokens, 2000);
  assert.equal(s.$("referenceTokens").value, "2000", "the field shows what was saved");
  s.$("referenceTokens").value = "";
  await save(s);
  assert.equal(s.stored().referenceTokens, 16000);
  s.$("referenceTokens").value = "abc";
  await save(s);
  assert.equal(s.stored().referenceTokens, 16000);
});

test("the reference is off by default", async (t) => {
  const s = await setup(t);
  assert.equal(s.$("referencePages").checked, false);
  assert.equal(s.$("referenceTokens").value, "16000");
});

test("deleting the kept reference removes every book and nothing else", async (t) => {
  const s = await setup(t);
  await s.chrome.storage.local.set({ "ref:A:1": { paras: [] }, "ref:B:2": { paras: [] }, refBooks: { "ref:A:1": 1, "ref:B:2": 1 }, devCapture: true });
  s.$("clearReference").click();
  await waitFor(() => s.$("cleared").textContent, { what: "cleared note" });
  assert.equal(s.$("cleared").textContent, "已刪除 2 本書的參考段落");
  assert.deepEqual([...s.chrome.storage.local.data.keys()], ["devCapture"]);
  s.$("cleared").textContent = "";
  s.$("clearReference").click();
  await waitFor(() => s.$("cleared").textContent, { what: "cleared note" });
  assert.equal(s.$("cleared").textContent, "沒有存下的參考段落");
});

test("the prefetch checkbox shows and saves the setting", async (t) => {
  const s = await setup(t, { prefetch: false });
  assert.equal(s.$("prefetch").checked, false);
  s.$("prefetch").checked = true;
  await save(s);
  assert.equal(s.stored().prefetch, true);
  s.$("prefetch").checked = false;
  await save(s);
  assert.equal(s.stored().prefetch, false);
});

test("the options page no longer mentions the layout model or WebGPU", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "options.html"), "utf8");
  assert.doesNotMatch(html, /DocLayout|WebGPU/);
  assert.match(html, /receive-pages\.js/);
});

test("saving vision keeps the stored quality level for later", async (t) => {
  const s = await setup(t, { engine: "ocr", quality: "haiku" });
  s.$("mode").value = "vision";
  await save(s);
  assert.equal(s.stored().engine, "vision");
  assert.equal(s.stored().quality, "haiku");
});

test("the saved note clears itself", async (t) => {
  const s = await setup(t);
  await save(s);
  await waitFor(() => s.$("saved").textContent === "", { what: "note cleared" });
});

test("the developer switch is off by default and saved at once, on this computer only", async (t) => {
  const s = await setup(t);
  await waitFor(() => s.$("devCapture").checked === false);
  s.$("devCapture").checked = true;
  s.page.fire(s.$("devCapture"), "change");
  await waitFor(() => s.chrome.storage.local.data.get("devCapture") === true, { what: "saved to local storage" });
  assert.equal(s.chrome.storage.sync.data.has("devCapture"), false);
});

test("the developer section opens when the switch is on", async (t) => {
  const chrome = createChrome();
  await chrome.storage.local.set({ devCapture: true });
  const page = loadPage(["options.js"], { chrome, html: "options.html" });
  t.after(() => page.close());
  await waitFor(() => page.$("devCapture").checked === true, { what: "switch loaded" });
  assert.equal(page.$("developer").open, true);
});
