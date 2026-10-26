// background.js helpers, called directly in the worker's scope.

const test = require("node:test");
const assert = require("node:assert/strict");
const { plain } = require("./helpers/load");
const { startExtension } = require("./helpers/extension");
const { screenUrl, THEMES, rng } = require("./helpers/images");

function worker() {
  return startExtension({ panel: false }).ctx;
}

test.describe("splitParas", () => {
  const ctx = worker();
  const paras = (lens) => lens.map((n, id) => ({ id, text: "x".repeat(n) }));
  const blocks = (cols) => cols.map((column) => ({ column }));

  test("nothing to translate gives no chunks", () => {
    assert.deepEqual(plain(ctx.splitParas([], [])), []);
  });

  test("fewer than four paragraphs stay in one request", () => {
    const p = paras([10, 20, 30]);
    assert.deepEqual(plain(ctx.splitParas(p, blocks([0, 0, 0]))), [plain(p)]);
  });

  test("a two-page spread splits at the first paragraph of the right page", () => {
    const p = paras([10, 10, 10, 10, 10]);
    const out = plain(ctx.splitParas(p, blocks([0, 0, 0, 1, 1])));
    assert.deepEqual(out.map((c) => c.map((x) => x.id)), [[0, 1, 2], [3, 4]]);
  });

  test("one column splits in half by length, not by count", () => {
    const p = paras([100, 10, 10, 10, 10, 10]);
    const out = plain(ctx.splitParas(p, blocks([0, 0, 0, 0, 0, 0])));
    assert.deepEqual(out.map((c) => c.map((x) => x.id)), [[0], [1, 2, 3, 4, 5]]);
  });

  test("a page that starts in the right column still splits by length", () => {
    const p = paras([10, 10, 10, 10]);
    const out = plain(ctx.splitParas(p, blocks([1, 1, 1, 1])));
    assert.deepEqual(out.map((c) => c.map((x) => x.id)), [[0, 1], [2, 3]]);
  });

  test("every paragraph ends up in exactly one chunk", () => {
    const rand = rng("split");
    for (let n = 4; n < 30; n++) {
      const p = paras(Array.from({ length: n }, () => 1 + Math.floor(rand() * 200)));
      const ids = plain(ctx.splitParas(p, blocks(p.map(() => 0)))).flat().map((x) => x.id);
      assert.deepEqual(ids, p.map((x) => x.id));
    }
  });
});

test.describe("isDeclined / isSummary", () => {
  const ctx = worker();
  const chunk = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }];
  const tr = (ids) => ids.map((id) => ({ id, text: `t${id}` }));

  test("a full translation is not declined", () => {
    assert.equal(ctx.isDeclined({ translations: tr([0, 1, 2, 3]), notes: "" }, chunk), false);
  });

  test("half the paragraphs translated is still accepted", () => {
    assert.equal(ctx.isDeclined({ translations: tr([0, 1]), notes: "" }, chunk), false);
  });

  test("fewer than half translated is declined", () => {
    assert.equal(ctx.isDeclined({ translations: tr([0]), notes: "" }, chunk), true);
  });

  test("blank translations don't count", () => {
    const out = { translations: [{ id: 0, text: " " }, { id: 1, text: "" }, { id: 2, text: "ok" }], notes: "" };
    assert.equal(ctx.isDeclined(out, chunk), true);
  });

  test("a summary is declined, flagged or mentioned in the notes", () => {
    assert.equal(ctx.isDeclined({ translations: tr([0, 1, 2, 3]), summarized: true }, chunk), true);
    assert.equal(ctx.isDeclined({ translations: tr([0, 1, 2, 3]), notes: "這是摘要" }, chunk), true);
  });

  test("a missing translations array is declined", () => {
    assert.equal(ctx.isDeclined({}, chunk), true);
  });

  test("isSummary: flag, notes, or a block labelled （摘要）/(摘要", () => {
    assert.equal(ctx.isSummary({ summarized: true, notes: "", blocks: [] }), true);
    assert.equal(ctx.isSummary({ summarized: false, notes: "內容摘要如下", blocks: [] }), true);
    assert.equal(ctx.isSummary({ summarized: false, notes: "", blocks: [{ text: "  （摘要）本章…" }] }), true);
    assert.equal(ctx.isSummary({ summarized: false, notes: "", blocks: [{ text: "(摘要) …" }] }), true);
    assert.equal(ctx.isSummary({ summarized: false, notes: "", blocks: [{ text: "他寫了一份摘要。" }] }), false);
    assert.equal(ctx.isSummary({ summarized: false, notes: "", blocks: [{}] }), false);
  });
});

test.describe("parseReply", () => {
  const ctx = worker();

  test("joins the text blocks and parses them", () => {
    const out = ctx.parseReply([{ type: "text", text: '{"a":' }, { type: "text", text: "1}" }]);
    assert.deepEqual(plain(out), { a: 1 });
  });

  test("ignores non-text blocks", () => {
    const out = ctx.parseReply([{ type: "thinking", thinking: "" }, { type: "text", text: '{"a":2}' }]);
    assert.deepEqual(plain(out), { a: 2 });
  });

  test("after a mid-output fallback, uses the part after the last marker", () => {
    const content = [
      { type: "text", text: '{"translations":[{"id":0,"te' },
      { type: "fallback" },
      { type: "text", text: '{"translations":[],"notes":"x","summarized":false}' },
    ];
    assert.deepEqual(plain(ctx.parseReply(content)), { translations: [], notes: "x", summarized: false });
  });

  test("unparsable text without a fallback marker throws", () => {
    assert.throws(() => ctx.parseReply([{ type: "text", text: "{oops" }]));
  });

  test("no content throws", () => {
    assert.throws(() => ctx.parseReply());
  });
});

test.describe("finishBlocks", () => {
  async function image(theme) {
    const ext = startExtension({ panel: false });
    return { ctx: ext.ctx, img: await ext.ctx.prepareImage(screenUrl({ theme }), false) };
  }
  const rgb = ([r, g, b]) => `rgb(${r},${g},${b})`;

  test("boxes become viewport fractions, clamped and ordered", async () => {
    const { ctx, img } = await image("white");
    const [b] = plain(ctx.finishBlocks([{ kind: "paragraph", text: " 譯文 ", lines: 2.6, x0: 900, y0: 500, x1: -40, y1: 100 }], img));
    assert.deepEqual(b.box, [0, 100 / 600, 900 / 960, 500 / 600]);
    assert.equal(b.text, "譯文");
    assert.equal(b.lines, 3);
    assert.equal(b.kind, "paragraph");
  });

  test("tiny, empty and blank blocks are dropped", async () => {
    const { ctx, img } = await image("white");
    const out = ctx.finishBlocks(
      [
        { text: "a", x0: 10, y0: 10, x1: 13, y1: 100 },
        { text: "a", x0: 10, y0: 10, x1: 100, y1: 12 },
        { text: "   ", x0: 10, y0: 10, x1: 100, y1: 100 },
        { x0: 10, y0: 10, x1: 100, y1: 100 },
        { text: "ok", x0: 10, y0: 10, x1: 100, y1: 100 },
      ],
      img
    );
    assert.equal(out.length, 1);
  });

  test("lines defaults to 1 when missing or nonsense", async () => {
    const { ctx, img } = await image("white");
    const out = plain(ctx.finishBlocks([{ text: "a", lines: "x", x0: 0, y0: 0, x1: 50, y1: 50 }, { text: "b", lines: 0, x0: 0, y0: 0, x1: 50, y1: 50 }], img));
    assert.deepEqual(out.map((b) => b.lines), [1, 1]);
  });

  for (const theme of ["white", "sepia", "dark"]) {
    test(`samples the ${theme} page background and ink around a text block`, async () => {
      const { ctx, img } = await image(theme);
      // A block over the text area of the synthetic page.
      const [b] = plain(ctx.finishBlocks([{ text: "x", x0: 140, y0: 80, x1: 820, y1: 300 }], img));
      assert.equal(b.bg, rgb(THEMES[theme].bg));
      assert.equal(b.fg, rgb(THEMES[theme].ink));
    });
  }

  test("a blank box falls back to black ink on light pages and white on dark", async () => {
    for (const [theme, ink] of [["white", "rgb(0,0,0)"], ["dark", "rgb(255,255,255)"]]) {
      const { ctx, img } = await image(theme);
      // Below the text area: nothing but background.
      const [b] = plain(ctx.finishBlocks([{ text: "x", x0: 140, y0: 540, x1: 820, y1: 580 }], img));
      assert.equal(b.fg, ink);
    }
  });
});

test.describe("prompts and labels", () => {
  const ctx = worker();

  test("buildPrompt states the image size and target language", () => {
    const p = ctx.buildPrompt("日本語", 1200, 800);
    assert.match(p, /1200×800/);
    assert.match(p, /翻成日本語/);
  });

  test("buildTextPrompt ends with the paragraphs as JSON", () => {
    const paras = [{ id: 0, text: "Hello" }, { id: 1, text: 'A "quote"' }];
    const p = ctx.buildTextPrompt("繁體中文", paras);
    assert.match(p, /翻成繁體中文/);
    assert.deepEqual(JSON.parse(p.slice(p.lastIndexOf("\n\n") + 2)), paras);
  });

  test("buildReviewPrompt ends with source and draft as JSON", () => {
    const items = [{ id: 3, source: "Hi", draft: "嗨" }];
    const p = ctx.buildReviewPrompt("繁體中文", items);
    assert.match(p, /校對/);
    assert.deepEqual(JSON.parse(p.slice(p.lastIndexOf("\n\n") + 2)), items);
  });

  test("qualityOf falls back to the default for unknown levels", () => {
    assert.deepEqual(plain(ctx.qualityOf({ quality: "haiku" })), { translate: "claude-haiku-5-5" });
    assert.deepEqual(plain(ctx.qualityOf({ quality: "nope" })), { translate: "claude-haiku-5-5", review: "claude-sonnet-5-5" });
    assert.deepEqual(plain(ctx.qualityOf({})), plain(ctx.qualityOf({ quality: "review" })));
  });

  test("blocksToText joins with blank lines, or says the page is empty", () => {
    assert.equal(ctx.blocksToText([{ text: "a" }, { text: "b" }]), "a\n\nb");
    assert.equal(ctx.blocksToText([]), "（此頁無內文）");
  });

  test("bytesToBase64 matches Buffer for large inputs", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    assert.equal(ctx.bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
  });

  test("describeLayout counts the regions kept in the original", () => {
    const layout = { regions: [[{ cls: "figure" }, { cls: "plain text" }], [{ cls: "table" }, { cls: "isolate_formula" }, { cls: "title" }]], ms: 42 };
    const out = plain(ctx.describeLayout(layout));
    assert.equal(out.level, "ok");
    assert.match(out.text, /5 個區塊，3 個圖、表或公式保留原文，42 毫秒/);
  });

  test("describeRefusal names the category, explanation, reply text and model", () => {
    const text = ctx.describeRefusal({
      model: "claude-opus-5-5",
      stop_details: { category: "bio", explanation: "classifier", recommended_model: "claude-opus-5" },
      content: [{ type: "text", text: "I can't" }, { type: "text", text: " help." }],
    });
    assert.match(text, /^Claude 拒絕處理這一頁。/);
    assert.match(text, /類別：生物安全（bio）/);
    assert.match(text, /說明：classifier/);
    assert.match(text, /模型回覆：I can't help\./);
    assert.match(text, /建議改用：claude-opus-5/);
    assert.match(text, /模型：claude-opus-5-5/);
  });

  test("describeRefusal copes with missing details and unknown categories", () => {
    assert.match(ctx.describeRefusal({}), /沒有分類/);
    assert.match(ctx.describeRefusal({}), /模型：未知/);
    assert.match(ctx.describeRefusal({ stop_details: { category: "new_thing" } }), /類別：new_thing（new_thing）/);
    const long = ctx.describeRefusal({ content: [{ type: "text", text: "x".repeat(1000) }] });
    assert.match(long, /模型回覆：x{300}\n/);
  });
});

test.describe("page cache", () => {
  // Random fingerprints far apart from each other.
  function sig(seed) {
    const rand = rng(String(seed));
    const bytes = Buffer.alloc(32).map(() => Math.floor(rand() * 256));
    return `16x16:${bytes.toString("base64")}`;
  }

  test("stores and finds a page by fingerprint", async () => {
    const ext = startExtension({ panel: false });
    const blocks = [{ text: "譯" }];
    await ext.ctx.cacheSet(sig(1), blocks);
    assert.deepEqual(plain(await ext.ctx.cacheGet(sig(1))), blocks);
    assert.equal(await ext.ctx.cacheGet(sig(2)), undefined);
  });

  test("a near-identical fingerprint is the same page", async () => {
    const ext = startExtension({ panel: false });
    const a = await ext.ctx.pageSigOf(screenUrl({ page: "p1" }));
    const b = await ext.ctx.pageSigOf(screenUrl({ page: "p1", toolbar: true }));
    await ext.ctx.cacheSet(a, [{ text: "x" }]);
    assert.deepEqual(plain(await ext.ctx.cacheGet(b)), [{ text: "x" }]);
  });

  test("storing the same page again replaces it instead of adding an entry", async () => {
    const ext = startExtension({ panel: false });
    await ext.ctx.cacheSet(sig(1), [{ text: "old" }]);
    await ext.ctx.cacheSet(sig(1), [{ text: "new" }]);
    assert.equal(ext.cachedPages(), 1);
    assert.deepEqual(plain(await ext.ctx.cacheGet(sig(1))), [{ text: "new" }]);
  });

  test("an empty result is treated as a miss", async () => {
    const ext = startExtension({ panel: false });
    await ext.ctx.cacheSet(sig(1), []);
    assert.equal(await ext.ctx.cacheGet(sig(1)), undefined);
  });

  test("concurrent writes all land", async () => {
    const ext = startExtension({ panel: false });
    await Promise.all([1, 2, 3, 4, 5].map((i) => ext.ctx.cacheSet(sig(i), [{ text: `p${i}` }])));
    assert.equal(ext.cachedPages(), 5);
    for (const i of [1, 2, 3, 4, 5]) assert.deepEqual(plain(await ext.ctx.cacheGet(sig(i))), [{ text: `p${i}` }]);
  });

  test("keeps the newest CACHE_PAGES pages and deletes the oldest's blocks", async () => {
    const ext = startExtension({ panel: false });
    const limit = ext.ctx.run("CACHE_PAGES");
    for (let i = 0; i <= limit; i++) await ext.ctx.cacheSet(sig(i), [{ text: `p${i}` }]);
    assert.equal(ext.cachedPages(), limit);
    assert.equal(await ext.ctx.cacheGet(sig(0)), undefined);
    assert.deepEqual(plain(await ext.ctx.cacheGet(sig(limit))), [{ text: `p${limit}` }]);
    const pageKeys = [...ext.chrome.storage.session.data.keys()].filter((k) => k.startsWith("page:"));
    assert.equal(pageKeys.length, limit);
  });

  test("a failed write doesn't block later ones", async () => {
    const ext = startExtension({ panel: false });
    const set = ext.chrome.storage.session.set;
    ext.chrome.storage.session.set = async () => {
      throw new Error("quota");
    };
    await assert.rejects(ext.ctx.cacheSet(sig(1), [{ text: "a" }]), /quota/);
    ext.chrome.storage.session.set = set;
    await ext.ctx.cacheSet(sig(2), [{ text: "b" }]);
    assert.deepEqual(plain(await ext.ctx.cacheGet(sig(2))), [{ text: "b" }]);
  });

  test("swapLastSig returns the previous fingerprint", async () => {
    const ext = startExtension({ panel: false });
    assert.equal(await ext.ctx.swapLastSig("a"), undefined);
    assert.equal(await ext.ctx.swapLastSig("b"), "a");
  });

  test("setShownSig tells the panel whether the button retranslates", async () => {
    const ext = startExtension();
    await new Promise((r) => setTimeout(r, 5)); // the panel's own initial pageState
    ext.received.length = 0;
    await ext.ctx.setShownSig("s");
    await ext.ctx.setShownSig(null);
    await ext.tick();
    assert.deepEqual(plain(ext.msgs("pageState")), [{ type: "pageState", retranslate: true }, { type: "pageState", retranslate: false }]);
    assert.equal(await ext.ctx.getShownSig(), undefined);
  });
});

test.describe("capture", () => {
  test("spaces screenshots at least CAPTURE_GAP_MS apart", async () => {
    const ext = startExtension({ panel: false });
    const times = [];
    const orig = ext.chrome.tabs.captureVisibleTab;
    ext.chrome.tabs.captureVisibleTab = async (...a) => {
      times.push(Date.now());
      return orig(...a);
    };
    await Promise.all([ext.ctx.capture(1), ext.ctx.capture(1), ext.ctx.capture(1)]);
    const gap = ext.ctx.run("CAPTURE_GAP_MS") / require("./helpers/load").TIME_SCALE;
    // Timers may fire a millisecond early.
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= gap - 2, `gap ${times[i] - times[i - 1]} ms`);
  });

  test("a failed capture doesn't stall the queue", async () => {
    const ext = startExtension({ panel: false });
    const orig = ext.chrome._.screen;
    ext.chrome._.screen = null;
    await assert.rejects(ext.ctx.capture(1));
    ext.chrome._.screen = orig;
    assert.match(await ext.ctx.capture(1), /^data:image/);
  });
});

test.describe("ocrCrop", () => {
  const ctx = worker();
  const vp = { width: 1571, height: 974 };

  test("the page image's box as fractions of the viewport", () => {
    // Measured in Kindle Cloud Reader: the page image at 157–1414 × 60–884.
    const crop = plain(ctx.ocrCrop({ viewport: vp, page: { left: 157, top: 60, right: 1414, bottom: 884 } }));
    assert.deepEqual(crop, { x0: 157 / 1571, y0: 60 / 974, x1: 1414 / 1571, y1: 884 / 974 });
  });

  test("clamped to the screen", () => {
    const crop = plain(ctx.ocrCrop({ viewport: vp, page: { left: -20, top: -5, right: 1700, bottom: 1000 } }));
    assert.deepEqual(crop, { x0: 0, y0: 0, x1: 1, y1: 1 });
  });

  test("falls back to OCR_CROP without a usable page box", () => {
    const fallback = ctx.run("OCR_CROP");
    for (const g of [
      undefined,
      null,
      { viewport: vp, page: null },
      { page: { left: 0, top: 0, right: 100, bottom: 100 } },
      { viewport: { width: 0, height: 0 }, page: { left: 0, top: 0, right: 100, bottom: 100 } },
      { viewport: vp, page: { left: 100, top: 100, right: 200, bottom: 800 } }, // too narrow
      { viewport: vp, page: { left: 100, top: 100, right: 1400, bottom: 150 } }, // too short
    ]) {
      assert.equal(ctx.ocrCrop(g), fallback, JSON.stringify(g));
    }
  });
});

test.describe("fingerprint area", () => {
  const geometry = { viewport: { width: 960, height: 600 }, dpr: 1, page: { left: 96, top: 60, right: 864, bottom: 540 } };
  const dims = (sig) => sig.split(":")[0];

  test("follows the book page image, inset a few pixels", async () => {
    const ext = startExtension({ panel: false });
    const sig = await ext.ctx.pageSigOf(screenUrl({}), geometry);
    const inset = ext.ctx.run("SIG_INSET_PX");
    const w = 768 - 2 * inset;
    const h = 480 - 2 * inset;
    assert.equal(dims(sig), `240x${Math.round((240 * h) / w)}`);
  });

  test("uses CONTENT_CROP before the page has ever said where the book is", async () => {
    const ext = startExtension({ panel: false });
    const C = plain(ext.ctx.run("CONTENT_CROP"));
    const sig = await ext.ctx.pageSigOf(screenUrl({}), null);
    assert.equal(dims(sig), `240x${Math.round((240 * 600 * (C.y1 - C.y0)) / (960 * (C.x1 - C.x0)))}`);
  });

  test("reuses the last measured area for the same screenshot size", async () => {
    const ext = startExtension({ panel: false });
    const measured = await ext.ctx.pageSigOf(screenUrl({}), geometry);
    const unmeasured = await ext.ctx.pageSigOf(screenUrl({}), null);
    assert.equal(unmeasured, measured);
    // Another window size: nothing measured for it yet.
    const other = await ext.ctx.pageSigOf(screenUrl({ w: 800, h: 600 }), null);
    assert.notEqual(dims(other), dims(measured));
  });

  test("leaves out a title bar the fixed area takes in", async () => {
    const ext = startExtension({ panel: false });
    const g = { viewport: { width: 960, height: 600 }, dpr: 1, page: { left: 96, top: 62, right: 864, bottom: 540 } };
    const shown = await ext.ctx.pageSigOf(screenUrl({ toolbar: 0.1 }), g);
    const hidden = await ext.ctx.pageSigOf(screenUrl({ toolbar: false }), g);
    assert.equal(ext.ctx.pageDiff(shown, hidden), 0);
    const fresh = startExtension({ panel: false });
    const a = await fresh.ctx.pageSigOf(screenUrl({ toolbar: 0.1 }), null);
    const b = await fresh.ctx.pageSigOf(screenUrl({ toolbar: false }), null);
    assert.ok(fresh.ctx.pageDiff(a, b) > 0, "the old fixed area sees the title bar");
  });
});
