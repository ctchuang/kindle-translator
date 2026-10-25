// Page layout detection for the offscreen document: DocLayout-YOLO
// (DocStructBench, ONNX; see vendor/doclayout) on ONNX Runtime Web, on the
// GPU through WebGPU.
//
// The 75 MB model isn't bundled: it's downloaded from Hugging Face the first
// time, checked against its SHA-256 and kept in Cache Storage; the first page
// waits for it. There is no fallback: if the model can't run, layout()
// throws and the page isn't translated, so a problem shows up as an error
// instead of quietly different results.

const LAYOUT_MODEL_URL =
  "https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx/resolve/main/doclayout_yolo_docstructbench_imgsz1024.onnx";
const LAYOUT_MODEL_SHA256 = "fece9af02f618b603ff7921ccec6861d13e7e1f9830e091dfb7e8ad9311e5b21";
const LAYOUT_CACHE = "kindle-translator-models";

const LAYOUT_SIZE = 1024; // what the model was trained at

ort.env.wasm.wasmPaths = chrome.runtime.getURL("vendor/onnxruntime/");
ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which the offscreen page doesn't have

let layoutSession = null;

// The session, downloading and creating it the first time. A failure is
// reported to the caller and retried on the next call.
function layoutModel() {
  layoutSession ??= (async () => {
    if (!(await navigator.gpu?.requestAdapter())) throw new Error("這個瀏覽器沒有可用的 WebGPU（可到 chrome://gpu 查看）");
    const bytes = await modelBytes();
    return ort.InferenceSession.create(bytes, { executionProviders: ["webgpu"] });
  })().catch((err) => {
    layoutSession = null;
    throw new Error(`DocLayout-YOLO 無法使用：${err?.message || err}`);
  });
  return layoutSession;
}

// Download progress for the side panel, at most every 5%.
let reportedProgress = -1;
function reportProgress(progress) {
  const step = Math.floor(progress * 20);
  if (step === reportedProgress) return;
  reportedProgress = step;
  chrome.runtime.sendMessage({ type: "layoutProgress", progress }).catch(() => {});
}

async function modelBytes() {
  const cache = await caches.open(LAYOUT_CACHE);
  const hit = await cache.match(LAYOUT_MODEL_URL);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  reportProgress(0);
  const res = await fetch(LAYOUT_MODEL_URL);
  if (!res.ok) throw new Error(`下載版面模型失敗：HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 75_324_598;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    reportProgress(got / total);
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (digest !== LAYOUT_MODEL_SHA256) throw new Error("版面模型檔案校驗不符，已捨棄");
  await cache.put(LAYOUT_MODEL_URL, new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
  return bytes;
}

// Layout regions for each rectangle (page column) of `bitmap`, in bitmap
// pixels: { regions, ms }.
async function layout(bitmap, rects) {
  const session = await layoutModel();
  const started = performance.now();
  const size = LAYOUT_SIZE;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  const regions = [];
  for (const rect of rects) {
    // Letterbox like the model's training: keep the aspect ratio, pad gray.
    const r = Math.min(size / rect.width, size / rect.height);
    const nw = Math.round(rect.width * r);
    const nh = Math.round(rect.height * r);
    const left = Math.round((size - nw) / 2 - 0.1);
    const top = Math.round((size - nh) / 2 - 0.1);
    ctx.fillStyle = "rgb(114, 114, 114)";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(bitmap, rect.left, rect.top, rect.width, rect.height, left, top, nw, nh);
    const rgba = ctx.getImageData(0, 0, size, size).data;
    const plane = size * size;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      input[i] = rgba[i * 4 + 2] / 255; // B
      input[plane + i] = rgba[i * 4 + 1] / 255; // G
      input[2 * plane + i] = rgba[i * 4] / 255; // R
    }
    const out = await session.run({ images: new ort.Tensor("float32", input, [1, 3, size, size]) });
    const t = out[session.outputNames[0]];
    regions.push(layoutRegions(t.data, t.dims[1], (x, y) => [rect.left + (x - left) / r, rect.top + (y - top) / r]));
  }
  return { regions, ms: Math.round(performance.now() - started) };
}
