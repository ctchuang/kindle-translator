// ocr-layout.js: putting Tesseract's lines and words into the paragraphs the
// reader's page data describes, with each word's styles.

const test = require("node:test");
const assert = require("node:assert/strict");
const { PARA_PAD, assignWords, wordsText, wordsOf, stylesAt, isText } = require("../ocr-layout.js");

const line = (text, x0, y0, x1, y1, confidence = 92, words) => ({ text, x0, y0, x1, y1, confidence, ...(words && { words }) });
const para = (...boxes) => ({ boxes: boxes.map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 })) });
const texts = (lines, paras) => assignWords(lines, paras).map(wordsText);

test("each line goes to the paragraph covering it, joined top to bottom", () => {
  const paras = [para([10, 10, 140, 50]), para([10, 60, 140, 100])];
  const lines = [line("second para", 10, 62, 120, 75), line("first line", 10, 12, 130, 25), line("second line", 10, 30, 100, 45)];
  assert.deepEqual(texts(lines, paras), ["first line second line", "second para"]);
});

test("a paragraph with two boxes reads the first box, then the second", () => {
  const paras = [para([10, 150, 140, 190], [160, 10, 290, 30])];
  const lines = [line("top of right", 160, 12, 280, 28), line("end of left", 10, 170, 130, 185)];
  assert.deepEqual(texts(lines, paras), ["end of left top of right"]);
});

test("a line goes to the paragraph covering most of it", () => {
  const paras = [para([0, 0, 100, 20]), para([0, 18, 100, 40])];
  assert.deepEqual(texts([line("mostly lower", 5, 16, 95, 34)], paras), ["", "mostly lower"]);
});

test("a line half or less inside any paragraph is dropped", () => {
  const paras = [para([0, 0, 100, 20])];
  assert.deepEqual(texts([line("half out", 50 + PARA_PAD, 2, 150 + PARA_PAD, 18)], paras), [""]);
  assert.deepEqual(texts([line("far away", 200, 200, 300, 220)], paras), [""]);
});

test("boxes get a little slack: a line poking out by a few pixels still counts", () => {
  assert.deepEqual(texts([line("slightly bigger", 7, 7, 103, 23)], [para([10, 10, 100, 20])]), ["slightly bigger"]);
});

test("noise lines are dropped before assigning", () => {
  const lines = [line("— — —", 0, 0, 100, 10), line("real text", 0, 20, 100, 30), line("x", 0, 40, 10, 50, 60), line("blurry words", 0, 60, 100, 70, 30)];
  assert.deepEqual(texts(lines, [para([0, 0, 200, 100])]), ["real text"]);
});

test("a word hyphenated across lines is one word again, but not before a capital", () => {
  const paras = [para([0, 0, 200, 100])];
  assert.deepEqual(texts([line("night at the disco-", 0, 0, 100, 10), line("theque was fun", 0, 15, 100, 25)], paras), ["night at the discotheque was fun"]);
  assert.deepEqual(texts([line("the Anglo-", 0, 0, 100, 10), line("Saxon king", 0, 15, 100, 25)], paras), ["the Anglo- Saxon king"]);
});

test("no lines, or no paragraphs", () => {
  assert.deepEqual(assignWords([], [para([0, 0, 1, 1])]), [[]]);
  assert.deepEqual(assignWords([line("text", 0, 0, 1, 1)], []), []);
});

test("a zero-size line doesn't divide by zero", () => {
  assert.deepEqual(texts([line("dot dot", 5, 5, 5, 5)], [para([0, 0, 10, 10])]), [""]);
});

// ---- words ----

test("Tesseract's words come with their boxes, trimmed, empty ones dropped", () => {
  const words = [
    { text: "Hello ", x0: 0, y0: 0, x1: 40, y1: 10 },
    { text: " ", x0: 41, y0: 0, x1: 42, y1: 10 },
    { text: "world", x0: 45, y0: 0, x1: 90, y1: 10 },
  ];
  assert.deepEqual(wordsOf(line("Hello world", 0, 0, 90, 10, 92, words)), [
    { text: "Hello", x0: 0, y0: 0, x1: 40, y1: 10 },
    { text: "world", x0: 45, y0: 0, x1: 90, y1: 10 },
  ]);
});

test("without word boxes, the line's text is spread over it by length", () => {
  const w = wordsOf(line("ab  cdef", 0, 0, 70, 10));
  assert.deepEqual(
    w.map((x) => x.text),
    ["ab", "cdef"]
  );
  // 7 characters with the space: ab 0–20, cdef 30–70.
  assert.deepEqual(
    w.map((x) => [x.x0, x.x1].map(Math.round)),
    [
      [0, 20],
      [30, 70],
    ]
  );
  assert.deepEqual(wordsOf(line("", 0, 0, 10, 10)), []);
});

test("a word takes the styles of the style boxes its centre is in", () => {
  const boxes = [
    { styles: ["i"], x0: 40, y0: 0, x1: 80, y1: 12 },
    { styles: ["b"], x0: 60, y0: 0, x1: 120, y1: 12 },
  ];
  assert.deepEqual(stylesAt({ x0: 0, y0: 0, x1: 30, y1: 10 }, boxes), []);
  assert.deepEqual(stylesAt({ x0: 42, y0: 0, x1: 58, y1: 10 }, boxes), ["i"]);
  assert.deepEqual(stylesAt({ x0: 62, y0: 0, x1: 78, y1: 10 }, boxes).sort(), ["b", "i"]);
  // Two pixels of slack around a box.
  assert.deepEqual(stylesAt({ x0: 76, y0: 0, x1: 84, y1: 10 }, [boxes[0]]), ["i"]);
  assert.deepEqual(stylesAt({ x0: 80, y0: 0, x1: 90, y1: 10 }, [boxes[0]]), []);
});

test("paragraph words carry the styles of the paragraph's style boxes", () => {
  const p = { ...para([0, 0, 200, 40]), styleBoxes: [{ styles: ["i"], x0: 50, y0: 0, x1: 100, y1: 15 }] };
  const words = [
    { text: "a", x0: 0, y0: 0, x1: 40, y1: 10 },
    { text: "book", x0: 55, y0: 0, x1: 95, y1: 10 },
    { text: "title", x0: 105, y0: 0, x1: 150, y1: 10 },
  ];
  const [got] = assignWords([line("a book title", 0, 0, 150, 10, 92, words)], [p]);
  assert.deepEqual(
    got.map((w) => [w.text, w.styles]),
    [
      ["a", []],
      ["book", ["i"]],
      ["title", []],
    ]
  );
});

test("a paragraph without style boxes has plain words", () => {
  const [got] = assignWords([line("plain words", 0, 0, 100, 10)], [para([0, 0, 100, 20])]);
  assert.ok(got.every((w) => w.styles.length === 0));
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

test("wordsText joins words with spaces", () => {
  assert.equal(wordsText([{ text: "one" }, { text: "two" }]), "one two");
  assert.equal(wordsText([]), "");
});
