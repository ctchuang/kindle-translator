// page-render.js: reading the reader's page data (TAR of JSON), its layout
// key, paragraphs and columns, drawing a screen, and telling which screen an
// image shows. Runs on the synthetic book (tests/helpers/kindle.js) and a
// canvas that really fills pixels (tests/helpers/raster.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../page-render.js");
const { makeBook, makeTar, words } = require("./helpers/kindle");
const raster = require("./helpers/raster");

global.OffscreenCanvas = raster.OffscreenCanvas;
global.Path2D = raster.Path2D;

const enc = (s) => new TextEncoder().encode(s);
const dec = (u8) => new TextDecoder().decode(u8);

function batch(layout, from = 0, count = 6) {
  const { url, bytes } = layout.response(from, count);
  return R.parseRender(bytes, url);
}

function pixels(page, fonts, scale = 2) {
  const c = R.renderPage(page, fonts, scale);
  return c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
}

// A run as the reader sends it, for tests that build screens by hand.
function run({ x = 10, y = 20, size = 10, text = "word", el = 1, start = 100, color = "#000000ff", weight = 400, right } = {}) {
  return {
    type: "run",
    transform: [1, 0, 0, 1, x, y],
    rect: { top: -size, left: 0, bottom: size * 0.3, right: right ?? text.length * size * 0.5 },
    elementId: el,
    startPositionId: start,
    endPositionId: start + text.length - 1,
    textColor: color,
    fontKey: "f",
    fontSize: size,
    fontWeight: weight,
    glyphs: [...text].map((c) => c.charCodeAt(0)),
    xPosition: [...text].map((_, i) => i * size * 0.5),
  };
}

function screen(children, { width = 300, height = 200, start = 100, fill = "#ffffffff", ink = "#000000ff" } = {}) {
  return { type: "page", width, height, startPositionId: start, endPositionId: start + 50, fillColor: fill, inkColor: ink, children };
}

// ---- untar ----

test.describe("untar", () => {
  test("reads every file by name, skipping PAX headers", () => {
    const files = R.untar(makeTar({ "a.json": "[1]", "b.txt": "hello" }));
    assert.deepEqual([...files.keys()], ["a.json", "b.txt"]);
    assert.equal(dec(files.get("a.json")), "[1]");
    assert.equal(dec(files.get("b.txt")), "hello");
  });

  test("files larger than a block and exactly a block long", () => {
    const big = "x".repeat(1300);
    const exact = "y".repeat(512);
    const files = R.untar(makeTar({ "big": big, "exact": exact, "after": "z" }));
    assert.equal(dec(files.get("big")), big);
    assert.equal(dec(files.get("exact")), exact);
    assert.equal(dec(files.get("after")), "z");
  });

  test("an empty file and an empty archive", () => {
    assert.equal(R.untar(makeTar({ empty: "" })).get("empty").length, 0);
    assert.equal(R.untar(new Uint8Array(1024)).size, 0);
    assert.equal(R.untar(new Uint8Array(0)).size, 0);
  });

  test("accepts an ArrayBuffer", () => {
    const u8 = makeTar({ a: "1" });
    assert.equal(dec(R.untar(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)).get("a")), "1");
  });

  test("a ustar prefix is part of the name", () => {
    const tar = makeTar({ "f.json": "{}" });
    // Put "dir" in the prefix field of the second header (the file itself).
    Buffer.from(tar.buffer).write("dir", 1024 + 345);
    assert.ok(R.untar(tar).has("dir/f.json"));
  });

  test("a truncated archive is an error", () => {
    const tar = makeTar({ a: "x".repeat(2000) });
    assert.throws(() => R.untar(tar.subarray(0, 1024 + 512 + 100)), /截斷/);
  });

  test("a nonsense size is an error", () => {
    const tar = makeTar({ a: "1" });
    Buffer.from(tar.buffer).write("zzzzzzzzzzz", 1024 + 124); // the file's own header
    assert.throws(() => R.untar(tar), /大小/);
  });
});

// ---- layout key and parsing ----

test.describe("layoutOf / parseRender", () => {
  const book = makeBook();
  const L = book.layout();

  test("the key is made of the layout parameters only", () => {
    const a = R.layoutOf(L.url(0, 6));
    const b = R.layoutOf(L.url(12, -6));
    assert.equal(a.key, b.key, "paging parameters don't change the layout");
    assert.equal(a.params.asin, "B0TESTBOOK");
    assert.equal(a.params.rasterScale, "2");
    assert.deepEqual(Object.keys(a.params), R.LAYOUT_PARAMS);
  });

  test("every layout parameter changes the key", () => {
    const base = new URL(L.url());
    const key = R.layoutOf(base.href).key;
    for (const p of R.LAYOUT_PARAMS) {
      const u = new URL(base);
      u.searchParams.set(p, `${u.searchParams.get(p)}x`);
      assert.notEqual(R.layoutOf(u.href).key, key, p);
    }
  });

  test("a relative URL works, and missing parameters are empty", () => {
    const { params } = R.layoutOf("/renderer/render?asin=X");
    assert.equal(params.asin, "X");
    assert.equal(params.theme, "");
  });

  test("parses the screens and the fonts", () => {
    const b = batch(L);
    assert.equal(b.key, L.key);
    assert.equal(b.pages.length, 6);
    assert.deepEqual(
      b.pages.map((p) => p.startPositionId),
      L.screens.slice(0, 6).map((s) => s.startPositionId)
    );
    assert.deepEqual(Object.keys(b.fonts).sort(), ["testserifBold", "testserifNormal"]);
    assert.equal(b.fonts.testserifNormal.unitsPerEm, 1000);
    const ids = Object.keys(b.fonts.testserifNormal.glyphs).map(Number);
    assert.ok(ids.length > 10 && Object.values(b.fonts.testserifNormal.glyphs).every((g) => g.path.startsWith("M")));
  });

  test("several page_data files are read in name order", () => {
    const files = {
      "page_data_6_11.json": JSON.stringify([L.screens[6]]),
      "page_data_0_5.json": JSON.stringify([L.screens[0]]),
      "glyphs.json": "[]",
    };
    const b = R.parseRender(makeTar(files), L.url());
    assert.deepEqual(
      b.pages.map((p) => p.startPositionId),
      [L.screens[0].startPositionId, L.screens[6].startPositionId]
    );
    assert.deepEqual(b.fonts, {});
  });

  test("no glyphs file gives no fonts", () => {
    const b = R.parseRender(makeTar({ "page_data_0_0.json": JSON.stringify([L.screens[0]]) }), L.url());
    assert.deepEqual(b.fonts, {});
  });

  test("a response without page_data is refused", () => {
    assert.throws(() => R.parseRender(makeTar({ "glyphs.json": "[]" }), L.url()), /page_data/);
  });

  test("screens in an unknown shape are refused", () => {
    for (const bad of [[{}], [{ startPositionId: 1, width: 0, height: 10, children: [] }], [{ startPositionId: 1, width: 10, height: 10 }], [null]]) {
      assert.throws(() => R.parseRender(makeTar({ "page_data_0_0.json": JSON.stringify(bad) }), L.url()), /格式/);
    }
  });

  test("broken JSON is refused", () => {
    assert.throws(() => R.parseRender(makeTar({ "page_data_0_0.json": "[{" }), L.url()));
  });

  test("each response numbers its glyphs afresh: a screen draws right only with its own batch's fonts", () => {
    const a = batch(L, 0, 6);
    const b = batch(L, 6, 6);
    const page = b.pages[0];
    const truth = raster.readerPixels(L.screens[6], L.fonts, 2);
    assert.equal(R.pixelDiff(pixels(page, b.fonts), truth.data, truth.width, R.imageMasks(page, 2)), 0);
    // The same ids in the other batch are other glyphs.
    assert.ok(R.pixelDiff(pixels(page, a.fonts), truth.data, truth.width, R.imageMasks(page, 2)) > 0.01);
  });
});

// ---- geometry ----

test.describe("boxOf / pageColumns / cssColor", () => {
  test("a run's box is its rect around the baseline origin", () => {
    assert.deepEqual(R.boxOf({ transform: [1, 0, 0, 1, 43.5, 17], rect: { top: -14.5, left: 0, bottom: 3.5, right: 600 } }), { x0: 43.5, y0: 2.5, x1: 643.5, y1: 20.5 });
  });

  test("an illustration's rect is scaled by its transform", () => {
    assert.deepEqual(R.boxOf({ transform: [2, 0, 0, 2, 10, 20], rect: { top: 0, left: 0, bottom: 50, right: 100 } }), { x0: 10, y0: 20, x1: 210, y1: 120 });
  });

  test("runs on both sides of the middle are two columns", () => {
    const p = screen([run({ x: 10, text: "left" }), run({ x: 200, text: "right" })]);
    assert.deepEqual(R.pageColumns(p), [
      [0, 150],
      [150, 300],
    ]);
  });

  test("a run across the middle means one column", () => {
    const p = screen([run({ x: 10, text: "left" }), run({ x: 200, text: "right" }), run({ x: 10, text: "x", right: 280 })]);
    assert.deepEqual(R.pageColumns(p), [[0, 300]]);
  });

  test("runs on one side only, or none, are one column", () => {
    assert.deepEqual(R.pageColumns(screen([run({ x: 10 })])), [[0, 300]]);
    assert.deepEqual(R.pageColumns(screen([run({ x: 200 })])), [[0, 300]]);
    assert.deepEqual(R.pageColumns(screen([])), [[0, 300]]);
  });

  test("the synthetic book's spreads and single columns", () => {
    const book = makeBook();
    assert.equal(R.pageColumns(book.layout({ columns: 2 }).screens[1]).length, 2);
    assert.equal(R.pageColumns(book.layout({ columns: 1 }).screens[1]).length, 1);
  });

  test("cssColor drops the alpha and lower-cases; anything else is the fallback", () => {
    assert.equal(R.cssColor("#25383CFF"), "#25383c");
    assert.equal(R.cssColor("#e7dec7"), "#e7dec7");
    assert.equal(R.cssColor("red", "#123456"), "#123456");
    assert.equal(R.cssColor(undefined), "#000000");
    assert.equal(R.cssColor("#12"), "#000000");
  });
});

// ---- paragraphs ----

test.describe("pageParagraphs", () => {
  test("one paragraph per element, in position order, with its range", () => {
    const p = screen([run({ el: 2, start: 200, y: 60, text: "second" }), run({ el: 1, start: 100, y: 20, text: "first" }), run({ el: 1, start: 106, y: 34, text: "line" })]);
    const paras = R.pageParagraphs(p);
    assert.deepEqual(
      paras.map((x) => [x.id, x.start, x.end]),
      [
        [1, 100, 109],
        [2, 200, 205],
      ]
    );
  });

  test("a paragraph's box covers its runs, and counts its lines", () => {
    const p = screen([run({ el: 1, x: 10, y: 20, text: "aaaa" }), run({ el: 1, x: 10, y: 34, text: "aaaaaaaa" }), run({ el: 1, x: 20, y: 34, text: "aa" })]);
    const [para] = R.pageParagraphs(p);
    assert.deepEqual(para.boxes, [{ x0: 10, y0: 10, x1: 50, y1: 37, lines: 2 }]);
  });

  test("a paragraph running from the left column into the right gets a box in each", () => {
    const p = screen([run({ el: 7, x: 10, y: 180, text: "end of left", start: 100 }), run({ el: 7, x: 160, y: 20, text: "top of right", start: 112 }), run({ el: 8, x: 160, y: 40, start: 130 })]);
    const [para] = R.pageParagraphs(p);
    assert.equal(para.column, 0);
    assert.equal(para.boxes.length, 2);
    assert.ok(para.boxes[0].x1 <= 150 && para.boxes[1].x0 >= 150);
    assert.deepEqual(
      para.boxes.map((b) => b.lines),
      [1, 1]
    );
  });

  test("a paragraph only in the right column says so", () => {
    const p = screen([run({ el: 1, x: 10 }), run({ el: 2, x: 200, start: 200 })]);
    assert.deepEqual(
      R.pageParagraphs(p).map((x) => x.column),
      [0, 1]
    );
  });

  test("large text is a heading, body-size text a paragraph", () => {
    const p = screen([run({ el: 1, size: 16, text: "Title", start: 1 }), run({ el: 2, size: 10, text: "a".repeat(80), start: 10, y: 60 })]);
    assert.deepEqual(
      R.pageParagraphs(p).map((x) => x.kind),
      ["heading", "paragraph"]
    );
  });

  test("a short all-bold paragraph is a heading; a long one or a mixed one isn't", () => {
    const body = run({ el: 9, text: "b".repeat(200), start: 900, y: 150 });
    const p = screen([
      run({ el: 1, weight: 700, text: "Bold title", start: 1, y: 20 }),
      run({ el: 2, weight: 700, text: "x", start: 20, y: 40 }),
      run({ el: 2, weight: 700, text: "y", start: 22, y: 54 }),
      run({ el: 2, weight: 700, text: "z", start: 24, y: 68 }),
      run({ el: 3, weight: 700, text: "bold", start: 40, y: 90 }),
      run({ el: 3, weight: 400, text: "and not", start: 45, y: 104 }),
      body,
    ]);
    assert.deepEqual(
      R.pageParagraphs(p).map((x) => [x.id, x.kind]),
      [
        [1, "heading"],
        [2, "paragraph"],
        [3, "paragraph"],
        [9, "paragraph"],
      ]
    );
  });

  test("a drop cap doesn't make the first paragraph a heading; most of its glyphs decide", () => {
    const p = screen([
      run({ el: 1, size: 40, text: "T", start: 1, y: 40 }),
      run({ el: 1, size: 10, text: "he King and Queen of Hearts were seated", start: 2, x: 40, y: 20 }),
      run({ el: 1, size: 10, text: "on their throne when they arrived", start: 42, x: 40, y: 34 }),
      run({ el: 2, size: 10, text: "b".repeat(80), start: 100, y: 80 }),
    ]);
    assert.deepEqual(
      R.pageParagraphs(p).map((x) => x.kind),
      ["paragraph", "paragraph"]
    );
  });

  test("a paragraph mostly in bold but with one plain word is still bold enough for a heading", () => {
    const p = screen([run({ el: 1, weight: 700, text: "A Long Bold Title", start: 1 }), run({ el: 1, weight: 400, text: "x", start: 20, x: 200 }), run({ el: 2, text: "c".repeat(100), start: 50, y: 60 })]);
    assert.equal(R.pageParagraphs(p)[0].kind, "heading");
  });

  test("small bold text (a footnote marker) isn't a heading", () => {
    const p = screen([run({ el: 1, size: 7, weight: 700, text: "1", start: 1 }), run({ el: 2, text: "c".repeat(100), start: 5, y: 60 })]);
    assert.equal(R.pageParagraphs(p)[0].kind, "paragraph");
  });

  test("the text colour is the one most glyphs use, without alpha", () => {
    const p = screen([run({ el: 1, color: "#25383cff", text: "long coloured text" }), run({ el: 1, color: "#000000ff", text: "x", y: 34, start: 130 })]);
    assert.equal(R.pageParagraphs(p)[0].fg, "#25383c");
  });

  test("a run without a colour takes the page's ink", () => {
    const r = run();
    delete r.textColor;
    assert.equal(R.pageParagraphs(screen([r], { ink: "#acacacff" }))[0].fg, "#acacac");
  });

  test("illustrations and other children aren't paragraphs; a screen without runs has none", () => {
    const img = { type: "image", transform: [1, 0, 0, 1, 10, 10], rect: { top: 0, left: 0, bottom: 50, right: 50 } };
    assert.deepEqual(R.pageParagraphs(screen([img, { type: "panel" }])), []);
    assert.equal(R.pageParagraphs(screen([img, run()])).length, 1);
  });

  test("runs without an element id are paragraphs of their own", () => {
    const a = run({ start: 1 });
    const b = run({ start: 50, y: 40 });
    delete a.elementId;
    delete b.elementId;
    assert.equal(R.pageParagraphs(screen([a, b])).length, 2);
  });

  test("the same paragraph has the same range in any font size", () => {
    const book = makeBook();
    const ranges = (layout) => {
      const m = new Map();
      for (const s of layout.screens) for (const p of R.pageParagraphs(s)) m.set(p.id, [...(m.get(p.id) || []), [p.start, p.end]]);
      // Whole paragraphs: the union of the fragments.
      return new Map([...m].map(([id, fr]) => [id, [Math.min(...fr.map((f) => f[0])), Math.max(...fr.map((f) => f[1]))]]));
    };
    const a = ranges(book.layout({ fontSize: 10 }));
    const b = ranges(book.layout({ fontSize: 13 }));
    assert.ok(a.size > 10);
    for (const [id, r] of a) assert.deepEqual(b.get(id), r, `paragraph ${id}`);
  });

  test("a paragraph cut by the screen edge has a different range in another layout", () => {
    const book = makeBook();
    const cut = (layout) => R.pageParagraphs(layout.screens[0]).at(-1);
    assert.notDeepEqual([cut(book.layout({ fontSize: 10 })).start, cut(book.layout({ fontSize: 10 })).end], [cut(book.layout({ fontSize: 13 })).start, cut(book.layout({ fontSize: 13 })).end]);
  });
});

// ---- drawing ----

test.describe("renderPage", () => {
  const book = makeBook();
  const L = book.layout();
  const b = batch(L);

  test("is the screen's size times the scale, on its background", () => {
    const c = R.renderPage(b.pages[0], b.fonts, 2);
    assert.equal(c.width, 600);
    assert.equal(c.height, 400);
    assert.deepEqual(c.ops[0], { op: "fillRect", x: 0, y: 0, w: 600, h: 400, color: "#ffffff", transform: [1, 0, 0, 1, 0, 0] });
  });

  test("each glyph is filled at its run's transform, x position and font size", () => {
    const page = screen([run({ x: 10, y: 20, size: 10, text: "ab" })]);
    const fonts = { f: { unitsPerEm: 1000, glyphs: { 97: { path: "M0,-500 L400,-500 L400,0 L0,0 Z" }, 98: { path: "M0,0 Z" } } } };
    const c = R.renderPage(page, fonts, 2);
    const fills = c.ops.filter((o) => o.op === "fill");
    assert.equal(fills.length, 2);
    // scale 2 × font 10 / 1000 units = 0.02 per unit
    assert.deepEqual(fills[0].transform, [0.02, 0, 0, 0.02, 20, 40]);
    assert.deepEqual(fills[1].transform, [0.02, 0, 0, 0.02, 30, 40]);
    assert.equal(fills[0].color, "#000000");
  });

  test("glyphs without an outline (spaces) and runs in an unknown font are skipped", () => {
    const page = screen([run({ text: "a a" }), { ...run({ text: "zz", start: 300 }), fontKey: "missing" }]);
    const fonts = { f: { unitsPerEm: 1000, glyphs: { 97: { path: "M0,0 L1,1 Z" } } } };
    assert.equal(R.renderPage(page, fonts, 1).ops.filter((o) => o.op === "fill").length, 2);
  });

  test("runs are filled in their own colour, illustrations not at all", () => {
    const img = { type: "image", transform: [1, 0, 0, 1, 10, 10], rect: { top: 0, left: 0, bottom: 50, right: 50 } };
    const page = screen([img, run({ color: "#ff0000ff", text: "a" })]);
    const fonts = { f: { unitsPerEm: 1000, glyphs: { 97: { path: "M0,0 L1,1 Z" } } } };
    const ops = R.renderPage(page, fonts, 1).ops;
    assert.deepEqual(
      ops.map((o) => o.op),
      ["fillRect", "fill"]
    );
    assert.equal(ops[1].color, "#ff0000");
  });

  test("the theme's background and ink", () => {
    const dark = batch(book.layout({ theme: "dark" }));
    const ops = R.renderPage(dark.pages[1], dark.fonts, 1).ops;
    assert.equal(ops[0].color, "#000000");
    assert.equal(ops[1].color, "#acacac");
  });

  test("plain: black on white whatever the theme, for OCR", () => {
    const dark = batch(book.layout({ theme: "dark" }));
    const page = { ...dark.pages[1], children: [...dark.pages[1].children, run({ color: "#ff0000ff", text: "a", start: 99999 })] };
    const ops = R.renderPage(page, { ...dark.fonts, f: { unitsPerEm: 1000, glyphs: { 97: { path: "M0,0 L1,1 Z" } } } }, 1, new Map(), { plain: true }).ops;
    assert.equal(ops[0].color, "#ffffff");
    assert.ok(ops.slice(1).every((o) => o.color === "#000000"));
  });

  test("Path2D objects are made once per glyph and reused", () => {
    const made = [];
    const Real = global.Path2D;
    global.Path2D = class extends Real {
      constructor(d) {
        super(d);
        made.push(d);
      }
    };
    try {
      const paths = new Map();
      R.renderPage(b.pages[0], b.fonts, 1, paths);
      const first = made.length;
      R.renderPage(b.pages[0], b.fonts, 1, paths);
      assert.equal(made.length, first, "the second drawing made no new paths");
      assert.equal(paths.size, first);
    } finally {
      global.Path2D = Real;
    }
  });

  test("draws the very pixels the reader shows, illustrations aside", () => {
    for (const page of b.pages) {
      const shot = raster.readerPixels(page, b.fonts, 2);
      assert.equal(R.pixelDiff(pixels(page, b.fonts), shot.data, shot.width, R.imageMasks(page, 2)), 0);
    }
  });
});

// ---- decorations: shaded boxes and link underlines ----

test.describe("decorations", () => {
  const book = makeBook({
    paragraphs: [
      ...Array.from({ length: 4 }, (_, i) => `${words(i, 30)}.`),
      { text: `${words(9, 60)}.`, box: true },
      { text: `${words(10, 30)}.`, link: true },
      ...Array.from({ length: 6 }, (_, i) => `${words(i + 20, 30)}.`),
    ],
  });
  const L = book.layout();
  const page = L.screens.find((s) => s.children.some((c) => c.type === "group"));
  const box = { type: "group", transform: [1, 0, 0, 1, 20, 30], rect: { top: -3, left: -3, bottom: 50, right: 103 }, backDecoration: [{ type: "fillStroke", rect: { top: -3, left: -3, bottom: 50, right: 103 }, fillColor: "#e6e6e6ff" }] };
  const link = { type: "textline", transform: [1, 0, 0, 1, 10, 100], rect: { top: 0, left: 0, bottom: 14, right: 200 }, backDecoration: [{ type: "linkLine", strokeStartPoint: { x: 5, y: 12 }, strokeEndPoint: { x: 85, y: 12 }, strokeWidth: 1, strokeColor: "#0000ffff" }] };

  test("decorations lists what the reader draws behind items, by type", () => {
    const p = screen([box, link, run()]);
    assert.deepEqual(
      R.decorations(p).map((x) => x.deco.type),
      ["fillStroke", "linkLine"]
    );
    assert.equal(R.decorations(p, "fillStroke")[0].item, box);
    assert.deepEqual(R.decorations(screen([run(), { type: "group", backDecoration: "odd" }])), []);
  });

  test("a shaded box is filled behind the text in its colour, under its item's transform", () => {
    const fonts = { f: { unitsPerEm: 1000, glyphs: { 119: { path: "M0,0 L1,1 Z" } } } };
    const ops = R.renderPage(screen([run({ text: "w" }), box]), fonts, 2).ops;
    assert.deepEqual(ops[1], { op: "fillRect", x: -3, y: -3, w: 106, h: 53, color: "#e6e6e6", transform: [2, 0, 0, 2, 40, 60] });
    assert.equal(ops[2].op, "fill", "the text comes after the box");
  });

  test("a box without its own rect uses its item's; a missing colour is the reader's grey", () => {
    const bare = { ...box, backDecoration: [{ type: "fillStroke" }] };
    const [, fill] = R.renderPage(screen([bare]), {}, 1).ops;
    assert.deepEqual([fill.x, fill.y, fill.w, fill.h, fill.color], [-3, -3, 106, 53, "#e6e6e6"]);
  });

  test("plain drawings (for OCR) leave the boxes out", () => {
    assert.equal(R.renderPage(screen([box]), {}, 1, new Map(), { plain: true }).ops.length, 1);
  });

  test("link underlines aren't drawn", () => {
    assert.equal(R.renderPage(screen([link]), {}, 1).ops.length, 1);
  });

  test("compareMasks: the illustrations, a band along each box edge, and each link underline", () => {
    const img = { type: "image", transform: [1, 0, 0, 1, 200, 20], rect: { top: 0, left: 0, bottom: 10, right: 10 } };
    const masks = R.compareMasks(screen([img, box, link]), 2);
    assert.equal(masks.length, 1 + 4 + 1);
    assert.deepEqual(masks[0], R.imageMasks(screen([img]), 2)[0]);
    // The box spans x 34–246, y 54–160 at ×2; bands reach 4 px either side.
    assert.deepEqual(masks[1], [30, 50, 250, 58], "top edge");
    assert.deepEqual(masks[2], [30, 156, 250, 164], "bottom edge");
    assert.deepEqual(masks[3], [30, 50, 38, 164], "left edge");
    assert.deepEqual(masks[4], [242, 50, 250, 164], "right edge");
    // The underline at y 112 (×2 = 224), x 15–95 (×2 = 30–190), 2 px thick.
    assert.deepEqual(masks[5], [26, 218, 194, 230]);
  });

  test("a screen with a box and a link is still found, edges rounded and underline drawn by the reader", () => {
    const b = batch(L, 0, 6);
    const target = b.pages[L.screens.indexOf(page)];
    const shot = raster.readerPixels(page, L.fonts, 2);
    const hit = R.identifyScreen(shot, b.pages, (p) => pixels(p, b.fonts), 2);
    assert.equal(hit?.page, target);
    // Compared without the decoration bands, the same screen doesn't match.
    assert.ok(R.pixelDiff(pixels(target, b.fonts), shot.data, shot.width, R.imageMasks(target, 2)) > R.SAME_SCREEN_MAX_DIFF);
  });

  test("decorated items don't change the paragraphs or columns", () => {
    const plainRuns = { ...page, children: page.children.filter((c) => c.type === "run") };
    assert.deepEqual(R.pageParagraphs(page), R.pageParagraphs(plainRuns));
    assert.deepEqual(R.pageColumns(page), R.pageColumns(plainRuns));
  });
});

// ---- comparing and identifying ----

test.describe("pixelDiff / imageMasks", () => {
  const rgba = (w, h, f) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...f(x, y), 255], (y * w + x) * 4);
    return d;
  };
  const white = rgba(10, 10, () => [255, 255, 255]);

  test("identical images differ by 0", () => {
    assert.equal(R.pixelDiff(white, white.slice(), 10), 0);
  });

  test("the share of differing pixels", () => {
    const b = rgba(10, 10, (x) => (x < 3 ? [0, 0, 0] : [255, 255, 255]));
    assert.equal(R.pixelDiff(white, b, 10), 0.3);
  });

  test("small colour differences (anti-aliasing) don't count", () => {
    const b = rgba(10, 10, () => [245, 250, 255]);
    assert.equal(R.pixelDiff(white, b, 10), 0);
    const c = rgba(10, 10, () => [225, 255, 245]);
    assert.equal(R.pixelDiff(white, c, 10), 1);
  });

  test("masked rectangles are left out of the count and the total", () => {
    const b = rgba(10, 10, (x, y) => (x < 5 && y < 5 ? [0, 0, 0] : [255, 255, 255]));
    assert.equal(R.pixelDiff(white, b, 10, [[0, 0, 5, 5]]), 0);
    const c = rgba(10, 10, (x, y) => (x < 5 && y < 5 ? [0, 0, 0] : x === 9 && y === 9 ? [0, 0, 0] : [255, 255, 255]));
    assert.equal(R.pixelDiff(white, c, 10, [[0, 0, 5, 5]]), 1 / 75);
  });

  test("masks reaching past the image are clipped", () => {
    const b = rgba(10, 10, () => [0, 0, 0]);
    assert.equal(R.pixelDiff(white, b, 10, [[-5, -5, 20, 20]]), 0);
  });

  test("stops counting past the limit, returning more than it", () => {
    const b = rgba(10, 10, () => [0, 0, 0]);
    const d = R.pixelDiff(white, b, 10, [], 0.05);
    assert.ok(d > 0.05);
  });

  test("imageMasks grows each illustration by a pixel at the scale", () => {
    const p = screen([{ type: "image", transform: [1, 0, 0, 1, 10.2, 20], rect: { top: 0, left: 0, bottom: 30, right: 40 } }, run()]);
    assert.deepEqual(R.imageMasks(p, 2), [[19, 39, 102, 101]]);
    assert.deepEqual(R.imageMasks(screen([run()]), 2), []);
  });
});

test.describe("identifyScreen", () => {
  const book = makeBook({ paragraphs: [{ text: "Chapter One", heading: true }, ...Array.from({ length: 30 }, (_, i) => `${words(i, 40)}.`), { image: true, lines: 12 }, ...Array.from({ length: 10 }, (_, i) => `${words(i + 50, 40)}.`)] });
  const L = book.layout();
  const b = batch(L, 0, 12);
  const draw = (p) => pixels(p, b.fonts);

  test("finds each screen among its batch", () => {
    for (const page of b.pages) {
      const shot = raster.readerPixels(page, b.fonts, 2);
      const hit = R.identifyScreen(shot, b.pages, draw, 2);
      assert.equal(hit?.page.startPositionId, page.startPositionId);
      assert.equal(hit.diff, 0);
    }
  });

  test("a screen that is only an illustration is found too", () => {
    // In one column, the illustration takes a screen of its own.
    const one = batch(book.layout({ columns: 1 }), 0, 40);
    const only = one.pages.find((p) => p.children.every((c) => c.type === "image"));
    assert.ok(only, "the book has an illustration-only screen");
    const hit = R.identifyScreen(raster.readerPixels(only, one.fonts, 2), one.pages, (p) => pixels(p, one.fonts), 2);
    assert.equal(hit.page, only);
  });

  test("a screen that is mostly illustration doesn't swallow the screens next to it", () => {
    // Masking its illustration leaves only blank margin, which matches any
    // screen; tried first, it must not win over the real one.
    const one = batch(book.layout({ columns: 1 }), 0, 40);
    const draw1 = (p) => pixels(p, one.fonts);
    const i = one.pages.findIndex((p) => p.children.every((c) => c.type === "image"));
    const [only, after, before] = [one.pages[i], one.pages[i + 1], one.pages[i - 1]];
    for (const target of [after, before]) {
      const hit = R.identifyScreen(raster.readerPixels(target, one.fonts, 2), [only, target], draw1, 2);
      assert.equal(hit.page, target);
      assert.equal(hit.tried, 2);
    }
    // With nothing better, the illustration screen itself is still found.
    assert.equal(R.identifyScreen(raster.readerPixels(only, one.fonts, 2), [only], draw1, 2).page, only);
    assert.equal(R.identifyScreen(raster.readerPixels(only, one.fonts, 2), [only, after, before], draw1, 2).page, only);
  });

  test("maskedShare: the share the masks cover, overlaps once, clipped", () => {
    assert.equal(R.maskedShare([], 10, 10), 0);
    assert.equal(R.maskedShare([[0, 0, 5, 10]], 10, 10), 0.5);
    assert.equal(R.maskedShare([[0, 0, 5, 10], [3, 0, 8, 10]], 10, 10), 0.8);
    assert.equal(R.maskedShare([[-5, -5, 20, 20]], 10, 10), 1);
    assert.equal(R.maskedShare([[2, 2, 4, 4], [6, 6, 8, 8]], 10, 10), 0.08);
  });

  test("counts the candidates it compared, best guesses first", () => {
    const target = b.pages[4];
    const shot = raster.readerPixels(target, b.fonts, 2);
    assert.equal(R.identifyScreen(shot, [target, ...b.pages], draw, 2).tried, 1);
    assert.equal(R.identifyScreen(shot, b.pages, draw, 2).tried, 5);
  });

  test("candidates of another size aren't drawn at all", () => {
    let drawn = 0;
    const other = book.layout({ width: 320 });
    const ob = batch(other);
    const shot = raster.readerPixels(b.pages[0], b.fonts, 2);
    assert.equal(R.identifyScreen(shot, ob.pages, (p) => (drawn++, pixels(p, ob.fonts)), 2), null);
    assert.equal(drawn, 0);
  });

  test("a screen from another layout of the same size isn't taken for this one", () => {
    const other = batch(book.layout({ fontSize: 11 }), 0, 12);
    const shot = raster.readerPixels(b.pages[2], b.fonts, 2);
    assert.equal(R.identifyScreen(shot, other.pages, (p) => pixels(p, other.fonts), 2), null);
  });

  test("no candidate matches: null", () => {
    const shot = raster.readerPixels(b.pages[1], b.fonts, 2);
    assert.equal(R.identifyScreen(shot, [b.pages[0], b.pages[2]], draw, 2), null);
    assert.equal(R.identifyScreen(shot, [], draw, 2), null);
  });

  test("a few stray pixels (a cursor, a caret) still match", () => {
    const shot = raster.readerPixels(b.pages[3], b.fonts, 2);
    for (let i = 0; i < 40; i++) shot.data.set([255, 0, 0], (i * 3 + 1000) * 4);
    assert.equal(R.identifyScreen(shot, b.pages, draw, 2)?.page, b.pages[3]);
  });

  test("two screens that look alike resolve to the first listed", () => {
    const p = b.pages[0];
    const twin = { ...p, startPositionId: p.startPositionId + 999999 };
    const shot = raster.readerPixels(p, b.fonts, 2);
    assert.equal(R.identifyScreen(shot, [twin, p], draw, 2).page, twin);
  });

  test("screenAfter: the screen with the smallest start past the given one", () => {
    const pages = [{ startPositionId: 30 }, { startPositionId: 10 }, { startPositionId: 20 }];
    assert.equal(R.screenAfter(pages, 10).startPositionId, 20);
    assert.equal(R.screenAfter(pages, 15).startPositionId, 20);
    assert.equal(R.screenAfter(pages, 30), null);
    assert.equal(R.screenAfter([], 0), null);
  });
});

// ---- splitting a translation between columns ----

test.describe("splitText", () => {
  test("one weight: the whole text", () => {
    assert.deepEqual(R.splitText("全部的文字", [3]), ["全部的文字"]);
  });

  test("splits by the weights, at punctuation near the share", () => {
    const text = "第一句話在這裡，第二句話也在這裡。第三句。";
    const [a, b] = R.splitText(text, [1, 1]);
    assert.equal(a + b, text);
    assert.match(a, /[，。]$/);
    assert.ok(Math.abs([...a].length - [...text].length / 2) <= 8);
  });

  test("uneven weights give uneven parts", () => {
    const text = "一二三四五六七八九十".repeat(6);
    const [a, b] = R.splitText(text, [5, 1]);
    assert.equal(a + b, text);
    assert.equal([...a].length, 50);
  });

  test("English splits at a space and loses it", () => {
    const [a, b] = R.splitText("one two three four five six", [1, 1]);
    assert.equal(`${a} ${b}`, "one two three four five six");
  });

  test("three parts, and parts never run backwards", () => {
    const parts = R.splitText("甲乙丙丁戊己庚辛壬癸", [1, 1, 1]);
    assert.equal(parts.length, 3);
    assert.equal(parts.join(""), "甲乙丙丁戊己庚辛壬癸");
  });

  test("zero weights or no text", () => {
    assert.deepEqual(R.splitText("文字", [0, 0]), ["文字", ""]);
    assert.deepEqual(R.splitText("", [1, 1]), ["", ""]);
  });

  test("characters outside the BMP aren't cut in half", () => {
    const text = "𠀀𠀁𠀂𠀃";
    const parts = R.splitText(text, [1, 1]);
    assert.equal(parts.join(""), text);
    assert.deepEqual(
      parts.map((p) => [...p].length),
      [2, 2]
    );
  });
});
