// End-to-end runs of translateActivePage: screenshot → OCR → Claude → overlay
// and cache, with page turns, retries and failures along the way.

const test = require("node:test");
const assert = require("node:assert/strict");
const { plain, waitFor } = require("./helpers/load");
const { startExtension } = require("./helpers/extension");
const { parseScreenUrl } = require("./helpers/images");

// The page a request is for: the paragraphs start with the page name.
function pageOf(req) {
  const first = req.items?.[0];
  return (first?.text ?? first?.source ?? "").split(" ")[0];
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test.describe("OCR engine, polished mode (Haiku + Sonnet review)", () => {
  test("translates the page, draws it, caches it and posts it to the panel", async () => {
    const ext = startExtension();
    await ext.translate();

    const tr = ext.claude.of("translate");
    const rv = ext.claude.of("review");
    assert.equal(tr.length, 2, "two chunks translated side by side");
    assert.equal(rv.length, 2, "each chunk reviewed");
    for (const r of tr) {
      assert.equal(r.body.model, "claude-haiku-5-5");
      assert.deepEqual(r.body.thinking, { type: "disabled" });
    }
    for (const r of rv) {
      assert.equal(r.body.model, "claude-sonnet-5-5");
      assert.deepEqual(r.body.thinking, { type: "between_tools" });
    }
    assert.deepEqual(tr.flatMap((r) => r.items.map((p) => p.id)), [0, 1, 2, 3]);
    assert.deepEqual(rv.flatMap((r) => r.items.map((p) => p.id)), [0, 1, 2, 3]);
    assert.match(rv[0].items[0].draft, /^譯：p1 paragraph 1\./);

    const [overlay] = ext.overlaysSent();
    assert.equal(overlay.blocks.length, 4);
    assert.match(overlay.blocks[0].text, /^譯：p1 paragraph 1\./);
    for (const b of overlay.blocks) {
      assert.equal(b.box.length, 4);
      assert.ok(b.box.every((v) => v >= 0 && v <= 1));
      assert.match(b.bg, /^rgb\(\d+,\d+,\d+\)$/);
      assert.match(b.fg, /^rgb\(\d+,\d+,\d+\)$/);
    }
    assert.equal(ext.tab.overlay?.page, "p1");

    const [result] = ext.msgs("result");
    assert.match(result.text, /譯：p1 paragraph 1\.[^]*\n\n譯：p1 paragraph 2\./);
    assert.equal(result.fallbackModel, null);
    assert.equal(result.summary, false);
    assert.equal(ext.cachedPages(), 1);
    assert.ok(ext.session().shownSig, "the button now retranslates");
    assert.ok(ext.session().overlaySig, "screen with the overlay remembered for re-checks");
  });

  test("the reviewer's corrections replace the draft", async () => {
    const ext = startExtension({
      claude: (req) => req.kind === "review" && { json: { corrections: req.items.map((p) => ({ id: p.id, text: `校對：${p.id}` })), notes: "改了" } },
    });
    await ext.translate();
    const texts = ext.overlaysSent()[0].blocks.map((b) => b.text);
    assert.deepEqual(texts, ["校對：0", "校對：1", "校對：2", "校對：3"]);
    assert.ok(ext.hasLog(/校對完成：.*改了 2\/2 段：改了/));
    assert.ok(ext.hasLog(/校對第 1 段\n  初稿：譯：p1 paragraph 1\.[^\n]*\n  改為：校對：0/));
  });

  test("corrections for other ids, blank or unchanged ones are ignored", async () => {
    const ext = startExtension({
      claude: (req) =>
        req.kind === "review" && {
          json: {
            corrections: [
              { id: 99, text: "不在這段" },
              { id: req.items[0].id, text: "  " },
              { id: req.items[1].id, text: req.items[1].draft },
            ],
            notes: "",
          },
        },
    });
    await ext.translate();
    assert.ok(ext.overlaysSent()[0].blocks.every((b) => b.text.startsWith("譯：")));
    assert.ok(ext.hasLog(/改了 0\/2 段/));
  });

  test("a failed review keeps the draft", async () => {
    const ext = startExtension({ claude: (req) => req.kind === "review" && { status: 500, error: "oops" } });
    await ext.translate();
    assert.equal(ext.overlaysSent()[0].blocks.length, 4);
    assert.ok(ext.overlaysSent()[0].blocks.every((b) => b.text.startsWith("譯：")));
    assert.ok(ext.hasLog(/claude-sonnet-5-5 校對失敗（Claude API 錯誤 500：oops），沿用初稿/));
    assert.equal(ext.msgs("error").length, 0);
  });

  test("paragraphs the draft left blank aren't sent for review", async () => {
    const ext = startExtension({
      claude: (req) =>
        req.kind === "translate" && {
          json: { translations: req.items.map((p, i) => ({ id: p.id, text: i === 0 ? "" : `譯：${p.text}` })), notes: "", summarized: false },
        },
    });
    await ext.translate();
    assert.deepEqual(ext.claude.of("review").map((r) => r.items.length), [1, 1]);
    assert.equal(ext.overlaysSent()[0].blocks.length, 2, "blank blocks are dropped");
  });

  test("a chunk Haiku declines goes to Opus, which isn't reviewed", async () => {
    const ext = startExtension({
      claude: (req) =>
        req.kind === "translate" && req.body.model === "claude-haiku-5-5" && req.items[0].id === 0
          ? { json: { translations: [], notes: "版權", summarized: false } }
          : undefined,
    });
    await ext.translate();
    const opus = ext.claude.calls.filter((c) => c.body.model === "claude-opus-5-5");
    assert.equal(opus.length, 1);
    assert.equal(opus[0].kind, "translate");
    assert.equal(opus[0].headers["anthropic-beta"], plain(ext.ctx.run("FALLBACK")).beta);
    assert.deepEqual(opus[0].items.map((p) => p.id), [0, 1]);
    assert.equal(ext.claude.of("review").length, 1, "only Haiku's chunk is reviewed");
    assert.ok(ext.hasLog(/claude-haiku-5-5 沒有完整翻譯（版權），這部分改用 claude-opus-5-5/));
    assert.equal(ext.msgs("result")[0].fallbackModel, "claude-opus-5-5");
  });

  test("Haiku mode skips the review", async () => {
    const ext = startExtension({ settings: { quality: "haiku" } });
    await ext.translate();
    assert.equal(ext.claude.of("review").length, 0);
    assert.equal(ext.claude.of("translate").length, 2);
    assert.equal(ext.overlaysSent()[0].blocks.length, 4);
  });

  test("a short page goes in one request", async () => {
    const ext = startExtension({ book: { p1: ["One.", "Two two.", "Three three three."] } });
    await ext.translate();
    assert.equal(ext.claude.of("translate").length, 1);
    assert.equal(ext.claude.of("review").length, 1);
    assert.ok(!ext.hasLog(/\[1\/2\]/), "no chunk tags with one chunk");
  });

  test("a two-page spread is OCR'd per column and translated per column", async () => {
    const ext = startExtension({ screen: { spread: true } });
    await ext.translate();
    const [ocr] = ext.ocr.calls;
    assert.equal(ocr.rects.length, 2);
    assert.ok(ocr.rects[0].left + ocr.rects[0].width <= ocr.rects[1].left);
    assert.ok(ext.hasLog(/2 欄/));
    // Paragraphs 1–2 are on the left page, 3–4 on the right.
    assert.deepEqual(ext.claude.of("translate").map((r) => r.items.map((p) => p.text.split(" ").slice(0, 3).join(" "))), [
      ["p1 paragraph 1.", "p1 paragraph 2."],
      ["p1 paragraph 3.", "p1 paragraph 4."],
    ]);
    const boxes = ext.overlaysSent()[0].blocks.map((b) => b.box);
    assert.ok(boxes[2][0] > boxes[0][2], "right-page blocks sit right of the left page");
  });

  test("a page with no text isn't cached and says so", async () => {
    const ext = startExtension({ book: { p1: [] } });
    await ext.translate();
    assert.equal(ext.claude.calls.length, 0);
    assert.match(ext.msgs("warn")[0].text, /沒有任何譯文區塊（tesseract）：OCR 沒有辨識到任何文字/);
    assert.equal(ext.cachedPages(), 0);
    assert.ok(ext.received.some((m) => m.type === "log" && m.image), "the screenshot is attached to the log");
  });

  test("OCR reads only the book page image the reader drew", async () => {
    const ext = startExtension();
    await ext.translate();
    const { crop } = ext.ocr.calls[0].drawn;
    // 960×600 screenshot of a 960×600 viewport; the page image is 96–864 × 60–540.
    assert.deepEqual(crop, { sx: 96, sy: 60, sw: 768, sh: 480 });
    assert.ok(ext.hasLog(/OCR 範圍：書頁圖片（x 10–90%，y 10–90%）/));
  });

  test("the page image is mapped through the screen's pixel ratio", async () => {
    // A 960×600 screenshot of a 480×300 CSS-pixel viewport (2× screen).
    const ext = startExtension();
    ext.tab.geometry = { viewport: { width: 480, height: 300 }, dpr: 2, page: { left: 48, top: 15, right: 432, bottom: 285 } };
    await ext.translate();
    assert.deepEqual(ext.ocr.calls[0].drawn.crop, { sx: 96, sy: 30, sw: 768, sh: 540 });
  });

  test("without the page image's position, OCR falls back to a fixed share of the screen", async () => {
    for (const geometry of [null, { viewport: { width: 960, height: 600 }, dpr: 1, page: null }, { viewport: { width: 960, height: 600 }, page: { left: 0, top: 0, right: 50, bottom: 50 } }]) {
      const ext = startExtension();
      ext.tab.geometry = geometry;
      await ext.translate();
      const { crop } = ext.ocr.calls[0].drawn;
      const OCR_CROP = plain(ext.ctx.run("OCR_CROP"));
      assert.equal(crop.sx, 960 * OCR_CROP.x0);
      assert.equal(crop.sy, 600 * OCR_CROP.y0);
      assert.ok(Math.abs(crop.sw - 960 * (OCR_CROP.x1 - OCR_CROP.x0)) < 1e-9);
      assert.ok(ext.hasLog(/OCR 範圍：頁面沒有回報書頁位置，用預設範圍/));
    }
  });

  test("a page that can't answer still gets translated, with the fixed crop", async () => {
    const ext = startExtension();
    const handler = ext.chrome._.tabMessageHandler;
    ext.chrome._.tabMessageHandler = (id, msg, o) => {
      if (msg.type === "geometry") throw new Error("Frame removed");
      return handler(id, msg, o);
    };
    await ext.translate();
    assert.ok(ext.hasLog(/用預設範圍/));
    assert.equal(ext.overlaysSent().length, 1);
  });

  test("the vision engine asks for the page image only for the fingerprint", async () => {
    const ext = startExtension({ settings: { engine: "vision" } });
    await ext.translate();
    assert.ok(ext.chrome._.tabMessages.some((m) => m.msg.type === "geometry"));
    assert.equal(ext.ocr.calls.length, 0);
    assert.equal(ext.claude.calls[0].body.messages[0].content[0].type, "image", "still the whole screenshot");
  });

  test("the offscreen document is created once", async () => {
    const ext = startExtension();
    await ext.translate();
    await ext.turnTo("p2");
    await ext.idle();
    assert.equal(ext.chrome._.offscreenCreated, 1);
    assert.equal(ext.ocr.calls.length, 2);
  });

  test("an OCR failure is shown as an error", async () => {
    const ext = startExtension();
    ext.ocr.handler = () => ({ error: "worker crashed" });
    await ext.translate();
    assert.match(ext.msgs("error")[0].text, /OCR 失敗：worker crashed/);
    assert.equal(ext.claude.calls.length, 0);
  });

  test("a layout model failure is shown on the status line and as an error", async () => {
    const ext = startExtension();
    ext.ocr.handler = () => ({ error: "DocLayout-YOLO 無法使用：沒有 WebGPU" });
    await ext.translate();
    assert.ok(ext.msgs("layoutState").some((m) => m.level === "err" && /沒有 WebGPU/.test(m.text)));
    assert.match(ext.msgs("error")[0].text, /DocLayout-YOLO 無法使用/);
  });

  test("the layout model's result goes to the status line", async () => {
    const ext = startExtension();
    await ext.translate();
    assert.ok(ext.msgs("layoutState").some((m) => m.level === "ok" && /4 個區塊，0 個圖、表或公式保留原文，7 毫秒/.test(m.text)));
  });
});

test.describe("vision engine (Opus reads the screenshot)", () => {
  const blocks = [
    { kind: "heading", x0: 140, y0: 70, x1: 820, y1: 100, lines: 1, text: "第一章" },
    { kind: "paragraph", x0: 140, y0: 110, x1: 820, y1: 300, lines: 6, text: "內文" },
    { kind: "paragraph", x0: 10, y0: 10, x1: 12, y1: 12, lines: 1, text: "太小" },
  ];

  test("sends the screenshot to Opus with the configured effort", async () => {
    const ext = startExtension({ settings: { engine: "vision", effort: "high" }, claude: () => ({ json: { blocks, notes: "", summarized: false } }) });
    await ext.translate();
    const [req] = ext.claude.calls;
    assert.equal(req.kind, "vision");
    assert.equal(req.body.model, "claude-opus-5-5");
    assert.equal(req.body.output_config.effort, "high");
    assert.equal(req.body.messages[0].content[0].type, "image");
    assert.equal(req.body.messages[0].content[0].source.media_type, "image/jpeg");
    assert.match(req.body.messages[0].content[1].text, /960×600/);
    assert.ok(req.headers["anthropic-beta"]);
    assert.equal(ext.ocr.calls.length, 0, "no OCR");
    const sent = ext.overlaysSent()[0].blocks;
    assert.deepEqual(sent.map((b) => b.text), ["第一章", "內文"]);
    assert.deepEqual(sent[1].box, [140 / 960, 110 / 600, 820 / 960, 300 / 600]);
  });

  test("a summary is retried once, then shown but not cached", async () => {
    const ext = startExtension({ settings: { engine: "vision" }, claude: () => ({ json: { blocks, notes: "只能提供摘要", summarized: true } }) });
    await ext.translate();
    assert.equal(ext.claude.calls.length, 2);
    assert.equal(ext.msgs("result")[0].summary, true);
    assert.match(ext.msgs("warn").at(-1).text, /只給了摘要/);
    assert.equal(ext.cachedPages(), 0);
  });

  test("a summary followed by a translation keeps the translation", async () => {
    const ext = startExtension({
      settings: { engine: "vision" },
      claude: (req) => ({ json: { blocks, notes: "", summarized: req.n === 0 } }),
    });
    await ext.translate();
    assert.equal(ext.claude.calls.length, 2);
    assert.equal(ext.msgs("result")[0].summary, false);
    assert.equal(ext.cachedPages(), 1);
  });

  test("a fallback model answering is reported to the panel", async () => {
    const ext = startExtension({ settings: { engine: "vision" }, claude: () => ({ model: "claude-opus-4-8", json: { blocks, notes: "", summarized: false } }) });
    await ext.translate();
    assert.equal(ext.msgs("result")[0].fallbackModel, "claude-opus-4-8");
  });

  test("no usable blocks: warning with the reason, not cached", async () => {
    const ext = startExtension({ settings: { engine: "vision" }, claude: () => ({ json: { blocks: [], notes: "載入中", summarized: false } }) });
    await ext.translate();
    assert.match(ext.msgs("warn")[0].text, /沒有任何譯文區塊（claude-opus-5-5）：載入中/);
    assert.equal(ext.cachedPages(), 0);
    assert.equal(ext.overlaysSent().length, 0);
  });
});

test.describe("errors before and during a request", () => {
  test("not a Kindle tab", async () => {
    const ext = startExtension();
    ext.chrome._.activeTab = { id: 2, windowId: 1, url: "https://example.com/", active: true };
    await ext.translate();
    assert.equal(ext.msgs("error")[0].text, "目前分頁不是 Kindle Cloud Reader。");
    assert.equal(ext.chrome._.captures, 0);
  });

  test("no active tab", async () => {
    const ext = startExtension();
    ext.chrome._.activeTab = null;
    await ext.translate();
    assert.equal(ext.msgs("error")[0].text, "目前分頁不是 Kindle Cloud Reader。");
  });

  for (const host of ["read.amazon.co.jp", "read.amazon.co.uk", "read.amazon.de", "read.amazon.ca", "read.amazon.com.au"]) {
    test(`works on ${host}`, async () => {
      const ext = startExtension();
      ext.chrome._.activeTab.url = `https://${host}/?asin=X`;
      await ext.translate();
      assert.equal(ext.msgs("error").length, 0);
      assert.equal(ext.overlaysSent().length, 1);
    });
  }

  test("no API key asks for one", async () => {
    const ext = startExtension({ settings: { apiKey: "" } });
    await ext.translate();
    assert.deepEqual(plain(ext.msgs("error")[0]), { type: "error", text: "請先到設定頁填入 Anthropic API key。", needsKey: true });
    assert.equal(ext.chrome._.captures, 0);
  });

  test("an API error is shown and nothing is cached", async () => {
    const ext = startExtension({ claude: () => ({ status: 401 }) });
    await ext.translate();
    assert.match(ext.msgs("error")[0].text, /API key 無效（401）/);
    assert.ok(ext.hasLog(/^失敗：API key 無效/));
    assert.equal(ext.cachedPages(), 0);
  });

  test("a refusal is shown with its category", async () => {
    const ext = startExtension({ claude: () => ({ stop_reason: "refusal", stop_details: { category: "bio" }, content: [] }) });
    await ext.translate();
    assert.match(ext.msgs("error")[0].text, /類別：生物安全（bio）/);
  });

  test("the panel hears 'idle' after a run that ended without a result", async () => {
    const ext = startExtension({ claude: () => ({ status: 500 }) });
    await ext.translate();
    assert.ok(ext.msgs("idle").length >= 1);
  });

  test("a hung request times out and frees the worker", async () => {
    const ext = startExtension({ claude: () => ({ hang: true }) });
    await ext.translate();
    assert.match(ext.msgs("error")[0].text, /等候 Claude 回應超過 180 秒/);
    assert.equal(ext.ctx.run("current"), null);
  });

  test("a long request keeps the service worker alive", async () => {
    const gate = deferred();
    const ext = startExtension({ claude: async (req) => (req.n === 0 ? (await gate.promise, undefined) : undefined) });
    const run = ext.translate();
    await new Promise((r) => setTimeout(r, 30 * 20)); // past one scaled 20 s keep-alive tick
    gate.resolve();
    await run;
    assert.ok(ext.chrome._.platformInfoCalls >= 1);
  });
});

test.describe("cache", () => {
  test("turning back to a translated page redraws it without calling Claude", async () => {
    const ext = startExtension();
    await ext.translate();
    await ext.turnTo("p2");
    await ext.idle();
    const calls = ext.claude.calls.length;
    await ext.turnTo("p1");
    await ext.idle();
    assert.equal(ext.claude.calls.length, calls);
    const last = ext.msgs("result").at(-1);
    assert.equal(last.cached, true);
    assert.match(last.text, /譯：p1 paragraph 1/);
    assert.equal(ext.tab.overlay?.page, "p1");
    assert.ok(ext.hasLog(/命中快取（4 個區塊），不呼叫 API/));
  });

  test("the cache survives a service worker restart", async () => {
    const first = startExtension();
    await first.translate();
    const session = Object.fromEntries(first.chrome.storage.session.data);
    delete session.lastSig; // or it's "the same screen re-captured", which only restores the overlay
    const ext = startExtension({ session });
    await ext.translate({ force: false, reason: "key" });
    assert.equal(ext.claude.calls.length, 0);
    assert.equal(ext.msgs("result")[0].cached, true);
  });

  test("pressing the button on the page already shown retranslates it", async () => {
    const ext = startExtension();
    await ext.translate();
    const calls = ext.claude.calls.length;
    await ext.pressTranslate();
    await waitFor(() => ext.ctx.run("current"));
    await ext.idle();
    assert.equal(ext.claude.calls.length, calls * 2);
    assert.ok(ext.hasLog(/畫面沒變（差異 0%）：重新翻譯本頁，不使用快取/));
  });

  test("pressing the button on a cached page that isn't shown uses the cache", async () => {
    const ext = startExtension();
    await ext.translate();
    await ext.turnTo("p2");
    await ext.idle();
    ext.tab.page = "p1"; // turned back without a signal reaching us
    const calls = ext.claude.calls.length;
    await ext.translate();
    assert.equal(ext.claude.calls.length, calls);
    assert.equal(ext.msgs("result").at(-1).cached, true);
  });
});

test.describe("page turns", () => {
  test("a page turn translates the new page", async () => {
    const ext = startExtension();
    await ext.turnTo("p2");
    await ext.idle();
    assert.ok(ext.hasLog(/偵測到翻頁（key，書頁上的譯文已先清掉）/));
    assert.equal(ext.tab.overlay?.page, "p2");
  });

  test("nothing happens while the side panel is closed", async () => {
    const ext = startExtension({ panel: false });
    await ext.turnTo("p2");
    await ext.idle();
    assert.equal(ext.chrome._.captures, 0);
    assert.equal(ext.claude.calls.length, 0);
  });

  test("an open panel counts even before it reconnects to a restarted worker", async () => {
    const ext = startExtension({ panel: false });
    ext.chrome._.contexts.SIDE_PANEL = 1;
    await ext.turnTo("p2");
    await ext.idle();
    assert.equal(ext.tab.overlay?.page, "p2");
  });

  test("a turn in a background tab is ignored", async () => {
    const ext = startExtension();
    await ext.ctx.onPageTurned({ type: "pageTurned", reason: "key" }, { tab: { id: 9, windowId: 1, active: false } });
    await ext.idle();
    assert.equal(ext.chrome._.captures, 0);
  });

  test("the page-turn message reaches onPageTurned", async () => {
    const ext = startExtension();
    ext.tab.page = "p2";
    ext.chrome.runtime.onMessage.dispatch({ type: "pageTurned", reason: "key" }, { tab: { ...ext.chrome._.activeTab } });
    await waitFor(() => ext.ctx.run("current"), { what: "job started" });
    await ext.idle();
    assert.equal(ext.tab.overlay?.page, "p2");
  });

  test("no listener answers a message it doesn't handle", async () => {
    // Chrome takes a returned promise as the reply: an async listener would
    // answer every message (devCapture's too) with undefined first.
    const ext = startExtension();
    for (const type of ["pageTurned", "devCapture", "layoutProgress", "somethingElse"]) {
      const answers = ext.chrome.runtime.onMessage.dispatch({ type, progress: 0 }, { tab: { ...ext.chrome._.activeTab } }, () => {});
      const replying = answers.filter((a) => a === true || typeof a?.then === "function");
      assert.ok(replying.length <= 1, `${type}: ${replying.length} listeners reply`);
      if (type !== "devCapture") assert.equal(replying.length, 0, `${type} gets no reply`);
    }
    await ext.idle();
  });

  test("other runtime messages are ignored", async () => {
    const ext = startExtension();
    await Promise.all(ext.chrome.runtime.onMessage.dispatch({ type: "somethingElse" }, { tab: ext.chrome._.activeTab }));
    await ext.idle();
    assert.equal(ext.chrome._.captures, 0);
  });

  test("with auto-translate off, a turn only refreshes the button", async () => {
    const ext = startExtension({ settings: { autoTranslate: false } });
    await ext.translate();
    assert.ok(ext.session().shownSig);
    await ext.turnTo("p2");
    await waitFor(() => !ext.session().shownSig, { what: "shownSig cleared" });
    await ext.tick();
    assert.equal(ext.claude.of("translate").length, 2, "p2 not translated");
    assert.equal(ext.msgs("pageState").at(-1).retranslate, false);
  });

  test("with auto-translate off, a turn that lands on the same page keeps the button", async () => {
    const ext = startExtension({ settings: { autoTranslate: false } });
    await ext.translate();
    await ext.turnTo(undefined, "dom");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(ext.session().shownSig);
  });

  test("reader churn with the translation still on screen is skipped", async () => {
    const ext = startExtension();
    await ext.translate();
    const captures = ext.chrome._.captures;
    await ext.turnTo(undefined, "dom");
    await ext.idle();
    assert.ok(ext.hasLog(/畫面沒變（譯文還在，差異 0%），略過/));
    assert.equal(ext.chrome._.captures, captures + 1, "one capture to compare, no clearing");
    assert.ok(!ext.chrome._.tabMessages.slice(-3).some((m) => m.msg.type === "clearOverlay"));
  });

  test("a re-check while the page can't report the book's position still matches", async () => {
    // The fingerprint reuses the area last measured for this window size.
    const ext = startExtension();
    await ext.translate();
    ext.tab.geometry = null;
    await ext.turnTo(undefined, "dom");
    await ext.idle();
    assert.ok(ext.hasLog(/畫面沒變（譯文還在，差異 0%），略過/));
  });

  test("the title bar sliding in doesn't look like a page turn in a short window", async () => {
    // A 62 px title bar in a 600 px window reaches past the old fixed 8%.
    const ext = startExtension({ screen: { toolbar: 0.1 } });
    ext.tab.geometry = { viewport: { width: 960, height: 600 }, dpr: 1, page: { left: 96, top: 62, right: 864, bottom: 540 } };
    await ext.translate();
    const calls = ext.claude.calls.length;
    ext.tab.screen.toolbar = false; // the toolbar hides
    await ext.turnTo(undefined, "dom");
    await ext.idle();
    assert.ok(ext.hasLog(/畫面沒變（譯文還在，差異 0%），略過/));
    assert.equal(ext.claude.calls.length, calls);
  });

  test("reader churn that did change the page (slider, table of contents) translates it", async () => {
    const ext = startExtension();
    await ext.translate();
    ext.tab.overlay = null; // the reader re-rendered: our overlay is gone
    ext.tab.page = "p7";
    await ext.turnTo(undefined, "dom");
    await ext.idle();
    assert.ok(ext.hasLog(/重新檢查：頁面上沒有顯示譯文/));
    assert.equal(ext.tab.overlay?.page, "p7");
  });

  test("reader churn on an unchanged page re-captured without overlay is skipped as unchanged", async () => {
    const ext = startExtension({ settings: { overlay: false } });
    await ext.translate();
    const calls = ext.claude.calls.length;
    await ext.turnTo(undefined, "dom");
    await ext.idle();
    assert.equal(ext.claude.calls.length, calls);
  });

  test("turning away mid-translation finishes the old page in the background", async () => {
    const gate = deferred();
    const ext = startExtension({ claude: async (req) => (pageOf(req) === "p1" ? (await gate.promise, undefined) : undefined) });
    const first = ext.ctx.translateActivePage({ force: true });
    await waitFor(() => ext.claude.calls.some((c) => pageOf(c) === "p1"), { what: "p1 request" });
    await ext.turnTo("p2");
    await waitFor(() => ext.tab.overlay?.page === "p2", { what: "p2 drawn" });
    assert.ok(ext.hasLog(/畫面已換頁（差異 \d+%）：先前那一頁改在背景翻完並存快取，先翻目前畫面/));
    gate.resolve();
    await first;
    await ext.idle();
    assert.ok(ext.hasLog(/背景翻完先前那一頁，已存快取（4 個區塊/));
    assert.equal(ext.tab.overlay?.page, "p2", "the old page's translation isn't drawn");
    assert.ok(ext.overlaysSent().every((o) => o.blocks[0].text.includes("p2")));
    assert.equal(ext.cachedPages(), 2);
    const calls = ext.claude.calls.length;
    await ext.turnTo("p1");
    await ext.idle();
    assert.equal(ext.claude.calls.length, calls, "p1 comes from the cache");
    assert.equal(ext.tab.overlay?.page, "p1");
  });

  test("turning back to a page still translating in the background waits for it", async () => {
    const gate = deferred();
    const ext = startExtension({ claude: async (req) => (pageOf(req) === "p1" ? (await gate.promise, undefined) : undefined) });
    ext.ctx.translateActivePage({ force: true });
    await waitFor(() => ext.claude.calls.some((c) => pageOf(c) === "p1"), { what: "p1 request" });
    await ext.turnTo("p2");
    await waitFor(() => ext.tab.overlay?.page === "p2", { what: "p2 drawn" });
    await ext.turnTo("p1");
    await waitFor(() => ext.hasLog(/這一頁還在背景翻譯，等它完成/), { what: "waiting log" });
    const p1Calls = ext.claude.calls.filter((c) => pageOf(c) === "p1").length;
    gate.resolve();
    await ext.idle();
    assert.equal(ext.claude.calls.filter((c) => pageOf(c) === "p1").length, p1Calls + 2, "only the reviews; no second translation");
    assert.equal(ext.tab.overlay?.page, "p1");
    assert.equal(ext.msgs("result").at(-1).cached, true);
  });

  test("only one page keeps translating in the background", async () => {
    const gates = { p1: deferred(), p2: deferred() };
    const ext = startExtension({ claude: async (req) => (gates[pageOf(req)] ? (await gates[pageOf(req)].promise, undefined) : undefined) });
    ext.ctx.translateActivePage({ force: true });
    await waitFor(() => ext.claude.calls.some((c) => pageOf(c) === "p1"), { what: "p1 request" });
    await ext.turnTo("p2");
    await waitFor(() => ext.claude.calls.some((c) => pageOf(c) === "p2"), { what: "p2 request" });
    await ext.turnTo("p3");
    await waitFor(() => ext.hasLog(/背景翻譯已達上限，取消最早的一個/), { what: "oldest cancelled" });
    gates.p1.resolve();
    gates.p2.resolve();
    await ext.idle();
    assert.ok(ext.hasLog(/已取消一個背景翻譯/));
    assert.equal(ext.tab.overlay?.page, "p3");
    const index = plain(ext.chrome.storage.session.data.get("pageIndex"));
    assert.equal(index.length, 2, "p2 and p3 cached, p1 cancelled");
  });

  test("a page change caught only at drawing time isn't drawn, and the new page is translated next", async () => {
    let flipped = false;
    const ext = startExtension({
      claude: (req) => {
        // The user turned the page with a control we don't hear about.
        if (req.kind === "review" && !flipped) {
          flipped = true;
          ext.tab.page = "p5";
        }
      },
    });
    await ext.translate();
    assert.ok(ext.hasLog(/翻譯期間畫面已換頁（差異 \d+%），這份譯文不畫上去（已存快取）/));
    assert.equal(ext.tab.overlay?.page, "p5");
    assert.equal(ext.overlaysSent().length, 1);
    assert.equal(ext.cachedPages(), 2);
  });

  test("the page refuses an overlay from before a turn", async () => {
    const ext = startExtension({ claude: (req) => req.kind === "review" && void ext.tab.turn++ });
    await ext.translate();
    assert.match(ext.msgs("warn")[0].text, /覆蓋層沒有顯示：請求期間翻頁了/);
    assert.equal(ext.session().overlaySig, undefined);
  });
});

test.describe("queueing and cancelling", () => {
  test("the button while translating cancels the request and starts over", async () => {
    let n = 0;
    const ext = startExtension({ claude: () => (n++ === 0 ? { hang: true } : undefined) });
    ext.ctx.translateActivePage({ force: true });
    await waitFor(() => ext.claude.calls.length >= 1, { what: "first request" });
    await ext.pressTranslate();
    await ext.idle();
    assert.ok(ext.hasLog(/手動翻譯：取消進行中的請求，改翻目前畫面/));
    assert.ok(ext.hasLog(/已取消前一個請求/));
    assert.ok(ext.hasLog(/處理排隊中的請求/));
    assert.equal(ext.msgs("error").length, 0, "a cancel isn't an error");
    assert.equal(ext.tab.overlay?.page, "p1");
    assert.equal(ext.msgs("result").length, 1);
  });

  test("a turn signal while translating the same page is queued, then skipped", async () => {
    const gate = deferred();
    const ext = startExtension({ claude: async (req) => (req.n === 0 ? (await gate.promise, undefined) : undefined) });
    ext.ctx.translateActivePage({ force: true });
    await waitFor(() => ext.claude.calls.length >= 1, { what: "request" });
    await ext.turnTo(undefined, "dom");
    await waitFor(() => ext.hasLog(/檢查：還是同一頁/), { what: "same-page check" });
    gate.resolve();
    await ext.idle();
    assert.ok(ext.hasLog(/前一個請求還沒結束，排隊；同時檢查畫面是否已換頁/));
    assert.equal(ext.claude.of("translate").length, 2, "translated once");
    assert.equal(ext.tab.overlay?.page, "p1");
  });

  test("bursts of signals collapse into one check plus one follow-up", async () => {
    const gate = deferred();
    const ext = startExtension({ claude: async (req) => (req.n === 0 ? (await gate.promise, undefined) : undefined) });
    ext.ctx.translateActivePage({ force: true });
    await waitFor(() => ext.claude.calls.length >= 1, { what: "request" });
    const before = ext.chrome._.captures;
    await Promise.all([1, 2, 3, 4, 5].map(() => ext.turnTo(undefined, "dom")));
    await waitFor(() => !ext.ctx.run("checking"), { what: "checks done" });
    assert.ok(ext.chrome._.captures - before <= 2, `${ext.chrome._.captures - before} captures`);
    gate.resolve();
    await ext.idle();
  });

  test("a queued request keeps force from any trigger and dom only if all were dom", async () => {
    const ext = startExtension();
    ext.ctx.run("current = { controller: new AbortController(), page: null }");
    ext.ctx.translateActivePage({ force: false, reason: "dom" });
    assert.deepEqual(plain(ext.ctx.run("pending")), { force: false, reason: "dom" });
    ext.ctx.translateActivePage({ force: false, reason: "key" });
    assert.deepEqual(plain(ext.ctx.run("pending")), { force: false, reason: "key" });
    ext.ctx.translateActivePage({ force: false, reason: "dom" });
    assert.deepEqual(plain(ext.ctx.run("pending")), { force: false, reason: "key" }, "dom doesn't overwrite a user action");
    ext.ctx.translateActivePage({ force: true });
    assert.equal(ext.ctx.run("pending.force"), true);
    ext.ctx.translateActivePage({ force: false, reason: "dom" });
    assert.equal(ext.ctx.run("pending.force"), true, "force sticks");
    ext.ctx.run("current = null; pending = null");
  });
});

test.describe("overlay switch and commands", () => {
  test("with the overlay off, the translation goes to the panel only", async () => {
    const ext = startExtension({ settings: { overlay: false } });
    await ext.translate();
    assert.equal(ext.overlaysSent().length, 0);
    assert.ok(!ext.chrome._.tabMessages.some((m) => m.msg.type === "clearOverlay"));
    assert.equal(ext.msgs("result").length, 1);
    assert.ok(ext.session().shownSig);
  });

  test("switching the overlay off mid-request skips drawing", async () => {
    const ext = startExtension({ claude: (req) => req.kind === "review" && void ext.chrome.storage.sync.data.set("overlay", false) });
    await ext.translate();
    assert.ok(ext.hasLog(/覆蓋層開關已關閉，不畫/));
    assert.equal(ext.overlaysSent().length, 0);
  });

  test("switching the overlay back on redraws the cached page", async () => {
    const ext = startExtension();
    await ext.translate();
    ext.tab.enabled = false;
    await ext.chrome.storage.sync.set({ overlay: false });
    ext.tab.enabled = true;
    ext.tab.overlay = null;
    const calls = ext.claude.calls.length;
    await ext.chrome.storage.sync.set({ overlay: true });
    await waitFor(() => ext.ctx.run("current"));
    await ext.idle();
    assert.equal(ext.claude.calls.length, calls);
    assert.equal(ext.tab.overlay?.page, "p1");
  });

  test("Alt+O flips the overlay setting", async () => {
    const ext = startExtension();
    await Promise.all(ext.chrome.commands.onCommand.dispatch("toggle-overlay"));
    assert.equal(ext.chrome.storage.sync.data.get("overlay"), false);
    await Promise.all(ext.chrome.commands.onCommand.dispatch("toggle-overlay"));
    assert.equal(ext.chrome.storage.sync.data.get("overlay"), true);
    await ext.idle();
  });

  test("Alt+T translates", async () => {
    const ext = startExtension();
    await Promise.all(ext.chrome.commands.onCommand.dispatch("translate-page"));
    await ext.idle();
    assert.ok(ext.hasLog(/手動翻譯：Alt\+T/));
    assert.equal(ext.tab.overlay?.page, "p1");
  });

  test("unknown commands do nothing", async () => {
    const ext = startExtension();
    await Promise.all(ext.chrome.commands.onCommand.dispatch("nope"));
    await ext.idle();
    assert.equal(ext.chrome._.captures, 0);
  });
});

test.describe("talking to the page and the panel", () => {
  test("a tab without a live content script gets one injected and the message retried", async () => {
    const ext = startExtension();
    const handler = ext.chrome._.tabMessageHandler;
    let missing = true;
    ext.chrome._.tabMessageHandler = (...a) => {
      if (missing) {
        missing = false;
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      return handler(...a);
    };
    await ext.translate();
    assert.ok(ext.hasLog(/頁面沒有 content script，重新注入/));
    assert.deepEqual(plain(ext.chrome._.executed[0]), { target: { tabId: 1, frameIds: [0] }, files: ["content.js"] });
    assert.equal(ext.tab.overlay?.page, "p1");
  });

  test("a page that can't take the overlay gets a warning to reload it", async () => {
    const ext = startExtension();
    ext.tab.onOverlay = () => {
      throw new Error("Frame removed");
    };
    await ext.translate();
    assert.match(ext.msgs("warn")[0].text, /譯文沒辦法疊到頁面上（Frame removed）。請重新整理 Kindle 分頁再試。/);
  });

  test("installing the extension sets up the panel and reinjects open readers", async () => {
    const ext = startExtension();
    let behavior;
    ext.chrome.sidePanel.setPanelBehavior = async (b) => (behavior = b);
    ext.chrome.runtime.onInstalled.dispatch({ reason: "update" });
    await waitFor(() => ext.chrome._.executed.length);
    assert.deepEqual(plain(behavior), { openPanelOnActionClick: true });
    assert.deepEqual(plain(ext.chrome._.executed[0]), { target: { tabId: 1, allFrames: true }, files: ["content.js"] });
  });

  test("the log is mirrored to the reader tab's console", async () => {
    const ext = startExtension();
    await ext.translate();
    const logs = ext.chrome._.tabMessages.filter((m) => m.msg.type === "debugLog");
    assert.ok(logs.length > 5);
    assert.match(logs[0].msg.text, /^\d\d:\d\d:\d\d\.\d{3} /);
    assert.deepEqual(plain(logs[0].options), { frameId: 0 });
  });

  test("messages sent while the panel is away are delivered when it connects", async () => {
    const ext = startExtension({ panel: false });
    await ext.translate();
    ext.openPanel();
    await ext.tick();
    assert.equal(ext.msgs("result").length, 1);
    assert.ok(ext.hasLog(/覆蓋層已畫上 4 個區塊/));
  });

  test("at most 100 undelivered messages are kept", async () => {
    const ext = startExtension({ panel: false });
    for (let i = 0; i < 150; i++) ext.ctx.log(`line ${i}`);
    ext.openPanel();
    await ext.tick();
    const lines = ext.logs().filter((l) => l.startsWith("line "));
    assert.equal(lines.length, 100);
    assert.equal(lines[0], "line 50");
  });

  test("a newly opened panel gets the layout model's state and the button label", async () => {
    const ext = startExtension({ panel: false });
    ext.chrome.runtime.onMessage.dispatch({ type: "layoutProgress", progress: 0.42 }, {});
    ext.openPanel();
    await waitFor(() => ext.msgs("pageState").length);
    assert.ok(ext.msgs("layoutState").some((m) => m.level === "wait" && /下載中（42%/.test(m.text)));
    assert.equal(ext.msgs("pageState")[0].retranslate, false);
  });

  test("the download start is logged once, progress only on the status line", async () => {
    const ext = startExtension();
    for (const progress of [0, 0.5, 1]) ext.chrome.runtime.onMessage.dispatch({ type: "layoutProgress", progress }, {});
    await ext.tick();
    assert.equal(ext.logs().filter((l) => /DocLayout-YOLO 下載中/.test(l)).length, 1);
    assert.equal(ext.msgs("layoutState").length, 3);
  });

  test("a closed panel port stops getting messages", async () => {
    const ext = startExtension();
    const port = ext.port;
    ext.closePanel();
    const n = port.sent.length + ext.received.length;
    ext.ctx.log("after close");
    await ext.tick();
    assert.equal(port.sent.length + ext.received.length, n);
    assert.equal(ext.ctx.run("panelPorts.size"), 0);
  });
});

test.describe("saving a screenshot for tests", () => {
  async function shoot(ext) {
    ext.port.postMessage({ type: "captureNow" });
    await waitFor(() => ext.msgs("screenshot").length || ext.msgs("error").length, { what: "screenshot" });
  }

  test("captures the bare page the way translation does and names it by book", async () => {
    const ext = startExtension();
    await shoot(ext);
    const [shot] = ext.msgs("screenshot");
    assert.match(shot.filename, /^kindle-B0TESTBOOK-\d{8}-\d{6}\.jpg$/);
    assert.equal(shot.info.asin, "B0TESTBOOK");
    assert.deepEqual(shot.info.page, ext.tab.geometry.page, "where the book was drawn, for the OCR crop");
    assert.deepEqual(shot.info.viewport, ext.tab.geometry.viewport);
    assert.match(shot.info.capturedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(plain(parseScreenUrl(shot.dataUrl)).overlay, null);
    assert.ok(ext.received.some((m) => m.type === "log" && /^已截圖：kindle-B0TESTBOOK-/.test(m.text) && m.image === shot.dataUrl));
  });

  test("hides the translation for the shot and draws it back from the cache", async () => {
    const ext = startExtension();
    await ext.translate();
    const calls = ext.claude.calls.length;
    await shoot(ext);
    assert.equal(parseScreenUrl(ext.msgs("screenshot")[0].dataUrl).overlay, null, "no overlay in the shot");
    await waitFor(() => ext.ctx.run("current"));
    await ext.idle();
    assert.equal(ext.tab.overlay?.page, "p1", "overlay back");
    assert.equal(ext.claude.calls.length, calls, "no new API calls");
  });

  test("waits for a running translation instead of disturbing it", async () => {
    const gate = deferred();
    const ext = startExtension({ claude: async () => (await gate.promise, undefined) });
    ext.ctx.translateActivePage({ force: true });
    await waitFor(() => ext.claude.calls.length);
    ext.port.postMessage({ type: "captureNow" });
    await waitFor(() => ext.hasLog(/翻譯進行中，等完成再截圖/), { what: "refusal log" });
    assert.equal(ext.msgs("screenshot").length, 0);
    gate.resolve();
    await ext.idle();
  });

  test("only on a Kindle tab", async () => {
    const ext = startExtension();
    ext.chrome._.activeTab = { id: 2, windowId: 1, url: "https://example.com/", active: true };
    await shoot(ext);
    assert.equal(ext.msgs("error")[0].text, "目前分頁不是 Kindle Cloud Reader。");
  });

  test("a failed capture is reported", async () => {
    const ext = startExtension();
    ext.chrome._.screen = null;
    await shoot(ext);
    assert.match(ext.msgs("error")[0].text, /^截圖失敗：/);
  });
});

test.describe("test screenshots asked for by a test tool", () => {
  const ask = (ext, name, tab = ext.chrome._.activeTab) => ext.ctx.devCapture({ ...tab }, name);

  test("refused while the developer switch is off", async () => {
    const ext = startExtension();
    assert.deepEqual(plain(await ask(ext, "x")), { ok: false, error: "開發者開關沒有開啟（設定頁）" });
    assert.equal(ext.chrome._.captures, 0);
  });

  test("sent to the local receiver, named as asked, with where the book was drawn", async () => {
    const ext = startExtension();
    await ext.chrome.storage.local.set({ devCapture: true });
    const out = plain(await ask(ext, "alice-ch1-p1"));
    assert.equal(out.ok, true);
    assert.equal(out.filename, "alice-ch1-p1.jpg");
    const [shot] = ext.shots;
    assert.equal(shot.url, "http://127.0.0.1:8765/fixture");
    assert.equal(shot.body.filename, "alice-ch1-p1.jpg");
    assert.match(shot.body.dataUrl, /^data:image\//);
    assert.deepEqual(shot.body.info.page, ext.tab.geometry.page);
    assert.equal(shot.body.info.asin, "B0TESTBOOK");
    assert.equal(parseScreenUrl(shot.body.dataUrl).overlay, null, "no overlay in the shot");
  });

  test("an unusable name falls back to the timestamped one", async () => {
    const ext = startExtension();
    await ext.chrome.storage.local.set({ devCapture: true });
    for (const name of ["../etc/passwd", "Has Spaces", "", 42, undefined]) {
      const out = plain(await ask(ext, name));
      assert.match(out.filename, /^kindle-B0TESTBOOK-\d{8}-\d{6}\.jpg$/, String(name));
    }
  });

  test("only the tab on screen, and only a Kindle tab", async () => {
    const ext = startExtension();
    await ext.chrome.storage.local.set({ devCapture: true });
    assert.equal(plain(await ask(ext, "x", { ...ext.chrome._.activeTab, active: false })).error, "只能截目前顯示的 Kindle 分頁");
    assert.equal(plain(await ask(ext, "x", { id: 2, windowId: 1, active: true, url: "https://example.com/" })).error, "只能截目前顯示的 Kindle 分頁");
    assert.equal(plain(await ext.ctx.devCapture(undefined, "x")).error, "只能截目前顯示的 Kindle 分頁");
    assert.equal(ext.shots.length, 0);
  });

  test("not while translating", async () => {
    const gate = deferred();
    const ext = startExtension({ claude: async () => (await gate.promise, undefined) });
    await ext.chrome.storage.local.set({ devCapture: true });
    ext.ctx.translateActivePage({ force: true });
    await waitFor(() => ext.claude.calls.length);
    assert.equal(plain(await ask(ext, "x")).error, "翻譯進行中，等完成再截圖");
    gate.resolve();
    await ext.idle();
  });

  test("a receiver that isn't running or refuses is reported", async () => {
    const ext = startExtension();
    await ext.chrome.storage.local.set({ devCapture: true });
    ext.receiverStatus = 400;
    assert.equal(plain(await ask(ext, "x")).error, "接收程式回應 HTTP 400");
  });

  test("the onMessage listener answers devCapture asynchronously", async () => {
    const ext = startExtension();
    const replies = [];
    const answers = ext.chrome.runtime.onMessage.dispatch({ type: "devCapture", name: "x" }, { tab: { ...ext.chrome._.activeTab } }, (r) => replies.push(plain(r)));
    assert.ok(answers.includes(true), "keeps the channel open");
    await waitFor(() => replies.length);
    assert.equal(replies[0].ok, false); // the switch is off
  });
});
