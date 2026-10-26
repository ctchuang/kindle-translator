// layout-model.js: downloading / caching DocLayout-YOLO, creating the WebGPU
// session, and turning page columns into model input and regions back into
// bitmap pixels. ONNX Runtime, WebGPU, Cache Storage and the canvas are fakes.

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { createContext, loadScripts, plain, source } = require("./helpers/load");
const { createChrome } = require("./helpers/chrome");

const MODEL_URL = "https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx/resolve/main/doclayout_yolo_docstructbench_imgsz1024.onnx";
const REAL_SHA = "fece9af02f618b603ff7921ccec6861d13e7e1f9830e091dfb7e8ad9311e5b21";
const SIZE = 1024;

// A canvas that records what's drawn and returns pixels the test chooses:
// pixel i is R = i % 251, G = (i * 3) % 253, B = (i * 7) % 255.
class FakeCanvas {
  static made = [];
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.calls = [];
    const calls = this.calls;
    this.ctx = {
      fillStyle: "",
      fillRect(...a) {
        calls.push(["fillRect", this.fillStyle, ...a]);
      },
      drawImage(...a) {
        calls.push(["drawImage", ...a]);
      },
      getImageData(x, y, w2, h2) {
        calls.push(["getImageData", x, y, w2, h2]);
        const data = new Uint8ClampedArray(w2 * h2 * 4);
        for (let i = 0; i < w2 * h2; i++) {
          data[i * 4] = i % 251;
          data[i * 4 + 1] = (i * 3) % 253;
          data[i * 4 + 2] = (i * 7) % 255;
          data[i * 4 + 3] = 255;
        }
        return { data };
      },
    };
    FakeCanvas.made.push(this);
  }
  getContext(kind, opts) {
    this.contextArgs = [kind, opts];
    return this.ctx;
  }
}

// ort: InferenceSession.create returns a session whose run() answers with
// `outputs` (rows of x0, y0, x1, y1, conf, cls in model pixels), one per call.
function fakeOrt({ outputs = [], create } = {}) {
  const ort = {
    env: { wasm: {} },
    created: [],
    runs: [],
    Tensor: class {
      constructor(type, data, dims) {
        Object.assign(this, { type, data, dims });
      }
    },
    InferenceSession: {
      async create(bytes, opts) {
        ort.created.push({ bytes, opts });
        if (create) await create(ort.created.length);
        return {
          outputNames: ["output0"],
          async run(feeds) {
            ort.runs.push(feeds);
            const rows = outputs[ort.runs.length - 1] || [];
            return { output0: { data: Float32Array.from(rows.flat()), dims: [1, rows.length, 6] } };
          },
        };
      },
    },
  };
  return ort;
}

// Cache Storage with one cache; `stored` maps URL -> bytes.
function fakeCaches(stored = new Map()) {
  const log = { opened: [], puts: [] };
  return {
    log,
    stored,
    async open(name) {
      log.opened.push(name);
      return {
        async match(url) {
          return stored.has(url) ? new Response(stored.get(url)) : undefined;
        },
        async put(url, res) {
          log.puts.push(url);
          stored.set(url, new Uint8Array(await res.arrayBuffer()));
        },
      };
    },
  };
}

// fetch() of the model: `bytes` delivered in `chunk`-sized reads.
function fakeFetch(bytes, { status = 200, chunk = 100, length = bytes.length } = {}) {
  const fn = async (url) => {
    fn.calls.push(url);
    let at = 0;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (h.toLowerCase() === "content-length" && length != null ? String(length) : null) },
      body: {
        getReader: () => ({
          async read() {
            if (at >= bytes.length) return { done: true };
            const value = bytes.slice(at, at + chunk);
            at += chunk;
            return { value, done: false };
          },
        }),
      },
    };
  };
  fn.calls = [];
  return fn;
}

const gpu = (adapter = {}) => ({ gpu: { requestAdapter: async () => adapter } });

function setup({ ort = fakeOrt(), caches = fakeCaches(new Map([[MODEL_URL, new Uint8Array([1, 2, 3])]])), fetch = fakeFetch(new Uint8Array(0)), navigator = gpu(), sha, performance } = {}) {
  const chrome = createChrome();
  chrome._.runtimeMessageHandler = () => undefined;
  FakeCanvas.made = [];
  const globals = { chrome, ort, caches, fetch, navigator, OffscreenCanvas: FakeCanvas, Uint8ClampedArray };
  if (performance) globals.performance = performance;
  let ctx;
  if (sha) {
    // A `const` can't be reassigned or redeclared in the shared global scope
    // (redeclaring is a SyntaxError), so to reach the success path the test
    // loads layout-model.js with the expected hash swapped for the fake
    // model's. The file on disk is untouched.
    ctx = createContext(globals);
    vm.runInContext(source("ocr-layout.js"), ctx, { filename: "ocr-layout.js" });
    vm.runInContext(source("layout-model.js").replace(REAL_SHA, sha), ctx, { filename: "layout-model.js" });
  } else {
    ctx = loadScripts(["ocr-layout.js", "layout-model.js"], globals);
  }
  return { ctx, chrome, ort, caches, fetch };
}

const PREFIX = "DocLayout-YOLO 無法使用：";

test("ONNX Runtime is pointed at the bundled wasm files, single-threaded", () => {
  const { ort, chrome } = setup();
  assert.equal(ort.env.wasm.wasmPaths, chrome.runtime.getURL("vendor/onnxruntime/"));
  assert.equal(ort.env.wasm.numThreads, 1);
});

test("the expected model hash can't be overridden through the shared scope", () => {
  const { ctx } = setup();
  assert.equal(ctx.run("LAYOUT_MODEL_SHA256"), REAL_SHA);
  assert.throws(() => ctx.run("LAYOUT_MODEL_SHA256 = 'x'"), { name: "TypeError" }); // the context's own error classes
  assert.throws(() => ctx.run("const LAYOUT_MODEL_SHA256 = 'x'"), { name: "SyntaxError" });
});

test("no WebGPU adapter: a prefixed error, and no download", async () => {
  for (const navigator of [{}, { gpu: { requestAdapter: async () => null } }]) {
    const { ctx, fetch, caches } = setup({ navigator });
    await assert.rejects(ctx.layoutModel(), (err) => {
      assert.ok(err.message.startsWith(PREFIX), err.message);
      assert.match(err.message, /WebGPU/);
      return true;
    });
    assert.equal(fetch.calls.length, 0);
    assert.equal(caches.log.opened.length, 0);
  }
});

test("the session is created once and reused", async () => {
  const { ctx, ort } = setup();
  const a = await ctx.layoutModel();
  const b = await ctx.layoutModel();
  assert.equal(a, b);
  assert.equal(ort.created.length, 1);
  assert.deepEqual(plain(ort.created[0].opts), { executionProviders: ["webgpu"] });
});

test("a failed session creation is reported and retried on the next call", async () => {
  const ort = fakeOrt({
    create: (n) => {
      if (n === 1) throw new Error("GPU lost");
    },
  });
  const { ctx } = setup({ ort });
  await assert.rejects(ctx.layoutModel(), { message: `${PREFIX}GPU lost` });
  assert.ok(await ctx.layoutModel());
  assert.equal(ort.created.length, 2);
  // And kept after that.
  await ctx.layoutModel();
  assert.equal(ort.created.length, 2);
});

test("model bytes come from Cache Storage when they're there, without fetching", async () => {
  const { ctx, ort, fetch, caches, chrome } = setup();
  await ctx.layoutModel();
  assert.deepEqual(caches.log.opened, ["kindle-translator-models"]);
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual([...ort.created[0].bytes], [1, 2, 3]);
  assert.equal(chrome._.runtimeMessages.length, 0); // no progress for a cache hit
});

test("download: an HTTP error fails with its status, and the next call retries", async () => {
  const fetch = fakeFetch(new Uint8Array(0), { status: 503 });
  const { ctx, ort } = setup({ caches: fakeCaches(), fetch });
  await assert.rejects(ctx.layoutModel(), { message: `${PREFIX}下載版面模型失敗：HTTP 503` });
  await assert.rejects(ctx.layoutModel());
  assert.deepEqual(fetch.calls, [MODEL_URL, MODEL_URL]);
  assert.equal(ort.created.length, 0);
});

// Steps of 5% the progress messages fell in.
const steps = (chrome) => chrome._.runtimeMessages.map((m) => Math.floor(m.progress * 20));

test("download: progress messages start at 0 and come at most every 5%", async () => {
  const bytes = new Uint8Array(10_000).fill(7);
  // 0.5% chunks: 200 reads, but only 21 messages.
  const { ctx, chrome } = setup({ caches: fakeCaches(), fetch: fakeFetch(bytes, { chunk: 50 }) });
  await assert.rejects(ctx.layoutModel()); // the hash can't match; progress is what's tested
  const msgs = chrome._.runtimeMessages;
  assert.ok(msgs.every((m) => m.type === "layoutProgress"));
  assert.equal(msgs[0].progress, 0);
  assert.equal(msgs.at(-1).progress, 1);
  const s = steps(chrome);
  for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1], `steps ${s}`);
  assert.equal(s.length, 21);
});

test("download: without content-length, progress is against the model's known size", async () => {
  const bytes = new Uint8Array(1000);
  const { ctx, chrome } = setup({ caches: fakeCaches(), fetch: fakeFetch(bytes, { length: null }) });
  await assert.rejects(ctx.layoutModel());
  // 1000 bytes of a 75 MB total never leaves the first 5%.
  assert.deepEqual(plain(chrome._.runtimeMessages), [{ type: "layoutProgress", progress: 0 }]);
});

test("download: a SHA-256 mismatch is rejected and not cached", async () => {
  const caches = fakeCaches();
  const { ctx, ort } = setup({ caches, fetch: fakeFetch(new TextEncoder().encode("not the model")) });
  await assert.rejects(ctx.layoutModel(), { message: `${PREFIX}版面模型檔案校驗不符，已捨棄` });
  assert.equal(caches.log.puts.length, 0);
  assert.equal(caches.stored.size, 0);
  assert.equal(ort.created.length, 0);
});

test("download: matching bytes are cached and used (hash swapped in the loaded source)", async () => {
  const bytes = Uint8Array.from({ length: 1234 }, (_, i) => (i * 31) % 256);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const caches = fakeCaches();
  const fetch = fakeFetch(bytes, { chunk: 100 });
  const { ctx, ort } = setup({ caches, fetch, sha });
  await ctx.layoutModel();
  // Chunks reassembled in order.
  assert.deepEqual([...ort.created[0].bytes], [...bytes]);
  assert.deepEqual(caches.log.puts, [MODEL_URL]);
  assert.deepEqual([...caches.stored.get(MODEL_URL)], [...bytes]);

  // A new document (fresh context) finds it in the cache.
  const again = setup({ caches, fetch, sha });
  await again.ctx.layoutModel();
  assert.equal(fetch.calls.length, 1);
});

// ---- layout() ----

test("layout: letterboxes each column into 1024x1024 and feeds BGR planes", async () => {
  const { ctx, ort } = setup();
  const bitmap = { width: 2400, height: 1100 };
  const rect = { left: 100, top: 50, width: 2000, height: 1000 };
  await ctx.layout(bitmap, [rect]);

  const [canvas] = FakeCanvas.made;
  assert.equal(canvas.width, SIZE);
  assert.equal(canvas.height, SIZE);
  assert.equal(canvas.contextArgs[0], "2d");
  // Gray padding first, then the column scaled by 1024/2000 = 0.512 to
  // 1024x512, centred vertically.
  const [fill, draw, read] = canvas.calls;
  assert.deepEqual(fill, ["fillRect", "rgb(114, 114, 114)", 0, 0, SIZE, SIZE]);
  assert.equal(draw[1], bitmap);
  assert.deepEqual(
    draw.slice(2).map((v) => v + 0), // + 0: Math.round(-0.1) is -0
    [100, 50, 2000, 1000, 0, 256, 1024, 512]
  );
  assert.deepEqual(read, ["getImageData", 0, 0, SIZE, SIZE]);

  const tensor = ort.runs[0].images;
  assert.equal(tensor.type, "float32");
  assert.deepEqual(plain(tensor.dims), [1, 3, SIZE, SIZE]);
  const plane = SIZE * SIZE;
  assert.equal(tensor.data.length, 3 * plane);
  for (const i of [0, 1, 777, 123_456, plane - 1]) {
    assert.equal(tensor.data[i], Math.fround(((i * 7) % 255) / 255), `B at ${i}`);
    assert.equal(tensor.data[plane + i], Math.fround(((i * 3) % 253) / 255), `G at ${i}`);
    assert.equal(tensor.data[2 * plane + i], Math.fround((i % 251) / 255), `R at ${i}`);
  }
});

test("layout: a tall column is padded left and right", async () => {
  const { ctx } = setup();
  await ctx.layout({}, [{ left: 0, top: 0, width: 500, height: 2048 }]);
  const draw = FakeCanvas.made[0].calls[1];
  // 0.5 scale: 250x1024, left = round(387 - 0.1) = 387.
  assert.deepEqual(
    draw.slice(6).map((v) => v + 0),
    [387, 0, 250, 1024]
  );
});

test("layout: regions come back per column in bitmap pixels, via layoutRegions", async () => {
  const ort = fakeOrt({
    outputs: [
      // Column 1 (scale 0.512, 256 px top padding): the whole column, and a
      // low-confidence box that's dropped.
      [
        [0, 256, 1024, 768, 0.9, 1],
        [0, 256, 10, 266, 0.1, 3],
      ],
      // Column 2 (scale 1, no padding): a figure.
      [[24, 24, 524, 1000, 0.8, 3]],
    ],
  });
  const perf = { now: (() => { let t = 1000; return () => (t += 117.4); })() };
  const { ctx } = setup({ ort, performance: perf });
  const rects = [
    { left: 100, top: 50, width: 2000, height: 1000 },
    { left: 2200, top: 10, width: 1024, height: 1024 },
  ];
  const out = await ctx.layout({}, rects);
  assert.deepEqual(plain(out.regions), [
    [{ cls: "plain text", conf: Math.fround(0.9), x0: 100, y0: 50, x1: 2100, y1: 1050 }],
    [{ cls: "figure", conf: Math.fround(0.8), x0: 2224, y0: 34, x1: 2724, y1: 1010 }],
  ]);
  // performance.now() is read once before and once after: 117.4 ms → 117.
  assert.equal(out.ms, 117);
  assert.equal(ort.runs.length, 2);
  // The canvas is reused and repainted gray for every column.
  assert.equal(FakeCanvas.made.length, 1);
  assert.equal(FakeCanvas.made[0].calls.filter((c) => c[0] === "fillRect").length, 2);
});

test("layout: fails when the model can't be loaded", async () => {
  const { ctx } = setup({ navigator: {} });
  await assert.rejects(ctx.layout({}, [{ left: 0, top: 0, width: 10, height: 10 }]), { message: new RegExp(`^${PREFIX}`) });
  assert.equal(FakeCanvas.made.length, 0);
});

test("download: a retry after an early failure reports 0% again", async () => {
  let n = 0;
  const ok = fakeFetch(new Uint8Array(1000));
  const fetch = async (url) => (++n === 1 ? fakeFetch(new Uint8Array(0), { status: 503 })(url) : ok(url));
  const { ctx, chrome } = setup({ caches: fakeCaches(), fetch });
  await assert.rejects(ctx.layoutModel(), /HTTP 503/);
  const before = chrome._.runtimeMessages.length;
  await assert.rejects(ctx.layoutModel(), /校驗不符/);
  assert.equal(chrome._.runtimeMessages[before]?.progress, 0);
});
