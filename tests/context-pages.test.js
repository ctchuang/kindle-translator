// context-pages.js: which earlier paragraphs of a book go with a review.

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../context-pages.js");

const DAY = 24 * 3600 * 1000;

// Paragraph i covers positions i*100 … i*100+99 and costs about `tokens`.
function para(i, { tokens = 100, savedAt = 0 } = {}) {
  const words = "x".repeat(Math.round((tokens - 8) * 3.5));
  return { start: i * 100, end: i * 100 + 99, source: words, text: "", savedAt };
}
const range = (from, to, opts) => Array.from({ length: to - from }, (_, k) => para(from + k, opts));
const starts = (list) => list.map((p) => p.start / 100);

test.describe("estimateTokens", () => {
  test("a CJK character is a token, other text about 3.5 characters", () => {
    assert.equal(C.estimateTokens("愛麗絲"), 3);
    assert.equal(C.estimateTokens("Alice was"), 3);
    assert.equal(C.estimateTokens("「愛麗絲」said"), 7);
    assert.equal(C.estimateTokens(""), 0);
    assert.equal(C.estimateTokens(undefined), 0);
  });

  test("the test paragraphs cost what they say", () => {
    assert.equal(C.paraTokens(para(0, { tokens: 100 })), 100);
  });
});

test.describe("mergeParas", () => {
  test("adds in position order", () => {
    const out = C.mergeParas([para(1), para(5)], [para(3)], 0);
    assert.deepEqual(starts(out), [1, 3, 5]);
  });

  test("a paragraph overlapping a new one is replaced", () => {
    const cut = { start: 300, end: 340, source: "cut", text: "切", savedAt: 0 };
    const whole = { start: 300, end: 399, source: "whole", text: "整段" };
    const out = C.mergeParas([para(2), cut], [whole], 10);
    assert.deepEqual(out.map((p) => p.source), [para(2).source, "whole"]);
    assert.equal(out[1].savedAt, 10);
  });

  test("drops paragraphs older than a week", () => {
    const out = C.mergeParas([para(1, { savedAt: 0 }), para(2, { savedAt: DAY })], [para(3)], 7 * DAY + DAY / 2);
    assert.deepEqual(starts(out), [2, 3]);
  });

  test("keeps the newest past the per-book limit", () => {
    const stored = range(0, C.REF_MAX_PARAS).map((p, i) => ({ ...p, savedAt: i }));
    const out = C.mergeParas(stored, [para(C.REF_MAX_PARAS)], C.REF_MAX_PARAS);
    assert.equal(out.length, C.REF_MAX_PARAS);
    assert.equal(starts(out)[0], 1, "the oldest saved went");
  });
});

test.describe("pickReference", () => {
  test("nothing before the page: nothing to send", () => {
    const out = C.pickReference(range(5, 10), 500, null, 1000);
    assert.deepEqual(out.paras, []);
    assert.equal(out.refStart, null);
  });

  test("only paragraphs that end before the page", () => {
    const out = C.pickReference(range(0, 10), 450, null, 10_000);
    assert.deepEqual(starts(out.paras), [0, 1, 2, 3]);
  });

  test("a new set takes the nearest paragraphs up to half the limit", () => {
    const out = C.pickReference(range(0, 20), 2000, null, 1000);
    assert.deepEqual(starts(out.paras), [15, 16, 17, 18, 19]);
    assert.equal(out.refStart, 1500);
    assert.equal(out.tokens, 500);
    assert.equal(out.reset, true);
  });

  test("reading on, the set keeps its start and grows", () => {
    const paras = range(0, 30);
    let pick = C.pickReference(paras, 2000, null, 1000);
    const first = pick.refStart;
    pick = C.pickReference(paras, 2100, pick.refStart, 1000);
    assert.equal(pick.refStart, first);
    assert.deepEqual(starts(pick.paras), [15, 16, 17, 18, 19, 20]);
    assert.equal(pick.reset || pick.trimmed, false);
  });

  test("past the limit the oldest half goes at once", () => {
    const pick = C.pickReference(range(0, 30), 2600, 1500, 1000);
    assert.equal(pick.trimmed, true);
    assert.deepEqual(starts(pick.paras), [21, 22, 23, 24, 25]);
    assert.equal(pick.refStart, 2100);
    // …and then grows again from there.
    const next = C.pickReference(range(0, 30), 2700, pick.refStart, 1000);
    assert.deepEqual(starts(next.paras), [21, 22, 23, 24, 25, 26]);
  });

  test("going back before the set starts a new one", () => {
    const pick = C.pickReference(range(0, 30), 800, 1500, 1000);
    assert.equal(pick.reset, true);
    assert.deepEqual(starts(pick.paras), [3, 4, 5, 6, 7]);
  });

  test("going back inside the set leaves out what comes after the page", () => {
    const pick = C.pickReference(range(0, 30), 1800, 1500, 1000);
    assert.equal(pick.refStart, 1500);
    assert.deepEqual(starts(pick.paras), [15, 16, 17]);
  });

  test("skipped pages leave a gap, not a reset", () => {
    const paras = [...range(10, 13), ...range(40, 42)];
    const pick = C.pickReference(paras, 4300, 1000, 1000);
    assert.deepEqual(starts(pick.paras), [10, 11, 12, 40, 41]);
  });

  test("a paragraph bigger than half the limit is left out", () => {
    const pick = C.pickReference([para(0, { tokens: 900 })], 200, null, 1000);
    assert.deepEqual(pick.paras, []);
  });
});

test.describe("referenceBlocks", () => {
  test("one paragraph per line, as JSON", () => {
    const [block] = C.referenceBlocks([{ source: "Alice", text: "愛麗絲" }, { source: "Rabbit", text: "兔子" }]);
    assert.deepEqual(block.text.split("\n").map((l) => JSON.parse(l)), [
      { source: "Alice", text: "愛麗絲" },
      { source: "Rabbit", text: "兔子" },
    ]);
    assert.equal(block.full, false);
  });

  test("blocks already full don't change as the set grows", () => {
    const before = C.referenceBlocks(range(0, 25, { tokens: 300 }));
    const after = C.referenceBlocks(range(0, 27, { tokens: 300 }));
    const full = before.filter((b) => b.full);
    assert.ok(full.length >= 2);
    assert.deepEqual(after.slice(0, full.length), full);
  });

  test("nothing gives no blocks", () => {
    assert.deepEqual(C.referenceBlocks([]), []);
  });
});
