// A canvas that really fills pixels, enough for page-render.js and the
// content script: fillRect, fill(Path2D) of straight-edged paths under
// setTransform (filled as the transformed bounding box, which is exact for
// the synthetic glyphs, all axis-aligned boxes), drawImage of a bitmap at
// 0, 0, getImageData and convertToBlob. A pixel is filled when its centre
// lies inside the shape, the same way every time, so the "reader's" drawing
// and the extension's match exactly, as they do in the browser.

class Path2D {
  constructor(d = "") {
    this.d = d;
    const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    this.box = xs.length ? { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } : null;
  }
}

function parseColor(c) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(c));
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

class OffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    this.ops = []; // what was drawn, for tests that check the calls
    const canvas = this;
    let t = [1, 0, 0, 1, 0, 0];
    const fillBox = (x0, y0, x1, y1, color) => {
      const [r, g, b] = parseColor(color);
      const xa = Math.max(0, Math.ceil(x0 - 0.5));
      const xb = Math.min(canvas.width, Math.ceil(x1 - 0.5));
      const ya = Math.max(0, Math.ceil(y0 - 0.5));
      const yb = Math.min(canvas.height, Math.ceil(y1 - 0.5));
      for (let y = ya; y < yb; y++) {
        for (let x = xa; x < xb; x++) {
          const i = (y * canvas.width + x) * 4;
          canvas.data[i] = r;
          canvas.data[i + 1] = g;
          canvas.data[i + 2] = b;
          canvas.data[i + 3] = 255;
        }
      }
    };
    this.ctx = {
      fillStyle: "#000000",
      imageSmoothingQuality: "low",
      setTransform(a, b, c, d, e, f) {
        t = [a, b, c, d, e, f];
      },
      fillRect(x, y, w, h) {
        canvas.ops.push({ op: "fillRect", x, y, w, h, color: this.fillStyle });
        fillBox(x, y, x + w, y + h, this.fillStyle);
      },
      fill(path) {
        canvas.ops.push({ op: "fill", d: path.d, transform: [...t], color: this.fillStyle });
        if (!path.box) return;
        const [a, b, c, d, e, f] = t;
        const pts = [
          [path.box.x0, path.box.y0],
          [path.box.x1, path.box.y0],
          [path.box.x0, path.box.y1],
          [path.box.x1, path.box.y1],
        ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        fillBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), this.fillStyle);
      },
      drawImage(img, dx = 0, dy = 0) {
        canvas.ops.push({ op: "drawImage", w: img.width, h: img.height });
        if (!img.data) return;
        for (let y = 0; y < img.height && y + dy < canvas.height; y++) {
          const from = y * img.width * 4;
          canvas.data.set(img.data.subarray(from, from + Math.min(img.width, canvas.width - dx) * 4), ((y + dy) * canvas.width + dx) * 4);
        }
      },
      getImageData(x0, y0, w, h) {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) out.set(canvas.data.subarray(((y + y0) * canvas.width + x0) * 4, ((y + y0) * canvas.width + x0 + w) * 4), y * w * 4);
        return { width: w, height: h, data: out };
      },
    };
  }
  getContext() {
    return this.ctx;
  }
  // A "PNG": the size and a digest of the pixels, enough to tell drawings apart.
  async convertToBlob({ type = "image/png" } = {}) {
    let h = 2166136261;
    for (let i = 0; i < this.data.length; i += 4) h = Math.imul(h ^ (this.data[i] + 3 * this.data[i + 1] + 7 * this.data[i + 2]), 16777619);
    return new Blob([JSON.stringify({ type, width: this.width, height: this.height, digest: h >>> 0 })], { type });
  }
}

// What the reader shows for a screen: its text drawn the same way, plus its
// illustrations (which the extension doesn't draw) as speckled grey.
function readerPixels(page, fonts, scale) {
  const { renderPage, imageMasks } = require("../../page-render.js");
  const prev = { OffscreenCanvas: global.OffscreenCanvas, Path2D: global.Path2D };
  global.OffscreenCanvas = OffscreenCanvas;
  global.Path2D = Path2D;
  try {
    const canvas = renderPage(page, fonts, scale);
    for (const [x0, y0, x1, y1] of imageMasks(page, scale)) {
      for (let y = Math.max(0, y0 + 1); y < Math.min(canvas.height, y1 - 1); y++) {
        for (let x = Math.max(0, x0 + 1); x < Math.min(canvas.width, x1 - 1); x++) {
          const i = (y * canvas.width + x) * 4;
          const v = (x * 31 + y * 17) % 2 ? 90 : 200;
          canvas.data[i] = canvas.data[i + 1] = canvas.data[i + 2] = v;
        }
      }
    }
    return { width: canvas.width, height: canvas.height, data: canvas.data };
  } finally {
    Object.assign(global, prev);
  }
}

module.exports = { OffscreenCanvas, Path2D, parseColor, readerPixels };
