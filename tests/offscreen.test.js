// offscreen.js: the offscreen document that runs Tesseract for the service
// worker. Loaded the way offscreen.html does, with Tesseract faked.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain } = require("./helpers/load");
const { createChrome } = require("./helpers/chrome");

const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

// A Tesseract line as recognize() reports it with { blocks: true }: one word
// the size of the line, unless `words` are given.
function tLine(text, bbox, confidence = 91, words = [{ text, bbox }]) {
  return { text, confidence, bbox, words };
}

// Tesseract.createWorker; `pages(rectangle, n)` gives recognize()'s data.
function fakeTesseract({ pages = () => ({ blocks: [] }), failCreate = 0 } = {}) {
  const T = {
    created: [],
    recognized: [],
    async createWorker(...args) {
      T.created.push(args);
      if (T.created.length <= failCreate) throw new Error("worker failed to load");
      return {
        async recognize(image, opts, output) {
          T.recognized.push({ image, opts, output });
          return { data: await pages(opts.rectangle, T.recognized.length) };
        },
      };
    },
  };
  return T;
}

function setup({ tesseract = fakeTesseract() } = {}) {
  const chrome = createChrome();
  chrome._.runtimeMessageHandler = () => undefined;
  const ctx = loadScripts(["offscreen.js"], { chrome, Tesseract: tesseract });
  // Send a message the way chrome.runtime.onMessage would, collecting the reply.
  const send = (msg) => {
    let reply;
    const done = new Promise((r) => (reply = r));
    const returned = chrome.runtime.onMessage.dispatch(msg, {}, (res) => reply(res));
    return { returned, done };
  };
  return { ctx, chrome, tesseract, send };
}

const RECTS = [
  { left: 0, top: 0, width: 1000, height: 1000 },
  { left: 1000, top: 0, width: 1000, height: 1000 },
];

test("offscreen.html loads Tesseract and the script, and nothing for a layout model", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "offscreen.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ["vendor/tesseract/tesseract.min.js", "offscreen.js"]);
});

test("messages not addressed to the offscreen document are ignored", async () => {
  const { send, tesseract } = setup();
  for (const msg of [{ type: "ocr", image: IMAGE, rects: RECTS }, { target: "background" }]) {
    const { returned } = send(msg);
    assert.deepEqual(returned, [undefined]); // not true: no async reply coming
  }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(tesseract.created.length, 0);
});

test("an OCR request answers asynchronously with each column's lines", async () => {
  const pages = (rect) => ({
    blocks: [
      {
        paragraphs: [
          { lines: [tLine(`first ${rect.left}`, { x0: rect.left + 10, y0: 20, x1: rect.left + 300, y1: 40 })] },
          { lines: [tLine("second", { x0: rect.left + 10, y0: 50, x1: rect.left + 200, y1: 70 }, 77)] },
        ],
      },
    ],
  });
  const { send, tesseract } = setup({ tesseract: fakeTesseract({ pages }) });
  const { returned, done } = send({ target: "offscreen", image: IMAGE, rects: RECTS });
  assert.deepEqual(returned, [true]);
  const res = plain(await done);
  assert.deepEqual(res, {
    columns: [
      [
        { x0: 10, y0: 20, x1: 300, y1: 40, text: "first 0", confidence: 91, words: [{ x0: 10, y0: 20, x1: 300, y1: 40, text: "first 0" }] },
        { x0: 10, y0: 50, x1: 200, y1: 70, text: "second", confidence: 77, words: [{ x0: 10, y0: 50, x1: 200, y1: 70, text: "second" }] },
      ],
      [
        { x0: 1010, y0: 20, x1: 1300, y1: 40, text: "first 1000", confidence: 91, words: [{ x0: 1010, y0: 20, x1: 1300, y1: 40, text: "first 1000" }] },
        { x0: 1010, y0: 50, x1: 1200, y1: 70, text: "second", confidence: 77, words: [{ x0: 1010, y0: 50, x1: 1200, y1: 70, text: "second" }] },
      ],
    ],
  });
  // Each column is recognized on its own, with Tesseract's rectangle option.
  assert.deepEqual(
    tesseract.recognized.map((r) => plain(r)),
    RECTS.map((rectangle) => ({ image: IMAGE, opts: { rectangle }, output: { blocks: true, text: false } }))
  );
});

test("lines from every block and paragraph, in order", async () => {
  const pages = () => ({
    blocks: [
      { paragraphs: [{ lines: [tLine("a", { x0: 0, y0: 0, x1: 1, y1: 1 }), tLine("b", { x0: 0, y0: 2, x1: 1, y1: 3 })] }] },
      { paragraphs: [{ lines: [] }, { lines: [tLine("c", { x0: 0, y0: 4, x1: 1, y1: 5 })] }] },
    ],
  });
  const { send } = setup({ tesseract: fakeTesseract({ pages }) });
  const res = plain(await send({ target: "offscreen", image: IMAGE, rects: [RECTS[0]] }).done);
  assert.deepEqual(
    res.columns[0].map((l) => l.text),
    ["a", "b", "c"]
  );
});

test("each line's words come back with their boxes; a line without words gives none", async () => {
  const pages = () => ({
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              tLine("two words", { x0: 0, y0: 0, x1: 100, y1: 10 }, 90, [
                { text: "two", bbox: { x0: 0, y0: 0, x1: 40, y1: 10 } },
                { text: "words", bbox: { x0: 50, y0: 0, x1: 100, y1: 10 } },
              ]),
              { text: "no words field", confidence: 90, bbox: { x0: 0, y0: 20, x1: 30, y1: 30 } },
            ],
          },
        ],
      },
    ],
  });
  const { send } = setup({ tesseract: fakeTesseract({ pages }) });
  const res = plain(await send({ target: "offscreen", image: IMAGE, rects: [RECTS[0]] }).done);
  assert.deepEqual(res.columns[0][0].words, [
    { x0: 0, y0: 0, x1: 40, y1: 10, text: "two" },
    { x0: 50, y0: 0, x1: 100, y1: 10, text: "words" },
  ]);
  assert.deepEqual(res.columns[0][1].words, []);
});

test("a page with no text blocks gives empty columns", async () => {
  const { send } = setup({ tesseract: fakeTesseract({ pages: () => ({ blocks: null }) }) });
  const res = plain(await send({ target: "offscreen", image: IMAGE, rects: RECTS }).done);
  assert.deepEqual(res.columns, [[], []]);
});

test("no rectangles: nothing recognized", async () => {
  const { send, tesseract } = setup();
  assert.deepEqual(plain(await send({ target: "offscreen", image: IMAGE, rects: [] }).done), { columns: [] });
  assert.equal(tesseract.recognized.length, 0);
});

test("the Tesseract worker is created once, from the bundled files, and reused", async () => {
  const { send, tesseract, chrome } = setup();
  await send({ target: "offscreen", image: IMAGE, rects: RECTS }).done;
  await send({ target: "offscreen", image: IMAGE, rects: RECTS }).done;
  assert.equal(tesseract.created.length, 1);
  assert.equal(tesseract.recognized.length, 4);
  const vendor = chrome.runtime.getURL("vendor/tesseract");
  assert.deepEqual(plain(tesseract.created[0]), [
    "eng",
    1,
    { workerPath: `${vendor}/worker.min.js`, corePath: vendor, langPath: vendor, workerBlobURL: false, cacheMethod: "none" },
  ]);
});

test("concurrent requests share one worker", async () => {
  const { send, tesseract } = setup();
  await Promise.all([send({ target: "offscreen", image: IMAGE, rects: RECTS }).done, send({ target: "offscreen", image: IMAGE, rects: RECTS }).done]);
  assert.equal(tesseract.created.length, 1);
});

test("a worker that failed to load is reported, then created again on the next request", async () => {
  const { send, tesseract } = setup({ tesseract: fakeTesseract({ failCreate: 1 }) });
  assert.deepEqual(plain(await send({ target: "offscreen", image: IMAGE, rects: RECTS }).done), { error: "worker failed to load" });
  const res = plain(await send({ target: "offscreen", image: IMAGE, rects: RECTS }).done);
  assert.deepEqual(res.columns, [[], []]);
  assert.equal(tesseract.created.length, 2);
});

test("recognition errors come back as { error: message }", async () => {
  const boom = fakeTesseract({
    pages: () => {
      throw new Error("recognize blew up");
    },
  });
  const { send } = setup({ tesseract: boom });
  assert.deepEqual(plain(await send({ target: "offscreen", image: IMAGE, rects: RECTS }).done), { error: "recognize blew up" });
  // Something thrown that isn't an Error still gives a string.
  const odd = fakeTesseract({
    pages: () => {
      throw "plain string";
    },
  });
  assert.deepEqual(plain(await setup({ tesseract: odd }).send({ target: "offscreen", image: IMAGE, rects: RECTS }).done), { error: "plain string" });
});
