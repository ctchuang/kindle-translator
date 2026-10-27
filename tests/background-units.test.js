// background.js helpers, called directly in the worker's scope.

const test = require("node:test");
const assert = require("node:assert/strict");
const { plain } = require("./helpers/load");
const { startExtension } = require("./helpers/extension");

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
    let seed = 7;
    const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
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

  test("isSummary: translated texts (OCR engine) labelled （摘要）", () => {
    assert.equal(ctx.isSummary({ summarized: false, notes: "", texts: ["  （摘要）本章…"] }), true);
    assert.equal(ctx.isSummary({ summarized: false, notes: "", texts: ["他寫了一份摘要。", ""] }), false);
    assert.equal(ctx.isSummary({ summarized: false, texts: [] }), false, "no notes at all");
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

test.describe("screens and cache keys", () => {
  const ctx = worker();
  const page = { key: "B0X|rev|Bookerly|10", start: 100, end: 400, asin: "B0X", revision: "rev" };

  test("a screen is its layout key and start", () => {
    assert.equal(ctx.screenId(page), "B0X|rev|Bookerly|10|100");
    assert.equal(ctx.screenId(null), null);
    assert.equal(ctx.sameScreen(page, { ...page, end: 999, tabId: 3 }), true);
    assert.equal(ctx.sameScreen(page, { ...page, start: 101 }), false);
    assert.equal(ctx.sameScreen(page, { ...page, key: "other" }), false);
    assert.equal(ctx.sameScreen(page, null), false);
    assert.equal(ctx.sameScreen(null, null), false);
  });

  test("a paragraph's key is the book and its position range, whatever the layout", () => {
    assert.equal(ctx.paraKey(page, { start: 120, end: 180 }), "para:B0X:rev:120-180");
    assert.equal(ctx.paraKey({ ...page, key: "other layout" }, { start: 120, end: 180 }), "para:B0X:rev:120-180");
    assert.notEqual(ctx.paraKey({ ...page, revision: "rev2" }, { start: 120, end: 180 }), "para:B0X:rev:120-180");
  });

  test("a screen's record and vision result are keyed by layout and start", () => {
    assert.equal(ctx.recordKey(page), "page:B0X|rev|Bookerly|10:100");
    assert.equal(ctx.visionKey(page), "vision:B0X|rev|Bookerly|10:100");
  });

  test("describeScreen names the position range", () => {
    assert.equal(ctx.describeScreen(page), "位置 100–400");
  });

  test("cachedTexts: every paragraph with text cached, or null", async () => {
    const ext = startExtension({ panel: false });
    const record = { paras: [{ start: 1, end: 5, source: "a" }, { start: 7, end: 9, source: "b" }, { start: 11, end: 12, source: "  " }] };
    assert.equal(await ext.ctx.cachedTexts(page, record), null);
    await ext.ctx.cacheWrite({ "para:B0X:rev:1-5": { text: "甲" } });
    assert.equal(await ext.ctx.cachedTexts(page, record), null, "one is still missing");
    await ext.ctx.cacheWrite({ "para:B0X:rev:7-9": { text: "乙" } });
    assert.deepEqual(plain([...(await ext.ctx.cachedTexts(page, record))]), [
      ["para:B0X:rev:1-5", "甲"],
      ["para:B0X:rev:7-9", "乙"],
    ]);
    assert.deepEqual(plain([...(await ext.ctx.cachedTexts(page, { paras: [] }))]), [], "nothing to translate is complete");
  });

  test("the shown screen and the drawn one live in session storage", async () => {
    const ext = startExtension();
    await ext.ctx.setShown(page);
    assert.deepEqual(plain(await ext.ctx.getShown()), page);
    await ext.ctx.setShown(null);
    assert.equal(await ext.ctx.getShown(), null);
    await ext.ctx.setDrawn(page);
    assert.equal(await ext.ctx.getDrawn(), ctx.screenId(page));
    await ext.ctx.setDrawn(null);
    assert.equal(await ext.ctx.getDrawn(), null);
    await ext.tick();
    assert.deepEqual(
      ext.msgs("pageState").slice(-2).map((m) => m.retranslate),
      [true, false]
    );
  });

  test("deferred resolves from outside", async () => {
    const d = ctx.deferred();
    d.resolve(42);
    assert.equal(await d.promise, 42);
  });
});

test.describe("visionParas", () => {
  const ctx = worker();
  const page = { width: 300, height: 200, ink: "#acacac" };
  const image = { width: 2000, height: 1400 };
  const geometry = { viewport: { width: 1000, height: 700 }, page: { left: 200, top: 150, right: 800, bottom: 550 } };

  test("screenshot pixels become page pixels through the page image's box", () => {
    const [p] = plain(ctx.visionParas([{ kind: "paragraph", x0: 500, y0: 400, x1: 1500, y1: 600, lines: 3, text: " 譯文 " }], image, geometry, page));
    assert.deepEqual(p, { kind: "paragraph", text: "譯文", boxes: [{ x0: 25, y0: 25, x1: 275, y1: 75, lines: 3 }], fg: "#acacac" });
  });

  test("clamped to the page, corners in any order, lines at least 1", () => {
    const [p] = plain(ctx.visionParas([{ kind: "heading", x0: 2000, y0: 1400, x1: 0, y1: 0, lines: 0.2, text: "x" }], image, geometry, page));
    assert.deepEqual(p.boxes, [{ x0: 0, y0: 0, x1: 300, y1: 200, lines: 1 }]);
    assert.equal(p.kind, "heading");
  });

  test("tiny, blank and textless blocks are dropped; other kinds are paragraphs", () => {
    const out = plain(
      ctx.visionParas(
        [
          { kind: "caption", x0: 500, y0: 400, x1: 505, y1: 600, text: "narrow" },
          { kind: "caption", x0: 500, y0: 400, x1: 900, y1: 404, text: "flat" },
          { kind: "caption", x0: 500, y0: 400, x1: 900, y1: 600, text: "  " },
          { kind: "caption", x0: 500, y0: 400, x1: 900, y1: 600 },
          { kind: "footnote", x0: 500, y0: 400, x1: 900, y1: 600, lines: "x", text: "ok" },
          { kind: "quote", x0: "a", y0: 400, x1: 900, y1: 600, text: "nan corner" },
        ],
        image,
        geometry,
        page
      )
    );
    assert.deepEqual(
      out.map((p) => [p.kind, p.text, p.boxes[0].lines]),
      [["paragraph", "ok", 1]],
      "a box with a corner that isn't a number has no size"
    );
  });
});
