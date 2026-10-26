// Real Kindle Cloud Reader screenshots (tests/fixtures, public-domain books),
// saved with the side panel's 存下截圖, run through background.js's own
// image code: fingerprint, OCR crop and columns, color sampling.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { plain } = require("./helpers/load");
const { startExtension } = require("./helpers/extension");
const { fixtureUrl, decodeJpeg } = require("./helpers/images");

const DIR = path.join(__dirname, "fixtures");
const FIXTURES = JSON.parse(fs.readFileSync(path.join(DIR, "fixtures.json"), "utf8"));
const byFile = (file) => FIXTURES.find((f) => f.file === file);

// The worker with an offscreen document that reads no text: enough for
// ocrPage to crop the screenshot and find its columns.
function worker() {
  const ext = startExtension({ panel: false });
  ext.ocr.handler = (msg) => ({ columns: msg.rects.map(() => []), layout: { regions: msg.rects.map(() => []), ms: 1 } });
  return ext;
}

const luma = (data, i) => (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
const lumaOf = (rgb) => {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return (r * 299 + g * 587 + b * 114) / 1000;
};

// Rows of the screenshot holding text, as [first, last] row runs, looking
// across the part of the width OCR reads, and that part (the crop).
function inkRuns(fx, ext) {
  const { width: w, height: h, data } = decodeJpeg(fs.readFileSync(path.join(DIR, fx.file)));
  const crop = plain(ext.ctx.ocrCrop(fx.geometry));
  const bgAt = (Math.round(h * 0.97) * w + Math.round(w * 0.5)) * 4;
  const bg = luma(data, bgAt);
  const runs = [];
  for (let y = 0; y < h; y++) {
    let ink = 0;
    for (let x = Math.round(w * crop.x0); x < w * crop.x1; x += 2) if (Math.abs(luma(data, (y * w + x) * 4) - bg) > 60) ink++;
    if (ink < 4) continue;
    const last = runs.at(-1);
    if (last && y - last[1] <= 2) last[1] = y;
    else runs.push([y, y]);
  }
  return { runs, h, crop };
}

test("fixtures.json describes exactly the screenshots in the folder", () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".jpg")).sort();
  assert.deepEqual(FIXTURES.map((f) => f.file).sort(), files);
  for (const f of FIXTURES) {
    assert.ok(["single", "spread"].includes(f.layout), f.file);
    assert.ok(["white", "sepia", "dark"].includes(f.theme), f.file);
    assert.equal(typeof f.columns, "number", f.file);
    assert.ok(f.geometry?.page && f.geometry.viewport, `${f.file}: where the book was drawn`);
    if (f.samePageAs) assert.ok(byFile(f.samePageAs), `${f.file}: ${f.samePageAs} exists`);
  }
});

for (const fx of FIXTURES) {
  test(`${fx.file}: OCR finds ${fx.columns} column(s)`, async () => {
    const ext = worker();
    const out = await ext.ctx.ocrPage(fixtureUrl(fx.file), ext.ctx.ocrCrop(fx.geometry));
    assert.equal(out.columns, fx.columns);
    const { rects } = ext.ocr.calls[0];
    assert.equal(rects.length, fx.columns);
    if (fx.columns === 2) {
      // The gutter is in the middle, and the columns don't overlap.
      const total = rects[1].left + rects[1].width;
      assert.ok(rects[0].left + rects[0].width < rects[1].left);
      const mid = (rects[0].left + rects[0].width + rects[1].left) / 2 / total;
      assert.ok(mid > 0.45 && mid < 0.55, `gutter at ${(mid * 100).toFixed(1)}%`);
    }
  });
}

test("the same screenshot fingerprints identically", async () => {
  const ext = worker();
  for (const fx of FIXTURES) {
    const url = fixtureUrl(fx.file);
    const a = await ext.ctx.pageSigOf(url, fx.geometry);
    const b = await ext.ctx.pageSigOf(url, fx.geometry);
    assert.equal(ext.ctx.pageDiff(a, b), 0, fx.file);
  }
});

test("the same page with the toolbar showing or not is the same page", async () => {
  // The toolbar, page arrows and progress slider are outside the page image.
  const ext = worker();
  const pairs = FIXTURES.filter((f) => f.samePageAs);
  assert.ok(pairs.length >= 1);
  for (const fx of pairs) {
    const other = byFile(fx.samePageAs);
    const a = await ext.ctx.pageSigOf(fixtureUrl(fx.file), fx.geometry);
    const b = await ext.ctx.pageSigOf(fixtureUrl(other.file), other.geometry);
    assert.ok(ext.ctx.samePage(a, b), `${fx.file} vs ${other.file}: ${ext.ctx.pageDiff(a, b)}`);
  }
});

test("different pages of a book are different screens", async () => {
  const ext = worker();
  const spreads = FIXTURES.filter((f) => f.file.startsWith("alice-") && f.layout === "spread" && !f.samePageAs);
  assert.ok(spreads.length >= 3);
  const sigs = await Promise.all(spreads.map((f) => ext.ctx.pageSigOf(fixtureUrl(f.file), f.geometry)));
  for (let i = 0; i < spreads.length; i++) {
    for (let j = i + 1; j < spreads.length; j++) {
      // Far from the threshold, even for neighbouring pages.
      assert.ok(ext.ctx.pageDiff(sigs[i], sigs[j]) > 0.5, `${spreads[i].file} vs ${spreads[j].file}: ${ext.ctx.pageDiff(sigs[i], sigs[j])}`);
    }
  }
});

test("the same page laid out as one column and as a spread are different screens", async () => {
  // Otherwise resizing the window would redraw the old layout's boxes.
  const ext = worker();
  const a = await ext.ctx.pageSigOf(fixtureUrl("pride-ch7-p33-single-sepia.jpg"), byFile("pride-ch7-p33-single-sepia.jpg").geometry);
  const b = await ext.ctx.pageSigOf(fixtureUrl("pride-ch7-p33-spread-white.jpg"), byFile("pride-ch7-p33-spread-white.jpg").geometry);
  assert.equal(ext.ctx.samePage(a, b), false);
  assert.ok(ext.ctx.pageDiff(a, b) > 0.5, `diff ${ext.ctx.pageDiff(a, b)}`);
});

test("a sepia page: warm background, dark brown ink", async () => {
  const ext = worker();
  const img = await ext.ctx.prepareImage(fixtureUrl("pride-ch7-p33-single-sepia.jpg"), false);
  const s = img.width / 2000; // the screenshot is 2000 CSS pixels wide
  // "The village of Longbourn…" paragraph.
  const [b] = plain(ext.ctx.finishBlocks([{ text: "x", x0: 218 * s, y0: 195 * s, x1: 1782 * s, y1: 282 * s }], img));
  const [r, g, bl] = b.bg.match(/\d+/g).map(Number);
  assert.ok(r > g && g > bl, `warm background ${b.bg}`);
  assert.ok(lumaOf(b.bg) > 200, b.bg);
  assert.ok(lumaOf(b.fg) < 110, b.fg);
});

test("a dark page: black background, light ink", async () => {
  const ext = worker();
  const fx = byFile("alice-ch1-loc91-single-dark.jpg");
  const img = await ext.ctx.prepareImage(fixtureUrl(fx.file), false);
  const s = img.width / fx.geometry.viewport.width;
  // The first paragraph, just below the top of the page image.
  const [b] = plain(ext.ctx.finishBlocks([{ text: "x", x0: 200 * s, y0: 80 * s, x1: 1290 * s, y1: 140 * s }], img));
  assert.ok(lumaOf(b.bg) < 40, b.bg);
  assert.ok(lumaOf(b.fg) > 150, b.fg);
});

test("a white page: white background, black ink", async () => {
  const ext = worker();
  const img = await ext.ctx.prepareImage(fixtureUrl("pride-ch7-p33-spread-white.jpg"), false);
  const s = img.width / 2000;
  // "The village of Longbourn…" on the left page.
  const [b] = plain(ext.ctx.finishBlocks([{ text: "x", x0: 218 * s, y0: 265 * s, x1: 982 * s, y1: 452 * s }], img));
  assert.ok(lumaOf(b.bg) > 245, b.bg);
  assert.ok(lumaOf(b.fg) < 40, b.fg);
});

test("the OCR crop leaves out the progress slider and the page number", () => {
  const ext = worker();
  for (const fx of FIXTURES) {
    const { runs, h, crop } = inkRuns(fx, ext);
    // The page number / location line (and the slider, when the toolbar
    // shows) are the last ink on the screen.
    const bottom = runs.filter(([a]) => a > h * 0.9);
    const ui = bottom.filter(([a]) => a > h * crop.y1);
    assert.ok(ui.length >= 1, `${fx.file}: footer found below the crop`);
    assert.ok(bottom.every(([a, b]) => b < h * crop.y1 || a > h * crop.y1), `${fx.file}: nothing straddles the bottom edge`);
  }
});

test("the OCR crop doesn't cut through the first or last line of text", () => {
  const ext = worker();
  for (const fx of FIXTURES) {
    const { runs, h, crop } = inkRuns(fx, ext);
    for (const edge of [h * crop.y0, h * crop.y1]) {
      const cut = runs.find(([a, b]) => a < edge && b > edge);
      assert.equal(cut, undefined, `${fx.file}: rows ${cut?.[0]}–${cut?.[1]} straddle the crop edge at row ${Math.round(edge)}`);
    }
    // Pride and Prejudice's chapter heading (from 5.0–5.4% of the height),
    // which the old fixed crop cut, is inside.
    if (fx.topLine) assert.ok(runs.some(([a]) => a > h * crop.y0 && a < h * 0.06), `${fx.file}: heading inside the crop`);
  }
});

test("the old fixed crop (6% from the top) cut through the heading", () => {
  // Why ocrCrop exists; the fallback still does this when the page can't
  // report where the book is drawn.
  const ext = worker();
  for (const fx of FIXTURES.filter((f) => f.topLine)) {
    const { runs, h } = inkRuns({ ...fx, geometry: null }, ext);
    const edge = h * ext.ctx.run("OCR_CROP.y0");
    assert.ok(runs.some(([a, b]) => a < edge && b > edge), fx.file);
  }
});
