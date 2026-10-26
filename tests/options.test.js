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
    overlay: false, // other settings are left alone
  });
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
