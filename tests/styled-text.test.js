// styled-text.js: text with style marks (<i>, <b>, <h1>…) as sent to and
// returned by Claude, and splitting a translation between columns.

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../styled-text.js");

const w = (text, ...styles) => ({ text, styles });

test.describe("tagWords", () => {
  test("plain words are just joined", () => {
    assert.equal(S.tagWords([w("a"), w("plain"), w("line")]), "a plain line");
    assert.equal(S.tagWords([]), "");
  });

  test("a run of words with one style shares a pair of marks, spaces inside", () => {
    assert.equal(S.tagWords([w("read"), w("Build", "i"), w("a", "i"), w("Model", "i"), w("first")]), "read <i>Build a Model</i> first");
  });

  test("marks nest outermost first: highlights, bold, italics", () => {
    assert.equal(S.tagWords([w("x", "i", "b", "h1")]), "<h1><b><i>x</i></b></h1>");
    assert.deepEqual(S.sortStyles(["i", "h2", "b", "h1", "i"]), ["h1", "h2", "b", "i"]);
  });

  test("an inner style changes inside an outer one without reopening it", () => {
    assert.equal(S.tagWords([w("one", "h1"), w("two", "h1", "i"), w("three", "h1")]), "<h1>one <i>two</i> three</h1>");
  });

  test("an outer style ending closes the inner ones and reopens what goes on", () => {
    assert.equal(S.tagWords([w("a", "h1", "i"), w("b", "i")]), "<h1><i>a</i></h1> <i>b</i>");
  });

  test("the result always parses back to the same words and styles", () => {
    const words = [w("a"), w("b", "i"), w("c", "b", "i"), w("d", "h1"), w("e", "h1", "b"), w("f"), w("g", "h2", "i")];
    const segments = S.parseMarked(S.tagWords(words));
    const back = segments.flatMap((s) => s.text.split(" ").filter(Boolean).map((t) => [t, s.styles.join()]));
    assert.deepEqual(
      back,
      words.map((x) => [x.text, S.sortStyles(x.styles).join()])
    );
  });
});

test.describe("parseMarked / markNames / stripMarks", () => {
  test("segments with the styles open at each point, outermost first", () => {
    assert.deepEqual(S.parseMarked("讀<i>建構推理模型</i>這本<h1>書<b>很</b>好</h1>。"), [
      { text: "讀", styles: [] },
      { text: "建構推理模型", styles: ["i"] },
      { text: "這本", styles: [] },
      { text: "書", styles: ["h1"] },
      { text: "很", styles: ["h1", "b"] },
      { text: "好", styles: ["h1"] },
      { text: "。", styles: [] },
    ]);
  });

  test("plain text is one segment; empty text none", () => {
    assert.deepEqual(S.parseMarked("純文字"), [{ text: "純文字", styles: [] }]);
    assert.deepEqual(S.parseMarked(""), []);
    assert.deepEqual(S.parseMarked("<i></i>"), []);
  });

  test("unpaired or crossed marks don't parse", () => {
    for (const bad of ["<i>open", "close</i>", "<i><b>x</i></b>", "<h1>x</h2>", "</i>x<i>"]) assert.equal(S.parseMarked(bad), null, bad);
  });

  test("anything that isn't one of our marks is plain text", () => {
    assert.deepEqual(S.parseMarked("a <em>b</em> 1 < 2 <h10>x</h10>"), [
      { text: "a <em>b</em> 1 < 2 ", styles: [] },
      { text: "x", styles: ["h10"] },
    ]);
    assert.deepEqual(S.parseMarked("<think>"), [{ text: "<think>", styles: [] }]);
  });

  test("markNames and stripMarks", () => {
    assert.deepEqual([...S.markNames("<h2>a</h2><i>b</i><i>c</i>")].sort(), ["h2", "i"]);
    assert.equal(S.hasMarks("plain"), false);
    assert.equal(S.hasMarks("<b>x</b>"), true);
    assert.equal(S.stripMarks("<h1>a <i>b</i></h1> c<b>"), "a b c");
  });
});

test.describe("checkMarks", () => {
  const source = "a <i>title</i> and a <h1>note</h1>";

  test("a translation keeping the source's marks is kept as it is", () => {
    assert.deepEqual(S.checkMarks("一本<i>書</i>和<h1>筆記</h1>", source), { text: "一本<i>書</i>和<h1>筆記</h1>", ok: true });
    assert.deepEqual(S.checkMarks("一本書和筆記", source), { text: "一本書和筆記", ok: true }, "dropping marks is allowed");
  });

  test("unpaired, crossed, or invented marks: the words without marks", () => {
    assert.deepEqual(S.checkMarks("一本<i>書和筆記", source), { text: "一本書和筆記", ok: false });
    assert.deepEqual(S.checkMarks("<i>一<h1>本</i>書</h1>", source), { text: "一本書", ok: false });
    assert.deepEqual(S.checkMarks("<b>一本書</b>", source), { text: "一本書", ok: false });
    assert.deepEqual(S.checkMarks("<h2>一本書</h2>", source), { text: "一本書", ok: false });
  });

  test("a translation without marks is fine whatever the source", () => {
    assert.deepEqual(S.checkMarks("純文字", "plain"), { text: "純文字", ok: true });
  });
});

test.describe("splitText", () => {
  test("one weight: the whole text", () => {
    assert.deepEqual(S.splitText("全部的文字", [3]), ["全部的文字"]);
  });

  test("splits by the weights, at punctuation near the share", () => {
    const text = "第一句話在這裡，第二句話也在這裡。第三句。";
    const [a, b] = S.splitText(text, [1, 1]);
    assert.equal(a + b, text);
    assert.match(a, /[，。]$/);
    assert.ok(Math.abs([...a].length - [...text].length / 2) <= 8);
  });

  test("uneven weights give uneven parts", () => {
    const text = "一二三四五六七八九十".repeat(6);
    const [a, b] = S.splitText(text, [5, 1]);
    assert.equal(a + b, text);
    assert.equal([...a].length, 50);
  });

  test("English splits at a space and loses it", () => {
    const [a, b] = S.splitText("one two three four five six", [1, 1]);
    assert.equal(`${a} ${b}`, "one two three four five six");
  });

  test("three parts, and parts never run backwards", () => {
    const parts = S.splitText("甲乙丙丁戊己庚辛壬癸", [1, 1, 1]);
    assert.equal(parts.length, 3);
    assert.equal(parts.join(""), "甲乙丙丁戊己庚辛壬癸");
  });

  test("zero weights or no text", () => {
    assert.deepEqual(S.splitText("文字", [0, 0]), ["文字", ""]);
    assert.deepEqual(S.splitText("", [1, 1]), ["", ""]);
  });

  test("characters outside the BMP aren't cut in half", () => {
    const text = "𠀀𠀁𠀂𠀃";
    const parts = S.splitText(text, [1, 1]);
    assert.equal(parts.join(""), text);
    assert.deepEqual(
      parts.map((p) => [...p].length),
      [2, 2]
    );
  });
});

test.describe("splitMarked", () => {
  const join = (parts) => parts.map((p) => p.map((s) => s.text).join(""));

  test("one part: the parsed segments", () => {
    assert.deepEqual(S.splitMarked("a<i>b</i>", [1]), [
      [
        { text: "a", styles: [] },
        { text: "b", styles: ["i"] },
      ],
    ]);
  });

  test("cuts where the plain text would, the text unchanged", () => {
    const text = "第一句話在這裡，<i>第二句話</i>也在這裡。第三句。";
    const parts = S.splitMarked(text, [1, 1]);
    assert.deepEqual(join(parts), S.splitText(S.stripMarks(text), [1, 1]));
  });

  test("a mark across the cut carries into both parts", () => {
    const text = `一二三四五<h1>六七八九十${"甲".repeat(10)}</h1>`;
    const [a, b] = S.splitMarked(text, [1, 1]);
    assert.deepEqual(a.at(-1).styles, ["h1"]);
    assert.deepEqual(b[0].styles, ["h1"]);
    assert.equal(join([a, b]).join(""), S.stripMarks(text));
  });

  test("spaces at the cut are dropped, and neighbours of one style merge", () => {
    const [a, b] = S.splitMarked("one <i>two</i> three four five six", [1, 1]);
    assert.ok(!/\s$/.test(join([a])[0]) && !/^\s/.test(join([b])[0]));
    assert.ok(a.every((s, i) => i === 0 || s.styles.join() !== a[i - 1].styles.join()));
  });

  test("broken marks are split as plain text", () => {
    const parts = S.splitMarked("<i>未關閉的標記", [1]);
    assert.deepEqual(parts, [[{ text: "未關閉的標記", styles: [] }]]);
  });

  test("zero weights: everything in the first part", () => {
    assert.deepEqual(join(S.splitMarked("<b>粗</b>體", [0, 0])), ["粗體", ""]);
  });
});
