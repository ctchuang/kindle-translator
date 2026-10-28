// End-to-end runs of the background worker against a fake Kindle tab that
// answers from a synthetic book's page data: screens shown, OCR, Claude,
// the overlay, the paragraph cache, jobs moved to the background, prefetching
// the next screen, the vision engine, and failures along the way.

const test = require("node:test");
const assert = require("node:assert/strict");
const { plain, waitFor } = require("./helpers/load");
const { startExtension, testBook } = require("./helpers/extension");
const R = require("../page-render.js");

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// The texts a translate request carried.
const sentTexts = (req) => req.items.map((p) => p.text);
const allSent = (ext) => ext.claude.of("translate").flatMap(sentTexts);

// A screen is shown and left to settle and translate.
async function showAndWait(ext, index, layout) {
  await ext.show(index, layout);
  await ext.idle();
}

test.describe("a screen shown is translated (OCR engine, polished mode)", () => {
  test("OCR, Haiku, Sonnet, then the overlay, the panel and the cache", async () => {
    const ext = startExtension();
    await showAndWait(ext, 0);
    const texts = ext.texts(0);

    // OCR: the screen drawn at ×2, one rectangle per column.
    assert.equal(ext.ocr.calls.length, 1);
    assert.deepEqual(plain(ext.ocr.calls[0].rects), [
      { left: 0, top: 0, width: 300, height: 400 },
      { left: 300, top: 0, width: 300, height: 400 },
    ]);
    assert.equal(ext.chrome._.offscreenCreated, 1);

    // Haiku per column, Sonnet per chunk.
    const tr = ext.claude.of("translate");
    const rv = ext.claude.of("review");
    assert.equal(tr.length, 2, "the two columns translated side by side");
    assert.equal(rv.length, 2);
    for (const r of tr) {
      assert.equal(r.body.model, "claude-haiku-5-5");
      assert.deepEqual(r.body.thinking, { type: "disabled" });
    }
    for (const r of rv) assert.equal(r.body.model, "claude-sonnet-5-5");
    assert.deepEqual(allSent(ext), texts);
    assert.equal(rv[0].items[0].source, texts[0]);
    assert.equal(rv[0].items[0].draft, `譯：${texts[0]}`);

    // The overlay: paragraphs in page pixels, for this very screen.
    const [overlay] = ext.overlaysSent();
    const info = ext.info(0);
    assert.deepEqual(overlay.page, { key: info.key, start: info.start });
    assert.deepEqual(overlay.size, { width: 300, height: 200 });
    assert.equal(overlay.bg, "#ffffff");
    const paras = R.pageParagraphs(ext.screen());
    assert.equal(overlay.blocks.length, paras.length);
    overlay.blocks.forEach((b, i) => {
      assert.equal(b.text, `譯：${texts[i]}`);
      assert.equal(b.kind, paras[i].kind);
      assert.deepEqual(b.boxes, plain(paras[i].boxes));
      assert.equal(b.fg, "#000000");
    });
    assert.equal(overlay.blocks[0].kind, "heading");
    assert.equal(ext.tab.overlay.page.start, info.start, "the page drew it");

    // The panel and the button.
    const [result] = ext.msgs("result");
    assert.equal(result.text, texts.map((t) => `譯：${t}`).join("\n\n"));
    assert.equal(result.cached, false);
    assert.equal(result.fallbackModel, null);
    assert.equal(ext.msgs("pageState").at(-1).retranslate, true);
    assert.ok(ext.msgs("working").length >= 1);

    // The cache: every paragraph by its position range, and the screen.
    assert.equal(ext.cachedParas().length, texts.length);
    for (const p of paras) {
      const entry = ext.session()[`para:B0TESTBOOK:rev1:${p.start}-${p.end}`];
      assert.ok(entry, `${p.start}-${p.end}`);
      assert.match(entry.text, /^譯：/);
      assert.ok(entry.source);
    }
    assert.deepEqual(ext.cachedScreens(), [`page:${info.key}:${info.start}`]);
    assert.equal(ext.session().drawn, `${info.key}|${info.start}`);
    assert.ok(ext.hasLog(/畫面換到位置 \d+–\d+（比對 2 個畫面，5 毫秒）/));
    assert.ok(ext.hasLog(/^OCR 完成：/));
    assert.ok(ext.hasLog(/^翻譯完成：位置 \d+–\d+，\d+ 段送出、0 段沿用快取或其他請求/));
    assert.ok(ext.hasLog(/覆蓋層已畫上 \d+ 段/));
  });

  test("the reviewer's corrections replace the draft", async () => {
    const ext = startExtension({
      claude: (req) => req.kind === "review" && { json: { corrections: req.items.map((p) => ({ id: p.id, text: `校對：${p.source}` })), notes: "改了" } },
    });
    await showAndWait(ext, 0);
    const texts = ext.texts(0);
    assert.deepEqual(
      ext.overlaysSent()[0].blocks.map((b) => b.text),
      texts.map((t) => `校對：${t}`)
    );
    assert.ok(ext.hasLog(/校對完成：.*改了 \d+\/\d+ 段：改了/));
    assert.equal(ext.session()[ext.cachedParas()[0]].text.slice(0, 3), "校對：");
  });

  test("corrections for other ids, blank or unchanged ones are ignored", async () => {
    const ext = startExtension({
      claude: (req) =>
        req.kind === "review" && {
          json: {
            corrections: [{ id: 99, text: "不在這段" }, { id: req.items[0].id, text: "  " }, { id: req.items[1].id, text: req.items[1].draft }],
            notes: "",
          },
        },
    });
    await showAndWait(ext, 0);
    assert.ok(ext.overlaysSent()[0].blocks.every((b) => b.text.startsWith("譯：")));
    assert.ok(ext.hasLog(/改了 0\/\d+ 段/));
  });

  test("a failed review keeps the draft", async () => {
    const ext = startExtension({ claude: (req) => req.kind === "review" && { status: 500 } });
    await showAndWait(ext, 0);
    assert.ok(ext.overlaysSent()[0].blocks.every((b) => b.text.startsWith("譯：")));
    assert.ok(ext.hasLog(/校對失敗（Claude API 錯誤 500：boom），沿用初稿/));
    assert.equal(ext.msgs("error").length, 0);
  });

  test("paragraphs the draft left blank aren't sent for review", async () => {
    const ext = startExtension({
      claude: (req) => req.kind === "translate" && { json: { translations: req.items.map((p, i) => ({ id: p.id, text: i === 0 ? "" : `譯：${p.text}` })), notes: "", summarized: false } },
    });
    await showAndWait(ext, 0);
    const reviewed = ext.claude.of("review").flatMap((r) => r.items);
    assert.ok(reviewed.length > 0);
    assert.ok(reviewed.every((p) => p.draft), "no blank draft sent for review");
    assert.equal(reviewed.length, ext.texts(0).length - 2, "each chunk's first paragraph was left blank");
  });

  test("a chunk Haiku declines goes to Opus, which isn't reviewed", async () => {
    const ext = startExtension({
      claude: (req) =>
        req.kind === "translate" && req.body.model === "claude-haiku-5-5" && req.n === 0 && { json: { translations: [], notes: "版權", summarized: false } },
    });
    await showAndWait(ext, 0);
    const opus = ext.claude.calls.filter((c) => c.body.model === "claude-opus-5-5");
    assert.equal(opus.length, 1);
    assert.equal(opus[0].headers["anthropic-beta"], "server-side-fallback-2026-06-01");
    assert.equal(ext.claude.of("review").length, 1, "only the other chunk is reviewed");
    assert.ok(ext.hasLog(/claude-haiku-5-5 沒有完整翻譯（版權），這部分改用 claude-opus-5-5/));
    assert.equal(ext.msgs("result")[0].fallbackModel, "claude-opus-5-5");
  });

  test("Haiku mode skips the review", async () => {
    const ext = startExtension({ settings: { quality: "haiku" } });
    await showAndWait(ext, 0);
    assert.equal(ext.claude.of("review").length, 0);
    assert.equal(ext.claude.of("translate").length, 2);
  });

  test("an unknown quality level falls back to the polished mode", async () => {
    const ext = startExtension({ settings: { quality: "nonsense" } });
    await showAndWait(ext, 0);
    assert.equal(ext.claude.of("review").length, 2);
  });

  test("a screen with few paragraphs goes in one request", async () => {
    const ext = startExtension({ book: testBook({ paragraphs: ["one short paragraph.", "and another one."] }) });
    await showAndWait(ext, 0);
    assert.equal(ext.claude.of("translate").length, 1);
    assert.deepEqual(allSent(ext), ext.texts(0));
  });

  test("one column is split in half by length and read as one rectangle", async () => {
    const ext = startExtension({ layout: { columns: 1, width: 300, height: 400 } });
    await showAndWait(ext, 0);
    assert.equal(ext.ocr.calls[0].rects.length, 1);
    assert.equal(ext.claude.of("translate").length, 2);
    assert.deepEqual(allSent(ext), ext.texts(0));
  });

  test("a paragraph OCR read nothing in is left untranslated", async () => {
    const ext = startExtension();
    const texts = ext.texts(0);
    ext.ocr.handler = (msg, drawn) => {
      // Drop the lines of the first paragraph (the heading).
      const layout = ext.tab.layouts.get(drawn.key);
      const page = layout.screens.find((s) => s.startPositionId === drawn.start);
      const heading = R.pageParagraphs(page)[0];
      const lines = page.children
        .filter((c) => c.type === "run" && c.elementId !== heading.id)
        .map((r) => {
          const b = R.boxOf(r);
          return { x0: b.x0 * 2, y0: b.y0 * 2, x1: b.x1 * 2, y1: b.y1 * 2, text: layout.lineText.get(r.startPositionId), confidence: 92 };
        });
      return { columns: msg.rects.map((rect) => lines.filter((l) => l.x0 >= rect.left && l.x0 < rect.left + rect.width)) };
    };
    await showAndWait(ext, 0);
    assert.deepEqual(allSent(ext), texts.slice(1));
    assert.equal(ext.overlaysSent()[0].blocks.length, texts.length - 1);
    assert.ok(ext.hasLog(/OCR 完成：.*，1 段沒有讀到字/));
  });

  test("a screen with no text (an illustration alone) asks Claude nothing", async () => {
    const book = testBook({ paragraphs: [{ image: true, lines: 12 }, "after the picture."] });
    const ext = startExtension({ book, layout: { columns: 1 } });
    assert.ok(ext.layout.screens[0].children.every((c) => c.type === "image"));
    await showAndWait(ext, 0);
    assert.equal(ext.claude.calls.length, 0);
    assert.equal(ext.ocr.calls.length, 0, "no paragraphs: nothing to read");
    assert.ok(ext.hasLog(/這一頁沒有文字（位置 \d+–\d+），不用翻譯/));
    assert.equal(ext.msgs("error").length, 0);
    assert.ok(ext.msgs("idle").length >= 1);
  });

  test("an OCR failure is shown as an error, and nothing is cached", async () => {
    const ext = startExtension();
    ext.ocr.handler = () => ({ error: "Tesseract crashed" });
    await showAndWait(ext, 0);
    assert.equal(ext.msgs("error")[0].text, "OCR 失敗：Tesseract crashed");
    assert.equal(ext.cachedScreens().length, 0);
    assert.equal(ext.claude.calls.length, 0);
  });

  test("an offscreen document that doesn't answer is an error", async () => {
    const ext = startExtension();
    ext.ocr.handler = () => null;
    ext.chrome._.runtimeMessageHandler = () => undefined;
    await showAndWait(ext, 0);
    assert.equal(ext.msgs("error")[0].text, "OCR 失敗：offscreen 文件沒有回應");
  });

  test("the page failing to give the screen's data is an error", async () => {
    const ext = startExtension();
    ext.tab.onPageData = () => ({ error: "頁面資料裡沒有這一頁" });
    await showAndWait(ext, 0);
    assert.equal(ext.msgs("error")[0].text, "拿不到這一頁的頁面資料：頁面資料裡沒有這一頁");
  });

  test("the offscreen document is created once", async () => {
    const ext = startExtension();
    await showAndWait(ext, 0);
    await showAndWait(ext, 1);
    assert.equal(ext.chrome._.offscreenCreated, 1);
    assert.equal(ext.ocr.calls.length, 2);
  });

  test("a summary is retried once, then shown but not cached", async () => {
    const ext = startExtension({ claude: (req) => req.kind === "translate" && { json: { translations: req.items.map((p) => ({ id: p.id, text: "摘要" })), notes: "", summarized: true } } });
    await showAndWait(ext, 0);
    // Declined (a summary) → Opus, twice over: the first try and the retry.
    assert.ok(ext.hasLog(/Claude 這次只給摘要，不是翻譯/));
    assert.ok(ext.hasLog(/重試後仍然只給摘要/));
    assert.equal(ext.cachedParas().length, 0);
    assert.equal(ext.msgs("result")[0].summary, true);
    assert.match(ext.msgs("warn").at(-1).text, /只給了摘要/);
  });

  test("a summary followed by a translation keeps the translation", async () => {
    let tries = 0;
    const ext = startExtension({
      settings: { quality: "haiku" },
      claude: (req) => {
        if (req.kind !== "translate") return undefined;
        tries++;
        return tries <= 2 ? { json: { translations: req.items.map((p) => ({ id: p.id, text: `譯：${p.text}` })), notes: "這是摘要", summarized: false } } : undefined;
      },
    });
    await showAndWait(ext, 0);
    assert.equal(ext.msgs("result")[0].summary, false);
    assert.ok(ext.cachedParas().length > 0);
  });
});

test.describe("settling, the panel and the switches", () => {
  test("screens flipped past quickly are never sent", async () => {
    const ext = startExtension();
    await ext.show(0);
    await ext.show(1);
    await ext.show(2);
    await ext.idle();
    assert.equal(ext.ocr.calls.length, 1);
    assert.equal(ext.ocr.calls[0].drawn.start, ext.info(2).start);
    assert.deepEqual(allSent(ext), ext.texts(2));
  });

  test("a screen is only sent after it has stayed on screen a moment", async () => {
    const ext = startExtension();
    await ext.show(0);
    await ext.tick();
    assert.equal(ext.ocr.calls.length, 0);
    await ext.idle();
    assert.equal(ext.ocr.calls.length, 1);
  });

  test("nothing is translated while the side panel is closed", async () => {
    const ext = startExtension({ panel: false });
    await showAndWait(ext, 0);
    assert.equal(ext.ocr.calls.length, 0);
    assert.equal(ext.claude.calls.length, 0);
    assert.equal(ext.session().shown.start, ext.info(0).start, "the screen is still remembered");
  });

  test("an open panel counts even before it reconnects to a restarted worker", async () => {
    const ext = startExtension({ panel: false });
    ext.chrome._.contexts.SIDE_PANEL = 1;
    await showAndWait(ext, 0);
    assert.equal(ext.claude.of("translate").length, 2);
  });

  test("with auto-translate off, a new screen isn't translated, but a cached one is drawn", async () => {
    const ext = startExtension();
    await showAndWait(ext, 0);
    await ext.chrome.storage.sync.set({ autoTranslate: false });
    await showAndWait(ext, 1);
    assert.equal(ext.ocr.calls.length, 1);
    await showAndWait(ext, 0);
    assert.equal(ext.overlaysSent().length, 2, "screen 0 drawn again from the cache");
  });

  test("a screen shown in a tab that isn't active is ignored", async () => {
    const ext = startExtension();
    await ext.ctx.onPageShown({ type: "pageShown", page: ext.info(0) }, { tab: { id: 9, windowId: 1, active: false } });
    await ext.idle();
    assert.equal(ext.ocr.calls.length, 0);
    assert.equal(ext.session().shown, undefined);
  });

  test("a screen the page couldn't identify is reported", async () => {
    const ext = startExtension();
    await showAndWait(ext, 0);
    await ext.showError("閱讀器的頁面資料裡找不到目前這一頁");
    await ext.idle();
    assert.equal(ext.msgs("warn").at(-1).text, "閱讀器的頁面資料裡找不到目前這一頁");
    assert.ok(ext.hasLog(/無法辨識目前這一頁：閱讀器的頁面資料裡找不到目前這一頁/));
    assert.equal(ext.session().shown, undefined);
    assert.equal(ext.session().drawn, undefined);
    assert.equal(ext.msgs("pageState").at(-1).retranslate, false);
  });

  test("an unidentified screen with the panel closed is silent", async () => {
    const ext = startExtension({ panel: false });
    await ext.showError("x");
    ext.openPanel();
    await ext.tick();
    assert.equal(ext.msgs("warn").length, 0);
  });

  test("the onMessage listener routes pageShown and pageLog, and answers nothing", async () => {
    const ext = startExtension();
    const sender = { tab: { ...ext.chrome._.activeTab } };
    const returned = ext.chrome.runtime.onMessage.dispatch({ type: "pageShown", page: ext.info(0) }, sender, () => {});
    assert.ok(returned.every((r) => r === undefined));
    ext.chrome.runtime.onMessage.dispatch({ type: "pageLog", text: "收到閱讀器的頁面資料：6 個畫面（12 KB）" }, sender, () => {});
    ext.chrome.runtime.onMessage.dispatch({ type: "somethingElse" }, sender, () => {});
    await ext.idle();
    assert.ok(ext.hasLog(/^收到閱讀器的頁面資料：6 個畫面/));
    assert.equal(ext.ocr.calls.length, 1);
  });

  test("page logs from a background tab, or with the panel closed, are dropped", async () => {
    const ext = startExtension();
    ext.chrome.runtime.onMessage.dispatch({ type: "pageLog", text: "from elsewhere" }, { tab: { id: 5, active: false } }, () => {});
    ext.closePanel();
    ext.chrome.runtime.onMessage.dispatch({ type: "pageLog", text: "panel closed" }, { tab: { ...ext.chrome._.activeTab } }, () => {});
    await ext.tick();
    ext.openPanel();
    await ext.tick();
    assert.ok(!ext.hasLog(/from elsewhere|panel closed/));
  });

  test("with the overlay off, the translation goes to the panel only", async () => {
    const ext = startExtension({ settings: { overlay: false } });
    await showAndWait(ext, 0);
    assert.equal(ext.overlaysSent().length, 0);
    assert.equal(ext.msgs("result").length, 1);
    assert.ok(ext.hasLog(/覆蓋層開關已關閉，譯文只顯示在側邊欄/));
    assert.equal(ext.msgs("pageState").at(-1).retranslate, true);
  });

  test("switching the overlay back on draws the screen from the cache, without a new panel entry", async () => {
    const ext = startExtension({ settings: { overlay: false } });
    await showAndWait(ext, 0);
    await ext.chrome.storage.sync.set({ overlay: true });
    await waitFor(() => ext.overlaysSent().length === 1, { what: "redrawn" });
    assert.equal(ext.msgs("result").length, 1);
    assert.equal(ext.claude.of("translate").length, 2, "no new request");
  });

  test("switching the overlay on with nothing cached, or off, does nothing", async () => {
    const ext = startExtension();
    await ext.chrome.storage.sync.set({ overlay: false });
    await ext.chrome.storage.sync.set({ overlay: true });
    await ext.idle();
    assert.equal(ext.overlaysSent().length, 0);
    assert.equal(ext.claude.calls.length, 0);
  });

  test("Alt+O flips the overlay setting", async () => {
    const ext = startExtension();
    ext.chrome.commands.onCommand.dispatch("toggle-overlay");
    await waitFor(async () => (await ext.chrome.storage.sync.get("overlay")).overlay === false, { what: "off" });
    ext.chrome.commands.onCommand.dispatch("toggle-overlay");
    await waitFor(async () => (await ext.chrome.storage.sync.get("overlay")).overlay === true, { what: "on" });
  });

  test("Alt+T translates the screen on show", async () => {
    const ext = startExtension();
    ext.chrome.commands.onCommand.dispatch("translate-page");
    await ext.idle();
    assert.ok(ext.hasLog(/手動翻譯：Alt\+T/));
    assert.equal(ext.overlaysSent().length, 1);
  });

  test("unknown commands do nothing", async () => {
    const ext = startExtension();
    ext.chrome.commands.onCommand.dispatch("something");
    await ext.idle();
    assert.equal(ext.claude.calls.length, 0);
  });
});

test.describe("the paragraph cache", () => {
  test("turning back to a translated screen draws it at once, without Claude", async () => {
    const ext = startExtension();
    await showAndWait(ext, 0);
    await showAndWait(ext, 1);
    const calls = ext.claude.calls.length;
    await ext.show(0);
    // Drawn before any settle wait.
    assert.equal(ext.overlaysSent().length, 3);
    await ext.idle();
    assert.equal(ext.claude.calls.length, calls);
    assert.equal(ext.ocr.calls.length, 2);
    assert.equal(ext.msgs("result").at(-1).cached, true);
    assert.ok(ext.hasLog(/命中快取（\d+ 段），不呼叫 API/));
  });

  test("the cache survives a service worker restart", async () => {
    const first = startExtension();
    await showAndWait(first, 0);
    const ext = startExtension({ session: first.session() });
    await showAndWait(ext, 0);
    assert.equal(ext.claude.calls.length, 0);
    assert.equal(ext.ocr.calls.length, 0);
    assert.equal(ext.overlaysSent().length, 1);
  });

  test("another font size reuses every whole paragraph; only the cut ones are sent", async () => {
    const ext = startExtension();
    for (let i = 0; i < 5; i++) await showAndWait(ext, i);
    const before = new Set(allSent(ext));
    const calls = ext.claude.of("translate").length;
    const bigger = ext.relayout({ fontSize: 12 });
    const target = 2;
    await showAndWait(ext, target, bigger);
    const now = ext.claude.of("translate").slice(calls).flatMap(sentTexts);
    const paras = R.pageParagraphs(bigger.screens[target]);
    const cached = paras.filter((p) => ext.session()[`para:B0TESTBOOK:rev1:${p.start}-${p.end}`]);
    assert.ok(now.length > 0 && now.length < paras.length, `sent ${now.length} of ${paras.length}`);
    for (const t of now) assert.ok(!before.has(t), `"${t.slice(0, 20)}…" was translated already`);
    assert.equal(cached.length, paras.length, "everything cached afterwards");
    assert.equal(ext.overlaysSent().at(-1).blocks.length, paras.length);
    assert.ok(ext.hasLog(/\d+ 段已在快取，\d+ 段要翻譯/));
  });

  test("a layout's screen is read (OCR) once, even when its paragraphs come from the cache", async () => {
    const ext = startExtension();
    await showAndWait(ext, 0);
    await showAndWait(ext, 1);
    await showAndWait(ext, 0);
    await showAndWait(ext, 1);
    assert.equal(ext.ocr.calls.length, 2);
  });

  test("the button on the screen drawn retranslates it, skipping the cache", async () => {
    let round = 0;
    const ext = startExtension({ claude: (req) => req.kind === "translate" && { json: { translations: req.items.map((p) => ({ id: p.id, text: `第${round}版：${p.text}` })), notes: "", summarized: false } } });
    await showAndWait(ext, 0);
    round = 1;
    await ext.pressTranslate();
    await ext.idle();
    assert.ok(ext.hasLog(/^手動翻譯：按下「翻譯這一頁」/));
    assert.ok(ext.hasLog(/^重新翻譯本頁（位置 \d+–\d+），不使用快取/));
    assert.equal(ext.claude.of("translate").length, 4);
    assert.equal(ext.ocr.calls.length, 1, "the screen isn't read again");
    assert.ok(ext.overlaysSent().at(-1).blocks.every((b) => b.text.startsWith("第1版")));
    assert.ok(ext.cachedParas().every((k) => ext.session()[k].text.startsWith("第1版")));
  });

  test("the button on a cached screen that isn't drawn uses the cache", async () => {
    const ext = startExtension();
    await showAndWait(ext, 0);
    await ext.chrome.storage.session.remove("drawn");
    await ext.translate();
    assert.equal(ext.claude.of("translate").length, 2);
    assert.equal(ext.overlaysSent().length, 2);
    assert.equal(ext.msgs("result").at(-1).cached, true);
  });

  test("the button on a new screen translates it right away, without waiting to settle", async () => {
    const ext = startExtension({ settings: { autoTranslate: false } });
    await ext.show(0);
    await ext.translate();
    assert.equal(ext.overlaysSent().length, 1);
  });

  test("keeps the newest CACHE_PARAS paragraphs and CACHE_PAGES screens", async () => {
    const ext = startExtension({ panel: false });
    const { ctx } = ext;
    const paraCap = ctx.run("CACHE_PARAS");
    const pageCap = ctx.run("CACHE_PAGES");
    const items = {};
    for (let i = 0; i < paraCap + 3; i++) items[`para:B:r:${i}-${i}`] = { text: `t${i}` };
    for (let i = 0; i < pageCap + 2; i++) items[`page:k:${i}`] = { paras: [] };
    await ctx.cacheWrite(items);
    const index = ext.session().cacheIndex;
    assert.equal(index.paras.length, paraCap);
    assert.equal(index.pages.length, pageCap);
    assert.equal(ext.session()["para:B:r:0-0"], undefined);
    assert.equal(ext.session()["para:B:r:3-3"].text, "t3");
    assert.equal(ext.session()["page:k:1"], undefined);
    // Writing a key again makes it the newest.
    await ctx.cacheWrite({ "para:B:r:3-3": { text: "again" } });
    assert.equal(ext.session().cacheIndex.paras.at(-1), "para:B:r:3-3");
    assert.equal(ext.session().cacheIndex.paras.length, paraCap);
  });

  test("concurrent cache writes all land, and a failed one doesn't block the next", async () => {
    const ext = startExtension({ panel: false });
    const { ctx, chrome } = ext;
    await Promise.all([ctx.cacheWrite({ "para:a:1:1-1": { text: "a" } }), ctx.cacheWrite({ "para:a:1:2-2": { text: "b" } })]);
    assert.equal(ext.session().cacheIndex.paras.length, 2);
    const real = chrome.storage.session.set;
    chrome.storage.session.set = async () => {
      throw new Error("quota");
    };
    await assert.rejects(ctx.cacheWrite({ "para:a:1:3-3": { text: "c" } }), /quota/);
    chrome.storage.session.set = real;
    await ctx.cacheWrite({ "para:a:1:4-4": { text: "d" } });
    assert.equal(ext.session()["para:a:1:4-4"].text, "d");
  });
});

test.describe("jobs: turning away, back, and cancelling", () => {
  test("turning away mid-translation finishes the old screen in the background", async () => {
    const gate = deferred();
    const ext = startExtension({ claude: async (req) => (req.n < 2 ? (await gate.promise, undefined) : undefined) });
    await ext.show(0);
    await waitFor(() => ext.claude.calls.length === 2, { what: "screen 0 requests" });
    await ext.show(1);
    assert.ok(ext.hasLog(/畫面已換頁：先前那一頁（位置 \d+–\d+）改在背景翻完並存快取/));
    gate.resolve();
    await ext.idle();
    assert.ok(ext.hasLog(/背景翻完先前那一頁：位置/));
    // Screen 0 was cached but not drawn; screen 1 was drawn.
    assert.deepEqual(
      ext.overlaysSent().map((o) => o.page.start),
      [ext.info(1).start]
    );
    for (const p of R.pageParagraphs(ext.layout.screens[0])) assert.ok(ext.session()[`para:B0TESTBOOK:rev1:${p.start}-${p.end}`]);
    await ext.show(0);
    assert.equal(ext.overlaysSent().at(-1).page.start, ext.info(0).start, "drawn from the cache at once");
  });

  test("turning back to a screen still translating in the background waits for it", async () => {
    const gate = deferred();
    const ext = startExtension({ claude: async (req) => (req.n < 2 ? (await gate.promise, undefined) : undefined) });
    await ext.show(0);
    await waitFor(() => ext.claude.calls.length === 2, { what: "screen 0 requests" });
    await ext.show(1);
    await ext.show(0);
    await ext.sleep(80); // settled: a new job for screen 0 waits on the old one
    assert.ok(ext.hasLog(/段正由其他請求翻譯，等它們完成/));
    gate.resolve();
    await ext.idle();
    const sent = allSent(ext);
    assert.equal(sent.filter((t) => t === ext.texts(0)[0]).length, 1, "screen 0 sent once");
    assert.equal(ext.overlaysSent().at(-1).page.start, ext.info(0).start);
    assert.equal(ext.ocr.calls.filter((c) => c.drawn.start === ext.info(0).start).length, 1);
  });

  test("only one screen keeps translating in the background", async () => {
    const ext = startExtension({ claude: () => ({ hang: true }) });
    await ext.show(0);
    await waitFor(() => ext.claude.calls.length === 2, { what: "screen 0" });
    await ext.show(1);
    await ext.sleep(80);
    await waitFor(() => ext.claude.calls.length === 4, { what: "screen 1" });
    await ext.show(2);
    assert.ok(ext.hasLog(/背景翻譯已達上限，取消最早的一個/));
    await waitFor(() => ext.hasLog(/已取消背景翻譯（位置/), { what: "cancel logged" });
    assert.equal(ext.ctx.run("background.size"), 1);
  });

  test("a job the reader left before it could draw doesn't draw", async () => {
    const gate = deferred();
    const ext = startExtension({ claude: async () => (await gate.promise, undefined) });
    await ext.show(0);
    await waitFor(() => ext.claude.calls.length === 2, { what: "requests" });
    // The page moved on without a pageShown reaching the worker yet.
    await ext.chrome.storage.session.set({ shown: { ...ext.info(1), tabId: 1, windowId: 1 } });
    gate.resolve();
    await ext.idle();
    assert.ok(ext.hasLog(/翻譯期間畫面已換頁，這份譯文不畫上去（已存快取）/));
    assert.equal(ext.overlaysSent().length, 0);
  });

  test("the page refusing an overlay because it moved on is only logged", async () => {
    const ext = startExtension();
    ext.tab.onOverlay = () => ({ shown: false, stale: true, reason: "畫面已經換頁，這份譯文不畫" });
    await showAndWait(ext, 0);
    assert.equal(ext.msgs("warn").length, 0);
    assert.ok(ext.hasLog(/覆蓋層沒有顯示：畫面已經換頁，這份譯文不畫/));
  });

  test("the page refusing an overlay for another reason is a warning", async () => {
    const ext = startExtension();
    ext.tab.onOverlay = () => ({ shown: false, reason: "看不到書頁圖片" });
    await showAndWait(ext, 0);
    assert.equal(ext.msgs("warn").at(-1).text, "覆蓋層沒有顯示：看不到書頁圖片");
  });

  test("screens shown in quick succession: only the last is drawn from the cache", async () => {
    const ext = startExtension();
    await showAndWait(ext, 0);
    await showAndWait(ext, 1);
    const before = ext.overlaysSent().length;
    const results = ext.msgs("result").length;
    // Both reported before either is handled.
    const sender = { tab: { ...ext.chrome._.activeTab } };
    ext.tab.index = 1;
    await Promise.all([ext.ctx.onPageShown({ type: "pageShown", page: ext.info(0) }, sender), ext.ctx.onPageShown({ type: "pageShown", page: ext.info(1) }, sender)]);
    await ext.idle();
    const drawn = ext.overlaysSent().slice(before).map((o) => o.page.start);
    assert.deepEqual(drawn, [ext.info(1).start]);
    assert.equal(ext.msgs("result").length, results + 1);
    assert.equal(ext.msgs("warn").length, 0);
  });

  test("the button while the screen is being translated waits for it instead of paying twice", async () => {
    const gate = deferred();
    const ext = startExtension({ claude: async (req) => (req.n < 2 ? (await gate.promise, undefined) : undefined) });
    await ext.show(0);
    await waitFor(() => ext.claude.calls.length === 2, { what: "first requests" });
    await ext.pressTranslate();
    gate.resolve();
    await ext.idle();
    assert.ok(!ext.hasLog(/取消進行中的請求/));
    assert.equal(ext.claude.of("translate").length, 2, "nothing sent again");
    assert.equal(ext.overlaysSent().length, 1);
  });

  test("pressing again while a retranslation runs cancels it and starts over", async () => {
    let hang = false;
    const ext = startExtension({ claude: () => (hang ? { hang: true } : undefined) });
    await showAndWait(ext, 0);
    hang = true;
    await ext.pressTranslate(); // retranslate: hangs
    await waitFor(() => ext.claude.calls.length > 4, { what: "retranslation requests" });
    hang = false;
    await ext.pressTranslate(); // still the drawn screen: retranslate again
    await ext.idle();
    assert.ok(ext.hasLog(/手動翻譯：取消進行中的請求，改翻目前畫面/));
    assert.ok(ext.hasLog(/已取消前一個請求/));
    assert.equal(ext.overlaysSent().length, 2);
    assert.equal(ext.msgs("error").length, 0);
  });

  test("paragraphs Claude leaves blank are cached as blank, not asked for again", async () => {
    const ext = startExtension({
      settings: { quality: "haiku", prefetch: true },
      claude: (req) => req.kind === "translate" && { json: { translations: req.items.map((p, i) => ({ id: p.id, text: i === 0 ? "" : `譯：${p.text}` })), notes: "", summarized: false } },
    });
    const forScreen1 = () => ext.claude.of("translate").filter((r) => r.items.some((p) => ext.texts(1).includes(p.text))).length;
    await showAndWait(ext, 1);
    const asked = forScreen1();
    assert.ok(asked >= 1);
    await showAndWait(ext, 2);
    await showAndWait(ext, 1);
    assert.equal(ext.msgs("result").at(-1).cached, true, "screen 1 drawn from the cache, blanks and all");
    assert.equal(forScreen1(), asked, "nothing of screen 1 asked for again");
    assert.ok(ext.hasLog(/下一頁已經翻好/), "screen 2 counts as done too");
    const blanks = ext.cachedParas().filter((k) => ext.session()[k].text === "");
    assert.ok(blanks.length >= 1);
  });

  test("paragraphs another job failed to get are sent again", async () => {
    let fail = true;
    const ext = startExtension({
      claude: async (req) => {
        if (req.n < 2 && fail) {
          await new Promise((r) => setTimeout(r, 60));
          return { status: 500 };
        }
        return undefined;
      },
    });
    await ext.show(0);
    await waitFor(() => ext.claude.calls.length === 2, { what: "first requests" });
    await ext.show(1);
    await ext.show(0); // waits for screen 0's failing requests
    await ext.idle();
    fail = false;
    assert.ok(ext.hasLog(/背景翻譯失敗/));
    assert.equal(ext.overlaysSent().at(-1).page.start, ext.info(0).start);
    assert.equal(ext.cachedParas().length >= ext.texts(0).length, true);
  });

  test("a hung request times out and frees the worker", async () => {
    const ext = startExtension({ claude: () => ({ hang: true }) });
    await showAndWait(ext, 0);
    assert.match(ext.msgs("error")[0].text, /等候 Claude 回應超過 180 秒/);
    assert.equal(ext.ctx.run("current"), null);
    assert.equal(ext.ctx.run("inflight.size"), 0);
  });

  test("a long request keeps the service worker alive", async () => {
    const gate = deferred();
    const ext = startExtension({ claude: async (req) => (req.n === 0 ? (await gate.promise, undefined) : undefined) });
    await ext.show(0);
    await new Promise((r) => setTimeout(r, 30 * 20)); // past one scaled 20 s keep-alive tick
    gate.resolve();
    await ext.idle();
    assert.ok(ext.chrome._.platformInfoCalls >= 1);
  });
});

test.describe("prefetching the next screen", () => {
  const on = { prefetch: true };

  test("after a screen is drawn, the next one is translated ahead; turning to it needs no request", async () => {
    const ext = startExtension({ settings: on });
    await showAndWait(ext, 0);
    assert.ok(ext.hasLog(/^預讀下一頁：開始（位置 \d+–\d+）/));
    assert.ok(ext.hasLog(/^預讀完成：位置/));
    assert.deepEqual(
      ext.ocr.calls.map((c) => c.drawn.start),
      [ext.info(0).start, ext.info(1).start]
    );
    assert.equal(ext.overlaysSent().length, 1, "the prefetched screen isn't drawn");
    assert.equal(ext.msgs("result").length, 1, "nor posted");
    const calls = ext.claude.calls.length;
    await ext.show(1);
    assert.equal(ext.overlaysSent().at(-1).page.start, ext.info(1).start, "drawn at once");
    assert.equal(ext.msgs("result").at(-1).cached, true);
    await ext.idle();
    assert.equal(ext.claude.calls.filter((c, i) => i >= calls && c.kind === "translate" && sentTexts(c).some((t) => ext.texts(1).includes(t))).length, 0);
  });

  test("reading on, every screen after the first is drawn from the cache", async () => {
    const ext = startExtension({ settings: on });
    await showAndWait(ext, 0);
    for (let i = 1; i < 5; i++) {
      const before = ext.overlaysSent().length;
      await ext.show(i);
      assert.equal(ext.overlaysSent().length, before + 1, `screen ${i} drawn at once`);
      await ext.idle();
    }
  });

  test("turning to the next screen while it's being prefetched waits for it", async () => {
    const gate = deferred();
    let gated = false;
    const ext = startExtension({
      settings: on,
      claude: async (req) => {
        if (gated && req.kind === "translate") await gate.promise;
        return undefined;
      },
    });
    await ext.show(0);
    await waitFor(() => ext.overlaysSent().length === 1, { what: "screen 0 drawn" });
    gated = true;
    await waitFor(() => ext.hasLog(/^預讀下一頁：開始/), { what: "prefetch" });
    await ext.show(1);
    await ext.sleep(80);
    gate.resolve();
    await ext.idle();
    const sent = allSent(ext);
    for (const t of ext.texts(1).filter((x) => !ext.texts(0).includes(x))) assert.equal(sent.filter((s) => s === t).length, 1, "sent once");
    assert.equal(ext.ocr.calls.filter((c) => c.drawn.start === ext.info(1).start).length, 1, "read once");
    assert.equal(ext.overlaysSent().at(-1).page.start, ext.info(1).start);
  });

  test("a screen drawn from the cache prefetches the next too", async () => {
    const ext = startExtension({ settings: on });
    await showAndWait(ext, 3);
    await showAndWait(ext, 0);
    assert.ok(ext.ocr.calls.some((c) => c.drawn.start === ext.info(1).start));
  });

  test("a screen without text still prefetches the next", async () => {
    const book = testBook({ paragraphs: [{ image: true, lines: 12 }, ...Array.from({ length: 10 }, (_, i) => `paragraph number ${i} with a few words.`)] });
    const ext = startExtension({ book, settings: on, layout: { columns: 1 } });
    await showAndWait(ext, 0);
    assert.ok(ext.hasLog(/^預讀下一頁：開始/));
    assert.equal(ext.ocr.calls[0].drawn.start, ext.info(1).start);
  });

  for (const [name, settings, panel] of [
    ["the setting is off", { prefetch: false }, true],
    ["auto-translate is off", { prefetch: true, autoTranslate: false }, true],
    ["the vision engine is on", { prefetch: true, engine: "vision" }, true],
  ]) {
    test(`no prefetch when ${name}`, async () => {
      const ext = startExtension({ settings, claude: (req) => req.kind === "vision" && { json: { blocks: [{ kind: "paragraph", x0: 500, y0: 400, x1: 1500, y1: 600, lines: 3, text: "譯文" }], notes: "", summarized: false } } });
      if (panel) await ext.translate();
      await ext.idle();
      assert.ok(!ext.hasLog(/預讀下一頁/));
      assert.equal(ext.ocr.calls.filter((c) => c.drawn.start === ext.info(1).start).length, 0);
    });
  }

  test("no prefetch once the panel is closed", async () => {
    const ext = startExtension({ settings: on });
    await ext.ctx.translateActivePage({ force: true });
    ext.closePanel();
    await ext.idle();
    assert.equal(ext.ocr.calls.length, 1);
  });

  test("no prefetch if the reader moved on before the dwell ended", async () => {
    const ext = startExtension({ settings: { ...on, autoTranslate: true } });
    await ext.ctx.translateActivePage({ force: true });
    await ext.chrome.storage.session.set({ shown: { ...ext.info(5), tabId: 1, windowId: 1 } });
    await ext.idle();
    assert.ok(!ext.hasLog(/預讀下一頁/));
  });

  test("no prefetch while a screen turned past is still translating in the background", async () => {
    const gate = deferred();
    const ext = startExtension({ settings: on, claude: async (req) => (req.n < 2 ? (await gate.promise, undefined) : undefined) });
    await ext.show(0);
    await waitFor(() => ext.claude.calls.length === 2, { what: "screen 0" });
    await ext.show(4);
    await waitFor(() => ext.overlaysSent().length === 1, { what: "screen 4 drawn" });
    await waitFor(() => ext.hasLog(/沒有預讀下一頁：背景還在翻先前那一頁/), { what: "skip logged" });
    gate.resolve();
    await ext.idle();
  });

  test("no prefetch when the page has no next screen, or it's done already", async () => {
    const ext = startExtension({ settings: on });
    const last = ext.layout.screens.length - 1;
    await showAndWait(ext, last);
    assert.ok(ext.hasLog(/沒有預讀下一頁：頁面資料裡還沒有下一頁/));
    await showAndWait(ext, 1);
    await showAndWait(ext, 0);
    assert.ok(ext.hasLog(/下一頁已經翻好（位置/));
  });

  test("a failed prefetch is only logged", async () => {
    const ext = startExtension({ settings: on, claude: (req) => (req.n >= 4 ? { status: 500 } : undefined) });
    await showAndWait(ext, 0);
    assert.ok(ext.hasLog(/^預讀失敗：Claude API 錯誤 500/));
    assert.equal(ext.msgs("error").length, 0);
  });

  test("a page that can't answer for the next screen is only logged", async () => {
    const ext = startExtension({ settings: on });
    ext.tab.onPageData = (msg) => (msg.next ? Promise.reject(new Error("Frame removed")) : null);
    await showAndWait(ext, 0);
    assert.ok(ext.hasLog(/沒有預讀下一頁：Frame removed/));
  });

  test("jumping elsewhere doesn't cancel a prefetch; its screen is ready later", async () => {
    const gate = deferred();
    let gated = false;
    const ext = startExtension({ settings: on, claude: async () => (gated && (await gate.promise), undefined) });
    await ext.show(0);
    await waitFor(() => ext.overlaysSent().length === 1, { what: "screen 0" });
    gated = true;
    await waitFor(() => ext.hasLog(/^預讀下一頁：開始/), { what: "prefetch" });
    await ext.show(8);
    gate.resolve();
    await ext.idle();
    assert.ok(ext.hasLog(/^預讀完成/));
    await ext.show(1);
    assert.equal(ext.overlaysSent().at(-1).page.start, ext.info(1).start);
  });
});

test.describe("styles and highlights", () => {
  // Screen 0 of this book: a heading, then paragraphs; paragraph 1 has
  // italic words 3–5 ("Book of Tea") and a bold word 7 ("the").
  const styledBook = () =>
    testBook({
      paragraphs: [
        { text: "Chapter One", heading: true },
        { text: "she read the Book of Tea by the window and then went out", styles: { 3: "i", 4: "i", 5: "i", 7: "b" } },
        ...Array.from({ length: 12 }, (_, i) => `plain paragraph number ${i} with some words in it.`),
      ],
    });
  const promptOf = (req) => req.body.messages[0].content[0].text;

  test("italic and bold words go to Claude marked, with the rule about marks", async () => {
    const ext = startExtension({ book: styledBook() });
    await showAndWait(ext, 0);
    const sent = allSent(ext);
    assert.ok(sent.includes("she read the <i>Book of Tea</i> by <b>the</b> window and then went out"), sent.join(" | "));
    const withMarks = ext.claude.of("translate").find((r) => r.items.some((p) => p.text.includes("<i>")));
    assert.match(promptOf(withMarks), /<i>…<\/i>（斜體）/);
    const review = ext.claude.of("review").find((r) => r.items.some((p) => p.source.includes("<i>")));
    assert.match(promptOf(review), /保留初稿裡的 <i>/);
  });

  test("requests without any marks are asked exactly as before", async () => {
    const ext = startExtension();
    await showAndWait(ext, 0);
    for (const r of [...ext.claude.of("translate"), ...ext.claude.of("review")]) assert.doesNotMatch(promptOf(r), /標記/);
  });

  test("the translation keeps its marks into the overlay and the cache; the panel gets plain text", async () => {
    const ext = startExtension({ book: styledBook() });
    await showAndWait(ext, 0);
    const block = ext.overlaysSent()[0].blocks.find((b) => b.text.includes("<i>"));
    assert.equal(block.text, "譯：she read the <i>Book of Tea</i> by <b>the</b> window and then went out");
    assert.deepEqual(block.marks, {});
    assert.ok(Object.values(ext.session()).some((v) => v?.text === block.text));
    assert.doesNotMatch(ext.msgs("result")[0].text, /<\/?[ibh]/);
    assert.match(ext.msgs("result")[0].text, /Book of Tea/);
  });

  test("a translation with broken or invented marks keeps its words, without marks", async () => {
    const ext = startExtension({
      settings: { quality: "haiku" },
      book: styledBook(),
      claude: (req) =>
        req.kind === "translate" && {
          json: { translations: req.items.map((p) => ({ id: p.id, text: p.text.includes("<i>") ? "她讀了<i>茶之書" : p.text.includes("plain paragraph number 3") ? "<h1>亂加的</h1>" : `譯：${p.text}` })), notes: "", summarized: false },
        },
    });
    await showAndWait(ext, 0);
    const texts = ext.overlaysSent()[0].blocks.map((b) => b.text);
    assert.ok(texts.includes("她讀了茶之書"));
    assert.ok(!texts.some((t) => /<\/?[ibh]/.test(t) && !t.startsWith("譯：")));
    assert.ok(ext.hasLog(/段譯文的樣式標記不完整，改用不帶樣式的譯文/));
  });

  test("a highlight marks its words with its own number, and its colour goes to the page", async () => {
    const ext = startExtension({ book: styledBook() });
    ext.tab.highlights = [ext.highlightOver(2, "rgb(255, 230, 100)")];
    await showAndWait(ext, 0);
    const marked = allSent(ext).find((t) => t.startsWith("<h1>"));
    assert.equal(marked, `<h1>${ext.texts(0)[2]}</h1>`);
    const block = ext.overlaysSent()[0].blocks.find((b) => b.text.includes("<h1>"));
    assert.deepEqual(block.marks, { h1: "rgb(255, 230, 100)" });
    assert.ok(ext.cachedParas().some((k) => /:h[0-9a-z]+$/.test(k)), "its cache key carries the highlight");
  });

  test("two highlight colours in one paragraph are h1 and h2", async () => {
    const ext = startExtension({ book: styledBook() });
    const a = ext.highlightOver(2, "rgb(255, 230, 100)");
    const b = ext.highlightOver(2, "rgb(160, 200, 255)");
    // The first half of the words yellow, the rest blue.
    const half = Math.floor(a.boxes.length / 2);
    ext.tab.highlights = [
      { ...a, end: a.start + 5, boxes: a.boxes.slice(0, half) },
      { ...b, start: a.start + 6, boxes: b.boxes.slice(half) },
    ];
    await showAndWait(ext, 0);
    const marked = allSent(ext).find((t) => t.includes("<h2>"));
    assert.match(marked, /^<h1>.*<\/h1> <h2>.*<\/h2>$/);
    assert.deepEqual(ext.overlaysSent()[0].blocks.find((x) => x.text.includes("<h2>")).marks, { h1: "rgb(255, 230, 100)", h2: "rgb(160, 200, 255)" });
  });

  test("adding a highlight translates only that paragraph again; removing it needs no request", async () => {
    const ext = startExtension({ book: styledBook() });
    await showAndWait(ext, 0);
    const before = ext.claude.of("translate").length;
    await ext.setHighlights([ext.highlightOver(3)]);
    await ext.idle();
    assert.ok(ext.hasLog(/螢光標記改變了（位置 \d+–\d+，1 個）/));
    const again = ext.claude.of("translate").slice(before).flatMap(sentTexts);
    assert.deepEqual(again, [`<h1>${ext.texts(0)[3]}</h1>`], "only the highlighted paragraph");
    assert.ok(ext.overlaysSent().at(-1).blocks.some((x) => x.text.includes("<h1>")));
    const total = ext.claude.calls.length;
    await ext.setHighlights([]);
    await ext.idle();
    assert.equal(ext.claude.calls.length, total, "the plain translation is still cached");
    assert.ok(!ext.overlaysSent().at(-1).blocks.some((x) => x.text.includes("<h1>")));
  });

  test("a highlight outside every paragraph changes nothing", async () => {
    const ext = startExtension({ book: styledBook() });
    await showAndWait(ext, 0);
    const calls = ext.claude.calls.length;
    await ext.setHighlights([{ start: 999999, end: 1000010, color: "red", boxes: [{ x0: 0, y0: 0, x1: 1, y1: 1 }] }]);
    await ext.idle();
    assert.equal(ext.claude.calls.length, calls);
  });
});

test.describe("vision engine (Opus reads the screenshot)", () => {
  const BLOCK = { kind: "paragraph", x0: 500, y0: 400, x1: 1500, y1: 600, lines: 3, text: "譯文一" };
  const vision = (json) => (req) => req.kind === "vision" && { json: { blocks: [BLOCK], notes: "", summarized: false, ...json } };

  test("sends the screenshot to Opus, maps its boxes to page pixels, draws and caches them", async () => {
    const ext = startExtension({ settings: { engine: "vision", effort: "medium" }, claude: vision() });
    await showAndWait(ext, 0);
    assert.equal(ext.tab.cleared, 1, "the overlay hidden before the screenshot");
    assert.equal(ext.chrome._.captures, 1);
    assert.equal(ext.ocr.calls.length, 0);
    const [req] = ext.claude.of("vision");
    assert.equal(req.body.model, "claude-opus-5-5");
    assert.equal(req.body.output_config.effort, "medium");
    assert.equal(req.body.messages[0].content[0].type, "image");
    assert.match(req.body.messages[0].content[1].text, /2000×1400 像素/);
    // Screenshot 2000×1400 of a 1000×700 viewport; page image at 200,150–800,550
    // for a 300×200 page: x 500 → 250 css → 25 page px; y 400 → 200 → 25.
    const [block] = ext.overlaysSent()[0].blocks;
    assert.deepEqual(block.boxes, [{ x0: 25, y0: 25, x1: 275, y1: 75, lines: 3 }]);
    assert.equal(block.text, "譯文一");
    assert.equal(block.fg, "#000000");
    assert.ok(ext.session()[`vision:${ext.info(0).key}:${ext.info(0).start}`]);
    await showAndWait(ext, 1);
    await showAndWait(ext, 0);
    assert.equal(ext.claude.of("vision").length, 2, "screen 0 drawn from the cache");
    assert.ok(ext.hasLog(/命中快取（看圖模式，1 個區塊）/));
  });

  test("a large screenshot is scaled to the size the API takes", async () => {
    const ext = startExtension({ settings: { engine: "vision" }, claude: vision() });
    ext.shot = { width: 4000, height: 3000 };
    await showAndWait(ext, 0);
    assert.ok(ext.hasLog(/縮圖為 2221×1666/));
  });

  test("boxes outside the page are clamped; tiny and blank ones dropped; kinds folded", async () => {
    const blocks = [
      { kind: "heading", x0: 0, y0: 0, x1: 2000, y1: 1400, lines: 1, text: "全頁" },
      { kind: "paragraph", x0: 600, y0: 600, x1: 601, y1: 900, lines: 2, text: "太窄" },
      { kind: "caption", x0: 600, y0: 600, x1: 900, y1: 900, lines: 0, text: "  " },
      { kind: "quote", x0: 900, y0: 900, x1: 600, y1: 600, lines: "x", text: "反過來的框" },
    ];
    const ext = startExtension({ settings: { engine: "vision" }, claude: (req) => req.kind === "vision" && { json: { blocks, notes: "", summarized: false } } });
    await showAndWait(ext, 0);
    const got = ext.overlaysSent()[0].blocks;
    assert.deepEqual(
      got.map((b) => [b.kind, b.text, b.boxes[0].lines]),
      [
        ["heading", "全頁", 1],
        ["paragraph", "反過來的框", 1],
      ]
    );
    assert.deepEqual(got[0].boxes[0], { x0: 0, y0: 0, x1: 300, y1: 200, lines: 1 });
  });

  test("a summary is retried once, then shown but not cached", async () => {
    const ext = startExtension({ settings: { engine: "vision" }, claude: vision({ summarized: true }) });
    await showAndWait(ext, 0);
    assert.equal(ext.claude.of("vision").length, 2);
    assert.equal(ext.msgs("result")[0].summary, true);
    assert.equal(Object.keys(ext.session()).filter((k) => k.startsWith("vision:")).length, 0);
    assert.match(ext.msgs("warn").at(-1).text, /只給了摘要/);
  });

  test("a fallback model answering is reported to the panel", async () => {
    const ext = startExtension({ settings: { engine: "vision" }, claude: (req) => req.kind === "vision" && { model: "claude-opus-5", json: { blocks: [BLOCK], notes: "", summarized: false } } });
    await showAndWait(ext, 0);
    assert.equal(ext.msgs("result")[0].fallbackModel, "claude-opus-5");
  });

  test("no usable blocks: a warning with the reason and the screenshot, not cached", async () => {
    const ext = startExtension({ settings: { engine: "vision" }, claude: vision({ blocks: [], notes: "看不到內文" }) });
    await showAndWait(ext, 0);
    assert.match(ext.msgs("warn")[0].text, /沒有任何譯文區塊（claude-opus-5-5）：看不到內文/);
    assert.ok(ext.received.some((m) => m.type === "log" && m.image));
    assert.equal(ext.overlaysSent().length, 0);
  });

  test("without the page image's position there's nothing to map the boxes to", async () => {
    const ext = startExtension({ settings: { engine: "vision" }, claude: vision() });
    ext.tab.geometry = { viewport: { width: 1000, height: 700 }, page: null };
    await showAndWait(ext, 0);
    assert.equal(ext.msgs("error")[0].text, "頁面沒有回報書頁的位置，沒辦法對應截圖");
    assert.equal(ext.claude.calls.length, 0);
  });

  test("a screenshot taken after the reader moved on isn't used", async () => {
    const ext = startExtension({ settings: { engine: "vision" }, claude: vision() });
    ext.chrome._.screen = () => {
      ext.chrome.storage.session.set({ shown: { ...ext.info(3), tabId: 1, windowId: 1 } });
      return "data:image/jpeg;base64,c2NyZWVu";
    };
    await ext.translate();
    assert.ok(ext.hasLog(/截圖時畫面已換頁，這張截圖不用/));
    assert.equal(ext.claude.calls.length, 0);
  });

  test("a failure to hide the overlay is logged and the screenshot taken anyway", async () => {
    const ext = startExtension({ settings: { engine: "vision" }, claude: vision() });
    const handler = ext.chrome._.tabMessageHandler;
    ext.chrome._.tabMessageHandler = (id, msg, o) => (msg.type === "clearOverlay" ? Promise.reject(new Error("busy")) : handler(id, msg, o));
    await showAndWait(ext, 0);
    assert.ok(ext.hasLog(/清除覆蓋層失敗：busy/));
    assert.equal(ext.overlaysSent().length, 1);
  });

  test("screenshots are spaced at least CAPTURE_GAP_MS apart", async () => {
    const ext = startExtension({ panel: false });
    const times = [];
    ext.chrome.tabs.captureVisibleTab = async () => (times.push(Date.now()), "data:,");
    await Promise.all([ext.ctx.capture(1), ext.ctx.capture(1), ext.ctx.capture(1)]);
    const gap = ext.ctx.run("CAPTURE_GAP_MS") / 50;
    assert.ok(times[1] - times[0] >= gap - 2 && times[2] - times[1] >= gap - 2, times.join());
  });

  test("a failed capture doesn't stall the queue", async () => {
    const ext = startExtension({ panel: false });
    let n = 0;
    ext.chrome.tabs.captureVisibleTab = async () => {
      if (n++ === 0) throw new Error("not now");
      return "data:,ok";
    };
    await assert.rejects(ext.ctx.capture(1), /not now/);
    assert.equal(await ext.ctx.capture(1), "data:,ok");
  });
});

test.describe("errors before and during a request", () => {
  test("not a Kindle tab", async () => {
    const ext = startExtension();
    ext.chrome._.activeTab = { id: 2, windowId: 1, url: "https://example.com/", active: true };
    await ext.translate();
    assert.equal(ext.msgs("error")[0].text, "目前分頁不是 Kindle Cloud Reader。");
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
    assert.equal(ext.ocr.calls.length, 0);
  });

  test("a screen the page can't name is an error with its reason", async () => {
    const ext = startExtension();
    ext.tab.error = "還沒收到閱讀器的頁面資料，請重新整理 Kindle 分頁";
    await ext.translate();
    assert.equal(ext.msgs("error")[0].text, "無法辨識目前這一頁：還沒收到閱讀器的頁面資料，請重新整理 Kindle 分頁");
  });

  test("a page that doesn't answer at all is an error too", async () => {
    const ext = startExtension();
    const handler = ext.chrome._.tabMessageHandler;
    ext.chrome._.tabMessageHandler = (id, msg, o) => (msg.type === "currentPage" ? Promise.reject(new Error("Frame removed")) : handler(id, msg, o));
    await ext.translate();
    assert.equal(ext.msgs("error")[0].text, "無法辨識目前這一頁：Frame removed");
    ext.chrome._.tabMessageHandler = (id, msg, o) => (msg.type === "currentPage" ? undefined : handler(id, msg, o));
    await ext.translate();
    assert.equal(ext.msgs("error")[1].text, "無法辨識目前這一頁：頁面沒有回應");
  });

  test("an API error is shown and nothing is cached", async () => {
    const ext = startExtension({ claude: () => ({ status: 401 }) });
    await ext.translate();
    assert.match(ext.msgs("error")[0].text, /API key 無效（401）/);
    assert.ok(ext.hasLog(/^失敗：API key 無效/));
    assert.equal(ext.cachedParas().length, 0);
    assert.equal(ext.ctx.run("inflight.size"), 0);
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
});

test.describe("talking to the page and the panel", () => {
  test("a tab without a live content script gets both scripts injected and the message retried", async () => {
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
    assert.deepEqual(plain(ext.chrome._.executed), [
      { target: { tabId: 1, frameIds: [0] }, files: ["page-hook.js"], world: "MAIN" },
      { target: { tabId: 1, frameIds: [0] }, files: ["page-render.js", "styled-text.js", "content.js"], world: "ISOLATED" },
    ]);
    assert.equal(ext.overlaysSent().length, 1);
  });

  test("other errors talking to the page aren't retried", async () => {
    const ext = startExtension();
    ext.chrome._.tabMessageHandler = () => {
      throw new Error("No tab with id: 1");
    };
    await ext.translate();
    assert.equal(ext.chrome._.executed.length, 0);
    assert.match(ext.msgs("error")[0].text, /No tab with id/);
  });

  test("a page that can't take the overlay gets a warning to reload it", async () => {
    const ext = startExtension();
    ext.tab.onOverlay = () => {
      throw new Error("Frame removed");
    };
    await ext.translate();
    assert.match(ext.msgs("warn")[0].text, /譯文沒辦法疊到頁面上（Frame removed）。請重新整理 Kindle 分頁再試。/);
  });

  test("a page that doesn't answer the overlay says so", async () => {
    const ext = startExtension();
    ext.tab.onOverlay = () => ({});
    await ext.translate();
    assert.equal(ext.msgs("warn")[0].text, "覆蓋層沒有顯示：頁面沒有回應");
  });

  test("installing the extension sets up the panel and injects both scripts into open readers", async () => {
    const ext = startExtension();
    let behavior;
    ext.chrome.sidePanel.setPanelBehavior = async (b) => (behavior = b);
    ext.chrome.runtime.onInstalled.dispatch({ reason: "update" });
    await waitFor(() => ext.chrome._.executed.length === 2);
    assert.deepEqual(plain(behavior), { openPanelOnActionClick: true });
    assert.deepEqual(plain(ext.chrome._.executed), [
      { target: { tabId: 1 }, files: ["page-hook.js"], world: "MAIN" },
      { target: { tabId: 1 }, files: ["page-render.js", "styled-text.js", "content.js"], world: "ISOLATED" },
    ]);
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
    assert.ok(ext.hasLog(/覆蓋層已畫上 \d+ 段/));
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

  test("a newly opened panel gets the button label: retranslate only for the screen drawn", async () => {
    const ext = startExtension({ panel: false });
    ext.openPanel();
    await waitFor(() => ext.msgs("pageState").length);
    assert.equal(ext.msgs("pageState")[0].retranslate, false);
    await ext.translate();
    ext.closePanel();
    ext.received.length = 0;
    ext.openPanel();
    await waitFor(() => ext.msgs("pageState").length);
    assert.equal(ext.msgs("pageState")[0].retranslate, true);
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

test.describe("saving the page data (存下頁面資料)", () => {
  test("the panel's link saves the screen's data as JSON", async () => {
    const ext = startExtension();
    ext.port.postMessage({ type: "captureNow" });
    await waitFor(() => ext.msgs("savePage").length, { what: "savePage" });
    const [msg] = ext.msgs("savePage");
    assert.equal(msg.filename, `kindle-B0TESTBOOK-${ext.info(0).start}.json`);
    assert.equal(JSON.parse(msg.json).page.startPositionId, ext.info(0).start);
    assert.ok(ext.hasLog(/已存下頁面資料：kindle-B0TESTBOOK-\d+\.json（\d+ KB）/));
  });

  test("only on a Kindle tab", async () => {
    const ext = startExtension();
    ext.chrome._.activeTab = { id: 2, windowId: 1, url: "https://example.com/", active: true };
    ext.port.postMessage({ type: "captureNow" });
    await waitFor(() => ext.msgs("error").length);
    assert.equal(ext.msgs("error")[0].text, "目前分頁不是 Kindle Cloud Reader。");
  });

  test("a page that has nothing to save says why", async () => {
    const ext = startExtension();
    ext.tab.dump = { error: "還不知道目前是哪一頁" };
    ext.port.postMessage({ type: "captureNow" });
    await waitFor(() => ext.msgs("error").length);
    assert.equal(ext.msgs("error")[0].text, "存不了頁面資料：還不知道目前是哪一頁");
  });

  test("a page that doesn't answer is reported", async () => {
    const ext = startExtension();
    const handler = ext.chrome._.tabMessageHandler;
    ext.chrome._.tabMessageHandler = (id, msg, o) => (msg.type === "dumpPage" ? Promise.reject(new Error("gone")) : handler(id, msg, o));
    ext.port.postMessage({ type: "captureNow" });
    await waitFor(() => ext.msgs("error").length);
    assert.equal(ext.msgs("error")[0].text, "存不了頁面資料：gone");
  });
});

test.describe("page data asked for by a test tool", () => {
  const devOn = async (ext) => ext.chrome.storage.local.set({ devCapture: true });
  const ask = (ext, name, tab = ext.chrome._.activeTab) => ext.ctx.devCapture({ ...tab }, name);

  test("refused while the developer switch is off", async () => {
    const ext = startExtension();
    assert.deepEqual(plain(await ask(ext, "x")), { ok: false, error: "開發者開關沒有開啟（設定頁）" });
    assert.equal(ext.receiverPosts.length, 0);
  });

  test("sent to the local receiver, named as asked", async () => {
    const ext = startExtension();
    await devOn(ext);
    assert.deepEqual(plain(await ask(ext, "alice-ch1-p1")), { ok: true, filename: "alice-ch1-p1.json" });
    const [post] = ext.receiverPosts;
    assert.equal(post.url, "http://127.0.0.1:8765/page");
    assert.equal(post.body.filename, "alice-ch1-p1.json");
    assert.equal(post.body.data.page.startPositionId, ext.info(0).start);
  });

  test("an unusable name falls back to the page's own", async () => {
    const ext = startExtension();
    await devOn(ext);
    for (const name of ["../etc/passwd", "UPPER", "", undefined, 42, "x".repeat(100)]) {
      assert.equal((await ask(ext, name)).filename, `kindle-B0TESTBOOK-${ext.info(0).start}.json`);
    }
  });

  test("only the tab on screen, and only a Kindle tab", async () => {
    const ext = startExtension();
    await devOn(ext);
    assert.equal((await ask(ext, "x", { ...ext.chrome._.activeTab, active: false })).error, "只能存目前顯示的 Kindle 分頁");
    assert.equal((await ask(ext, "x", { id: 3, url: "https://example.com", active: true })).error, "只能存目前顯示的 Kindle 分頁");
    assert.equal((await ext.ctx.devCapture(undefined, "x")).error, "只能存目前顯示的 Kindle 分頁");
  });

  test("a page with nothing to save, or a receiver that refuses, is reported", async () => {
    const ext = startExtension();
    await devOn(ext);
    ext.tab.dump = { error: "還不知道目前是哪一頁" };
    assert.deepEqual(plain(await ask(ext, "x")), { ok: false, error: "還不知道目前是哪一頁" });
    ext.tab.dump = null;
    ext.receiverStatus = 500;
    assert.deepEqual(plain(await ask(ext, "x")), { ok: false, error: "接收程式回應 HTTP 500" });
  });

  test("the onMessage listener answers devCapture asynchronously", async () => {
    const ext = startExtension();
    await devOn(ext);
    let reply;
    const done = new Promise((r) => (reply = r));
    const returned = ext.chrome.runtime.onMessage.dispatch({ type: "devCapture", name: "p" }, { tab: { ...ext.chrome._.activeTab } }, reply);
    assert.ok(returned.includes(true));
    assert.equal((await done).filename, "p.json");
    // A failure inside still answers.
    ext.chrome.storage.local.get = async () => {
      throw new Error("storage gone");
    };
    let reply2;
    const done2 = new Promise((r) => (reply2 = r));
    ext.chrome.runtime.onMessage.dispatch({ type: "devCapture", name: "p" }, { tab: { ...ext.chrome._.activeTab } }, reply2);
    assert.deepEqual(plain(await done2), { ok: false, error: "storage gone" });
  });
});
