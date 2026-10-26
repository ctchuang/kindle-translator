// page-sig.js: the coarse page fingerprint that decides "same page or not"
// everywhere (cache lookups, overlay checks, page-turn detection). The pages
// here are synthetic: rows of word-like ink rectangles from a seeded PRNG, at
// the SIG_WIDTH the service worker shrinks the text area to.

const test = require("node:test");
const assert = require("node:assert/strict");
const { SIG_WIDTH, pageSignature, pageDiff, samePage } = require("../page-sig.js");

const HEIGHT = 320;

// mulberry32: small, seedable, good enough for layout noise.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blank(bg = 245, width = SIG_WIDTH, height = HEIGHT) {
  return { width, height, data: new Uint8Array(width * height).fill(bg) };
}

function fillRect(img, x0, y0, x1, y1, v) {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) img.data[y * img.width + x] = v;
}

// A text page: lines of words between margins, like a Kindle page at 240 px.
// A margin band at the top stays empty for the toolbar tests.
function textPage(seed, { bg = 245, ink = 40, width = SIG_WIDTH, height = HEIGHT } = {}) {
  const rnd = prng(seed);
  const img = blank(bg, width, height);
  for (let y = 16; y + 6 <= height - 8; y += 10) {
    let x = 12 + (rnd() < 0.15 ? 8 : 0); // some first-line indents
    for (;;) {
      const w = 4 + Math.floor(rnd() * 22);
      if (x + w > width - 12) break;
      // Ascenders / descenders: words aren't all the same height.
      const top = y + (rnd() < 0.3 ? 0 : 1);
      const bottom = y + 5 + (rnd() < 0.2 ? 1 : 0);
      fillRect(img, x, top, x + w, bottom, ink);
      x += w + 3 + Math.floor(rnd() * 2);
    }
  }
  return img;
}

function copy(img) {
  return { ...img, data: Uint8Array.from(img.data) };
}

function inkCount(sig) {
  let n = 0;
  for (const ch of atob(sig.split(":")[1])) for (let v = ch.charCodeAt(0); v; v &= v - 1) n++;
  return n;
}

test("signature is \"WxH:base64\" with one bit per pixel, LSB first", () => {
  const sig = pageSignature(textPage(1));
  assert.match(sig, new RegExp(`^${SIG_WIDTH}x${HEIGHT}:[A-Za-z0-9+/]+=*$`));
  assert.equal(atob(sig.split(":")[1]).length, Math.ceil((SIG_WIDTH * HEIGHT) / 8));

  // 8x2 image, ink at pixel 0 and pixel 9: byte 0 = bit 0, byte 1 = bit 1.
  const tiny = blank(250, 8, 2);
  tiny.data[0] = 0;
  tiny.data[9] = 0;
  assert.equal(pageSignature(tiny), `8x2:${btoa(String.fromCharCode(1, 2))}`);
});

test("ink is a luminance difference over 28 from the background", () => {
  const img = blank(200, 8, 1);
  img.data[0] = 172; // exactly 28 darker: not ink
  img.data[1] = 171; // 29 darker: ink
  img.data[2] = 229; // 29 lighter: ink too, the test is |v - bg|
  assert.equal(pageSignature(img), `8x1:${btoa(String.fromCharCode(0b110))}`);
});

test("identical pages: diff 0 and samePage", () => {
  const a = pageSignature(textPage(7));
  const b = pageSignature(textPage(7));
  assert.equal(a, b);
  assert.equal(pageDiff(a, b), 0);
  assert.ok(samePage(a, b));
  // Sanity: the page really has a lot of ink, so the ratios below mean something.
  assert.ok(inkCount(a) > 5000, `ink ${inkCount(a)}`);
});

test("same page with a few specks is still the same page", () => {
  const page = textPage(11);
  const noisy = copy(page);
  const rnd = prng(99);
  for (let i = 0; i < 30; i++) noisy.data[Math.floor(rnd() * noisy.data.length)] = 0;
  const d = pageDiff(pageSignature(page), pageSignature(noisy));
  assert.ok(d > 0 && d < 0.01, `diff ${d}`);
  assert.ok(samePage(pageSignature(page), pageSignature(noisy)));
});

test("same page with a toolbar band changed (progress slider line) is the same page", () => {
  const page = textPage(12);
  const withBar = copy(page);
  // The reader's slider: a 2 px line across most of the top margin band.
  fillRect(withBar, 20, 4, 220, 6, 90);
  const d = pageDiff(pageSignature(page), pageSignature(withBar));
  assert.ok(d > 0 && d < 0.08, `diff ${d}`);
  assert.ok(samePage(pageSignature(page), pageSignature(withBar)));
});

test("same page re-captured with JPEG-like ±10 luminance noise gives the same signature", () => {
  const page = textPage(13);
  const jpeg = copy(page);
  const rnd = prng(5);
  for (let i = 0; i < jpeg.data.length; i++) jpeg.data[i] = Math.max(0, Math.min(255, jpeg.data[i] + Math.round(rnd() * 20 - 10)));
  const a = pageSignature(page);
  const b = pageSignature(jpeg);
  // The median background moves by a level or two at most, and ink is 200
  // levels away, so no pixel flips.
  assert.equal(pageDiff(a, b), 0);
  assert.ok(samePage(a, b));
});

test("different pages are not the same page, by a wide margin", () => {
  const sigs = [21, 22, 23, 24].map((s) => pageSignature(textPage(s)));
  for (let i = 0; i < sigs.length; i++)
    for (let j = i + 1; j < sigs.length; j++) {
      const d = pageDiff(sigs[i], sigs[j]);
      // Several times the 8% threshold, not just over it.
      assert.ok(d > 0.4, `pages ${i}/${j} diff ${d}`);
      assert.equal(samePage(sigs[i], sigs[j]), false);
    }
});

test("missing or differently sized signatures can't be compared: diff 1", () => {
  const a = pageSignature(textPage(31));
  for (const missing of [null, undefined, ""]) {
    assert.equal(pageDiff(a, missing), 1);
    assert.equal(pageDiff(missing, a), 1);
    assert.equal(samePage(a, missing), false);
  }
  const taller = pageSignature(textPage(31, { height: HEIGHT + 10 }));
  assert.equal(pageDiff(a, taller), 1);
  const wider = pageSignature(textPage(31, { width: SIG_WIDTH + 8 }));
  assert.equal(pageDiff(a, wider), 1);
  assert.equal(samePage(a, taller), false);
});

test("near-blank pages are measured against a 200-pixel floor", () => {
  const empty = pageSignature(blank());
  const specks = blank();
  for (let i = 0; i < 12; i++) specks.data[1000 + i * 37] = 0;
  const s = pageSignature(specks);
  // 12 differing pixels over max(0, 12, 200): a few specks on an empty page
  // aren't a new page (without the floor this would be 12/12 = 100%).
  assert.equal(pageDiff(empty, s), 12 / 200);
  assert.ok(samePage(empty, s));
  assert.equal(pageDiff(empty, empty), 0);
});

test("dark theme (light ink on a dark background) works through the median background", () => {
  const light = textPage(41);
  const dark = textPage(41, { bg: 20, ink: 225 });
  const a = pageSignature(light);
  const b = pageSignature(dark);
  // Ink is "differs from the background", so both themes give the same bits.
  assert.equal(a, b);
  assert.ok(inkCount(b) > 5000);
  assert.equal(samePage(pageSignature(dark), pageSignature(textPage(42, { bg: 20, ink: 225 }))), false);
});

test("threshold: 8% of the ink differing is the same page, just over is not", () => {
  // Exactly 1000 ink pixels in a 40x25 block.
  const page = blank();
  fillRect(page, 50, 50, 90, 75, 30);
  const base = pageSignature(page);
  assert.equal(inkCount(base), 1000);

  // Erasing k ink pixels: diff k, ink max(1000, 1000 - k) = 1000.
  const erase = (k) => {
    const img = copy(page);
    for (let i = 0; i < k; i++) img.data[(50 + Math.floor(i / 40)) * SIG_WIDTH + 50 + (i % 40)] = 245;
    return pageSignature(img);
  };
  assert.equal(pageDiff(base, erase(80)), 0.08);
  assert.ok(samePage(base, erase(80)));
  assert.ok(samePage(base, erase(79)));
  assert.equal(pageDiff(base, erase(81)), 0.081);
  assert.equal(samePage(base, erase(81)), false);
});
