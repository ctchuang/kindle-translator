// offscreen.js: the offscreen document that runs Tesseract (and, through
// layout-model.js, DocLayout-YOLO) for the service worker. Loaded the way
// offscreen.html does, with Tesseract, ONNX Runtime, WebGPU, Cache Storage,
// the canvas and fetch faked.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain, waitFor } = require("./helpers/load");
const { createChrome } = require("./helpers/chrome");

const MODEL_URL = "https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx/resolve/main/doclayout_yolo_docstructbench_imgsz1024.onnx";
const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

// A Tesseract line as recognize() reports it with { blocks: true }.
function tLine(text, bbox, words = [], confidence = 91) {
  return { text, confidence, bbox, words: words.map(([x0, x1]) => ({ bbox: { x0, y0: bbox.y0, x1, y1: bbox.y1 } })) };
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

// ort whose session answers each run with `rows` (x0, y0, x1, y1, conf, cls).
function fakeOrt({ rows = [], create } = {}) {
  const ort = {
    env: { wasm: {} },
    runs: 0,
    Tensor: class {
      constructor(type, data, dims) {
        Object.assign(this, { type, data, dims });
      }
    },
    InferenceSession: {
      async create() {
        if (create) await create();
        return {
          outputNames: ["out"],
          async run() {
            ort.runs++;
            return { out: { data: Float32Array.from(rows.flat()), dims: [1, rows.length, 6] } };
          },
        };
      },
    },
  };
  return ort;
}

class FakeCanvas {
  constructor(w, h) {
    this.size = w * h;
  }
  getContext() {
    const size = this.size;
    return { fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(size * 4) }) };
  }
}

function setup({ tesseract = fakeTesseract(), ort = fakeOrt(), navigator = { gpu: { requestAdapter: async () => ({}) } } } = {}) {
  const chrome = createChrome();
  chrome._.runtimeMessageHandler = () => undefined;
  const fetched = [];
  const caches = {
    async open() {
      return { match: async (url) => (url === MODEL_URL ? new Response(new Uint8Array([1])) : undefined), put: async () => {} };
    },
  };
  const ctx = loadScripts(["ocr-layout.js", "layout-model.js", "offscreen.js"], {
    chrome,
    Tesseract: tesseract,
    ort,
    navigator,
    caches,
    OffscreenCanvas: FakeCanvas,
    Uint8ClampedArray,
    async fetch(url) {
      fetched.push(url);
      return { blob: async () => ({ blob: url }) };
    },
    async createImageBitmap(blob) {
      return { width: 2000, height: 1000, from: blob };
    },
  });
  // Send a message the way chrome.runtime.onMessage would, collecting the reply.
  const send = (msg) => {
    let reply;
    const done = new Promise((r) => (reply = r));
    const returned = chrome.runtime.onMessage.dispatch(msg, {}, (res) => reply(res));
    return { returned, done };
  };
  return { ctx, chrome, tesseract, ort, fetched, send };
}

const RECTS = [
  { left: 0, top: 0, width: 1000, height: 1000 },
  { left: 1000, top: 0, width: 1000, height: 1000 },
];

test("messages not addressed to the offscreen document are ignored", async () => {
  const { send, tesseract, fetched } = setup();
  for (const msg of [{ type: "ocr", image: IMAGE, rects: RECTS }, { target: "background" }]) {
    const { returned } = send(msg);
    assert.deepEqual(returned, [undefined]); // not true: no async reply coming
  }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(tesseract.created.length, 0);
  assert.equal(fetched.length, 0);
});

test("an OCR request answers asynchronously with { columns, layout }", async () => {
  const pages = (rect) => ({
    blocks: [
      {
        paragraphs: [
          { lines: [tLine(`first ${rect.left}`, { x0: rect.left + 10, y0: 20, x1: rect.left + 300, y1: 40 }, [[rect.left + 10, rect.left + 60], [rect.left + 70, rect.left + 300]])] },
          { lines: [tLine("second", { x0: rect.left + 10, y0: 50, x1: rect.left + 200, y1: 70 }, [[rect.left + 10, rect.left + 200]], 77)] },
        ],
      },
    ],
  });
  // One region per column: the whole letterboxed column, scale 1.024.
  const ort = fakeOrt({ rows: [[0, 0, 1024, 1024, 0.9, 1]] });
  const { send, tesseract, fetched } = setup({ tesseract: fakeTesseract({ pages }), ort });
  const { returned, done } = send({ target: "offscreen", image: IMAGE, rects: RECTS });
  assert.deepEqual(returned, [true]);
  const res = plain(await done);

  assert.deepEqual(res.columns, [
    [
      { x0: 10, y0: 20, x1: 300, y1: 40, text: "first 0", confidence: 91, maxGap: 10, firstWord: 50 },
      { x0: 10, y0: 50, x1: 200, y1: 70, text: "second", confidence: 77, maxGap: 0, firstWord: 190 },
    ],
    [
      { x0: 1010, y0: 20, x1: 1300, y1: 40, text: "first 1000", confidence: 91, maxGap: 10, firstWord: 50 },
      { x0: 1010, y0: 50, x1: 1200, y1: 70, text: "second", confidence: 77, maxGap: 0, firstWord: 190 },
    ],
  ]);
  assert.deepEqual(res.layout.regions, [
    [{ cls: "plain text", conf: Math.fround(0.9), x0: 0, y0: 0, x1: 1000, y1: 1000 }],
    [{ cls: "plain text", conf: Math.fround(0.9), x0: 1000, y0: 0, x1: 2000, y1: 1000 }],
  ]);
  assert.equal(typeof res.layout.ms, "number");

  // Each column is recognized on its own, with Tesseract's rectangle option.
  assert.deepEqual(
    tesseract.recognized.map((r) => plain(r)),
    RECTS.map((rectangle) => ({ image: IMAGE, opts: { rectangle }, output: { blocks: true, text: false } }))
  );
  assert.deepEqual(fetched, [IMAGE]); // the image is decoded once, for the layout model
});

test("word metrics: widest gap and first word width, zero for missing word boxes", async () => {
  const pages = () => ({
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              tLine("a  b    c", { x0: 0, y0: 0, x1: 100, y1: 10 }, [[0, 5], [15, 20], [60, 70]]), // gaps 10, 40
              tLine("one", { x0: 0, y0: 20, x1: 30, y1: 30 }, [[0, 30]]),
              tLine("none", { x0: 0, y0: 40, x1: 30, y1: 50 }, []),
              { text: "no words field", confidence: 90, bbox: { x0: 0, y0: 60, x1: 30, y1: 70 } },
            ],
          },
        ],
      },
    ],
  });
  const { send } = setup({ tesseract: fakeTesseract({ pages }) });
  const res = plain(await send({ target: "offscreen", image: IMAGE, rects: [RECTS[0]] }).done);
  assert.deepEqual(
    res.columns[0].map((l) => [l.text, l.maxGap, l.firstWord]),
    [
      ["a  b    c", 40, 5],
      ["one", 0, 30],
      ["none", 0, 0],
      ["no words field", 0, 0],
    ]
  );
});

test("a page with no text blocks gives empty columns", async () => {
  const { send } = setup({ tesseract: fakeTesseract({ pages: () => ({ blocks: null }) }) });
  const res = plain(await send({ target: "offscreen", image: IMAGE, rects: RECTS }).done);
  assert.deepEqual(res.columns, [[], []]);
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

test("a layout model failure fails the whole request, even though OCR worked", async () => {
  const { send, tesseract } = setup({ navigator: {} });
  const res = plain(await send({ target: "offscreen", image: IMAGE, rects: RECTS }).done);
  assert.equal(Object.keys(res).join(), "error");
  assert.match(res.error, /^DocLayout-YOLO 無法使用：.*WebGPU/);
  // OCR still ran alongside; its result is just not used.
  await waitFor(() => tesseract.recognized.length === 2, { what: "both columns recognized" });
});

test("a session creation failure is reported, and the next request retries it", async () => {
  let n = 0;
  const ort = fakeOrt({
    create: () => {
      if (++n === 1) throw new Error("adapter lost");
    },
  });
  const { send } = setup({ ort });
  assert.deepEqual(plain(await send({ target: "offscreen", image: IMAGE, rects: RECTS }).done), { error: "DocLayout-YOLO 無法使用：adapter lost" });
  const res = plain(await send({ target: "offscreen", image: IMAGE, rects: RECTS }).done);
  assert.ok(res.columns && res.layout, JSON.stringify(res));
  assert.equal(n, 2);
});
