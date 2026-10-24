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
// its text lines with boxes in image pixels.
async function ocr({ image, rects }) {
  const worker = await getWorker();
  const columns = [];
  for (const rectangle of rects) {
    const { data } = await worker.recognize(image, { rectangle }, { blocks: true, text: false });
    columns.push(
      (data.blocks || [])
        .flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
        .map((l) => ({ ...l.bbox, text: l.text, confidence: l.confidence }))
    );
  }
  return { columns };
}
