// ocr-layout.js: putting Tesseract's lines into the paragraphs the reader's
// page data describes.

const test = require("node:test");
const assert = require("node:assert/strict");
const { PARA_PAD, assignLines, isText, joinLines } = require("../ocr-layout.js");

const line = (text, x0, y0, x1, y1, confidence = 92) => ({ text, x0, y0, x1, y1, confidence });
const para = (...boxes) => ({ boxes: boxes.map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 })) });

test("each line goes to the paragraph covering it, joined top to bottom", () => {
  const paras = [para([10, 10, 140, 50]), para([10, 60, 140, 100])];
  const lines = [line("second para", 10, 62, 120, 75), line("first line", 10, 12, 130, 25), line("second line", 10, 30, 100, 45)];
  assert.deepEqual(assignLines(lines, paras), ["first line second line", "second para"]);
});

test("a paragraph with two boxes reads the first box, then the second", () => {
  const paras = [para([10, 150, 140, 190], [160, 10, 290, 30])];
  const lines = [line("top of right", 160, 12, 280, 28), line("end of left", 10, 170, 130, 185)];
  assert.deepEqual(assignLines(lines, paras), ["end of left top of right"]);
});

test("a line goes to the paragraph covering most of it", () => {
  const paras = [para([0, 0, 100, 20]), para([0, 18, 100, 40])];
  assert.deepEqual(assignLines([line("mostly lower", 5, 16, 95, 34)], paras), ["", "mostly lower"]);
});

test("a line half or less inside any paragraph is dropped", () => {
  const paras = [para([0, 0, 100, 20])];
  assert.deepEqual(assignLines([line("half out", 50 + PARA_PAD, 2, 150 + PARA_PAD, 18)], paras), [""]);
  assert.deepEqual(assignLines([line("far away", 200, 200, 300, 220)], paras), [""]);
});

test("boxes get a little slack: a line poking out by a few pixels still counts", () => {
  const paras = [para([10, 10, 100, 20])];
  assert.deepEqual(assignLines([line("slightly bigger", 7, 7, 103, 23)], paras), ["slightly bigger"]);
});

test("noise lines are dropped before assigning", () => {
  const paras = [para([0, 0, 200, 100])];
  const lines = [line("— — —", 0, 0, 100, 10), line("real text", 0, 20, 100, 30), line("x", 0, 40, 10, 50, 60), line("blurry words", 0, 60, 100, 70, 30)];
  assert.deepEqual(assignLines(lines, paras), ["real text"]);
});

test("hyphenated line ends are joined", () => {
  const paras = [para([0, 0, 200, 100])];
  assert.deepEqual(assignLines([line("disco-", 0, 0, 100, 10), line("theque night", 0, 15, 100, 25)], paras), ["discotheque night"]);
});

test("no lines, or no paragraphs", () => {
  assert.deepEqual(assignLines([], [para([0, 0, 1, 1])]), [""]);
  assert.deepEqual(assignLines([line("text", 0, 0, 1, 1)], []), []);
});

test("a zero-size line doesn't divide by zero", () => {
  assert.deepEqual(assignLines([line("dot dot", 5, 5, 5, 5)], [para([0, 0, 10, 10])]), [""]);
});

test("isText: letters or digits, confident enough", () => {
  assert.equal(isText(line("Hello", 0, 0, 1, 1)), true);
  assert.equal(isText(line("42", 0, 0, 1, 1)), true);
  assert.equal(isText(line("…—", 0, 0, 1, 1)), false);
  assert.equal(isText(line("Hello", 0, 0, 1, 1, 39)), false);
  assert.equal(isText(line("a", 0, 0, 1, 1, 79)), false, "one letter needs high confidence");
  assert.equal(isText(line("a", 0, 0, 1, 1, 85)), true);
  assert.equal(isText({ confidence: 90 }), false, "no text at all");
});

test("joinLines: spaces between lines, hyphenation undone only before lowercase", () => {
  assert.equal(joinLines(["one", "two"]), "one two");
  assert.equal(joinLines(["re-", "turn"]), "return");
  assert.equal(joinLines(["Anglo-", "Saxon"]), "Anglo- Saxon");
  assert.equal(joinLines(["x", "", "y"]), "x y");
  assert.equal(joinLines([]), "");
});
