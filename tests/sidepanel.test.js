const test = require("node:test");
const assert = require("node:assert/strict");
const { TIME_SCALE, plain, waitFor } = require("./helpers/load");
const { createChrome } = require("./helpers/chrome");
const { loadPage } = require("./helpers/dom");

function setup(t, { sync = {} } = {}) {
  const chrome = createChrome({ sync });
  const copied = [];
  const navigator = { clipboard: { writeText: async (s) => void copied.push(s) } };
  const page = loadPage(["sidepanel.js"], { chrome, html: "sidepanel.html", globals: { navigator } });
  t.after(() => page.close());
  // The background's end of the newest port.
  const port = () => chrome._.connectPorts.at(-1);
  const received = [];
  const listen = (p) => p.onMessage.addListener((m) => received.push(plain(m)));
  listen(port());
  const post = (msg) => port().postMessage(msg);
  const $ = page.$;
  const logLines = () => $("log").children;
  return { chrome, page, port, post, received, listen, copied, $, logLines };
}

test("connects a port named sidepanel", (t) => {
  const s = setup(t);
  assert.equal(s.chrome._.connectPorts.length, 1);
  assert.equal(s.port().name, "sidepanel");
});

// ---- Log ----

test("log lines show the time, the gap since the previous line, and the text", (t) => {
  const s = setup(t);
  const at = new Date(2026, 0, 1, 9, 5, 7, 42).getTime();
  s.post({ type: "log", text: "截圖完成", at });
  s.post({ type: "log", text: "辨識完成", at: at + 1500 });
  const [first, second] = s.logLines();
  assert.match(first.textContent, /^0?9:05:07\.042  截圖完成$/);
  assert.match(second.textContent, /^0?9:05:08\.542 \+1\.5s  辨識完成$/);
  assert.equal(first.className, "");
});

test("log lines that report a problem are highlighted", (t) => {
  const s = setup(t);
  const problems = ["失敗：API 回應 500", "沒有顯示譯文", "沒有可用的 key", "中斷了", "超過時間"];
  for (const text of [...problems, "一切正常", "翻譯失敗"]) s.post({ type: "log", text, at: Date.now() });
  assert.deepEqual(
    s.logLines().map((l) => l.className),
    [...problems.map(() => "err"), "", ""] // only at the start of the line
  );
});

test("a log line can carry an image that toggles size on click", (t) => {
  const s = setup(t);
  s.post({ type: "log", text: "裁切", at: Date.now(), image: "data:image/png;base64,AAAA" });
  const img = s.logLines()[0].querySelector("img");
  assert.equal(img.src, "data:image/png;base64,AAAA");
  img.click();
  assert.ok(img.classList.contains("big"));
  img.click();
  assert.ok(!img.classList.contains("big"));
});

test("the log keeps only the newest 300 lines", (t) => {
  const s = setup(t);
  for (let i = 0; i < 305; i++) s.post({ type: "log", text: `line ${i}`, at: 1000 + i });
  assert.equal(s.$("log").childElementCount, 300);
  assert.match(s.logLines()[0].textContent, /  line 5$/);
  assert.match(s.logLines().at(-1).textContent, /  line 304$/);
});

test("clearing the log empties it and restarts the gaps", (t) => {
  const s = setup(t);
  s.post({ type: "log", text: "a", at: 1000 });
  const ok = s.page.fire(s.$("clearLog"), "click", { cancelable: true });
  assert.equal(ok, false, "doesn't toggle the <details>");
  assert.equal(s.$("log").childElementCount, 0);
  s.post({ type: "log", text: "b", at: 5000 });
  assert.doesNotMatch(s.logLines()[0].textContent, /\+/);
});

// ---- Status ----

test("working shows a ticker; idle and result stop it", (t) => {
  const s = setup(t);
  s.post({ type: "working" });
  assert.equal(s.$("status").textContent, "辨識並翻譯中… 0 秒");
  assert.equal(s.$("status").className, "busy");
  s.post({ type: "idle" });
  assert.equal(s.$("status").textContent, "");
  assert.equal(s.$("status").className, "");
  s.post({ type: "working" });
  s.post({ type: "result", text: "譯文" });
  assert.equal(s.$("status").textContent, "");
});

test("idle doesn't erase a warning when nothing was running", (t) => {
  const s = setup(t);
  s.post({ type: "warn", text: "這頁看起來是空白的" });
  s.post({ type: "idle" });
  assert.equal(s.$("status").textContent, "這頁看起來是空白的");
  assert.equal(s.$("status").className, "err");
});

test("the ticker counts the seconds", async (t) => {
  const s = setup(t);
  // The interval is sped up but the clock isn't; move the context's clock.
  const ctxDate = s.page.ctx.run("Date");
  const start = Date.now();
  ctxDate.now = () => start;
  s.post({ type: "working" });
  ctxDate.now = () => start + 3000;
  await waitFor(() => s.$("status").textContent === "辨識並翻譯中… 3 秒", { what: "ticker" });
  s.post({ type: "idle" });
});

test("errors show in the status; a missing key opens the options page", (t) => {
  const s = setup(t);
  s.post({ type: "error", text: "API 錯誤" });
  assert.equal(s.$("status").textContent, "API 錯誤");
  assert.equal(s.$("status").className, "err");
  assert.equal(s.chrome._.optionsOpened, 0);
  s.post({ type: "error", text: "請先設定 API key", needsKey: true });
  assert.equal(s.chrome._.optionsOpened, 1);
});

test("pageState switches the button label and the overlay hint", (t) => {
  const s = setup(t);
  s.post({ type: "pageState", retranslate: true });
  assert.equal(s.$("translate").textContent, "重新翻譯本頁");
  assert.equal(s.$("overlayHint").hidden, true);
  s.post({ type: "pageState", retranslate: false });
  assert.equal(s.$("translate").textContent, "翻譯這一頁");
  assert.equal(s.$("overlayHint").hidden, false);
});

test("layoutState shows the model's state", (t) => {
  const s = setup(t);
  s.post({ type: "layoutState", text: "DocLayout-YOLO：已載入（WebGPU）", level: "ok" });
  assert.equal(s.$("layoutState").textContent, "DocLayout-YOLO：已載入（WebGPU）");
  assert.equal(s.$("layoutState").className, "ok");
});

// ---- Pages ----

test("results are added newest first, with their labels", (t) => {
  const s = setup(t);
  assert.ok(s.$("list").querySelector(".empty"));
  s.post({ type: "result", text: "第一頁" });
  assert.equal(s.$("list").querySelector(".empty"), null, "the placeholder goes away");
  s.post({ type: "result", text: "第二頁", cached: true });
  s.post({ type: "result", text: "第三頁", summary: true });
  s.post({ type: "result", text: "第四頁", fallbackModel: "Opus" });
  const pages = s.$("list").querySelectorAll("article.page");
  const bodies = pages.map((p) => p.children[1].textContent);
  assert.deepEqual(bodies, ["第四頁", "第三頁", "第二頁", "第一頁"]);
  const meta = (p) => p.querySelector(".meta span").textContent;
  assert.doesNotMatch(meta(pages[3]), /（/);
  assert.match(meta(pages[2]), /（快取）$/);
  assert.match(meta(pages[1]), /（摘要，非完整翻譯）$/);
  assert.match(meta(pages[0]), /（被拒後由 Opus 完成）$/);
});

test("a page's copy link copies its text", async (t) => {
  const s = setup(t);
  s.post({ type: "result", text: "要複製的譯文" });
  const copy = s.$("list").querySelector(".meta a");
  copy.click();
  await waitFor(() => copy.textContent === "已複製", { what: "copied" });
  assert.deepEqual(s.copied, ["要複製的譯文"]);
});

test("clear empties the page list", (t) => {
  const s = setup(t);
  s.post({ type: "result", text: "第一頁" });
  s.$("clear").click();
  assert.equal(s.$("list").querySelectorAll("article").length, 0);
  const empty = s.$("list").querySelector("p.empty");
  assert.equal(empty.textContent, "已清空。");
  // The next result replaces the placeholder again.
  s.post({ type: "result", text: "第二頁" });
  assert.equal(s.$("list").querySelector(".empty"), null);
});

// ---- Buttons and settings ----

test("the translate button asks the background to translate now", (t) => {
  const s = setup(t);
  s.$("translate").click();
  assert.deepEqual(s.received, [{ type: "translateNow" }]);
});

test("the settings button opens the options page", (t) => {
  const s = setup(t);
  s.$("options").click();
  assert.equal(s.chrome._.optionsOpened, 1);
});

test("the auto-translate checkbox mirrors the setting", async (t) => {
  const s = setup(t, { sync: { autoTranslate: false } });
  const auto = s.$("auto");
  auto.checked = true; // as if the user hadn't touched it yet
  await waitFor(() => auto.checked === false, { what: "setting read" });
  auto.checked = true;
  s.page.fire(auto, "change");
  await waitFor(() => s.chrome.storage.sync.data.get("autoTranslate") === true, { what: "saved" });
});

test("auto-translate defaults to on", async (t) => {
  const s = setup(t);
  await waitFor(() => s.$("auto").checked === true, { what: "setting read" });
});

test("the overlay switch shows and writes the setting", async (t) => {
  const s = setup(t, { sync: { overlay: false } });
  const [on, off] = s.$("overlay").querySelectorAll("button");
  const state = () => [on.getAttribute("aria-checked"), off.getAttribute("aria-checked")];
  await waitFor(() => state()[1] === "true", { what: "setting read" });
  assert.deepEqual(state(), ["false", "true"]);
  on.click();
  await waitFor(() => s.chrome.storage.sync.data.get("overlay") === true, { what: "saved" });
  assert.deepEqual(state(), ["true", "false"], "follows the change it made");
  // The page's floating button writes the same setting.
  await s.chrome.storage.sync.set({ overlay: false });
  assert.deepEqual(state(), ["false", "true"]);
  // Other areas don't count.
  await s.chrome.storage.local.set({ overlay: true });
  assert.deepEqual(state(), ["false", "true"]);
});

// ---- Reconnecting ----

test("a dropped port while idle reconnects quietly", async (t) => {
  const s = setup(t);
  s.port().disconnect();
  await waitFor(() => s.chrome._.connectPorts.length === 2, { what: "reconnect" });
  assert.equal(s.$("log").childElementCount, 0);
  // The new port works both ways.
  s.listen(s.port());
  s.$("translate").click();
  assert.deepEqual(s.received, [{ type: "translateNow" }]);
  s.post({ type: "result", text: "新的連線" });
  assert.equal(s.$("list").querySelector("article").children[1].textContent, "新的連線");
});

test("a dropped port mid-translation says the request was lost", async (t) => {
  const s = setup(t);
  s.post({ type: "working" });
  s.port().disconnect();
  const [line] = s.logLines();
  assert.match(line.textContent, /翻譯進行中背景程式被中斷/);
  assert.equal(line.className, "err");
  assert.equal(s.$("status").textContent, "背景程式中斷，請再按一次「翻譯這一頁」");
  assert.equal(s.$("status").className, "err");
  await waitFor(() => s.chrome._.connectPorts.length === 2, { what: "reconnect" });
  // The ticker stopped, so a second drop isn't reported again.
  s.port().disconnect();
  await waitFor(() => s.chrome._.connectPorts.length === 3, { what: "reconnect again" });
  assert.equal(s.$("log").childElementCount, 1);
  await new Promise((r) => setTimeout(r, 1000 / TIME_SCALE));
});

// ---- Screenshot for tests ----

test("the screenshot link asks the worker for a capture", (t) => {
  const s = setup(t);
  const ok = s.page.fire(s.$("saveShot"), "click", { cancelable: true });
  assert.equal(ok, false, "doesn't toggle the <details>");
  assert.deepEqual(s.received, [{ type: "captureNow" }]);
});

test("a screenshot from the worker is saved as a download", (t) => {
  const s = setup(t);
  const clicked = [];
  const create = s.page.document.createElement.bind(s.page.document);
  s.page.document.createElement = (tag) => {
    const el = create(tag);
    if (tag === "a") el.click = () => clicked.push({ href: el.href, download: el.download });
    return el;
  };
  s.post({ type: "screenshot", dataUrl: "data:image/jpeg;base64,AAAA", filename: "kindle-B0X-20261026-101500.jpg" });
  assert.deepEqual(clicked, [{ href: "data:image/jpeg;base64,AAAA", download: "kindle-B0X-20261026-101500.jpg" }]);
});
