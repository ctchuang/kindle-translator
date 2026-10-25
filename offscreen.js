// Offscreen document that runs Tesseract OCR for the service worker, which
// can't start the Web Worker Tesseract runs in. Everything is loaded from the
// extension itself: MV3 doesn't allow remote code, and the default CDN paths
// would be exactly that.

const VENDOR = chrome.runtime.getURL("vendor/tesseract");
let workerPromise = null;

// One worker for the document's lifetime; loading the model takes a second.
function getWorker() {
  workerPromise ??= Tesseract.createWorker("eng", 1, {
    workerPath: `${VENDOR}/worker.min.js`,
    corePath: VENDOR,
    langPath: VENDOR,
    workerBlobURL: false, // a blob: worker can't importScripts extension files
    cacheMethod: "none", // already local; don't copy it into IndexedDB
  }).catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return;
  ocr(msg).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

// Recognize each rectangle (page column) of the image separately and return
// its text lines with boxes in image pixels, plus two word measurements the
// layout code uses: the widest gap between words and the first word's width.
// The layout model runs alongside on the GPU, and its regions come back per
// column too; if it fails, the whole request fails.
async function ocr({ image, rects }) {
  const worker = await getWorker();
  const bitmap = await createImageBitmap(await (await fetch(image)).blob());
  const layoutDone = layout(bitmap, rects);
  layoutDone.catch(() => {}); // awaited below; don't report it as unhandled meanwhile
  const columns = [];
  for (const rectangle of rects) {
    const { data } = await worker.recognize(image, { rectangle }, { blocks: true, text: false });
    columns.push(
      (data.blocks || [])
        .flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
        .map((l) => ({ ...l.bbox, text: l.text, confidence: l.confidence, ...wordMetrics(l.words || []) }))
    );
  }
  return { columns, layout: await layoutDone };
}

function wordMetrics(words) {
  const gaps = words.slice(1).map((w, i) => w.bbox.x0 - words[i].bbox.x1);
  return { maxGap: Math.max(0, ...gaps), firstWord: words.length ? words[0].bbox.x1 - words[0].bbox.x0 : 0 };
}
