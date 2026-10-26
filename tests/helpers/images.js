// Synthetic screenshots. A "screen" is a small JSON spec carried inside a
// data URL; the fake canvas renders it on demand, pixel by pixel, as rows of
// word-shaped ink on a page background. Different pages put their words in
// different places, so page-sig.js tells them apart as it would real pages.
//
// Spec: { w, h, page, theme: "white" | "sepia" | "dark", spread, overlay, toolbar }
// - page: any string; seeds the word layout.
// - spread: two columns with a gutter (a two-page spread).
// - overlay: a string; the translation overlay drawn over the text area
//   (different "words"), as after showOnPage.
// - toolbar: the reader's title bar showing (outside the area the
//   fingerprint looks at).

const THEMES = {
  white: { bg: [255, 255, 255], ink: [20, 20, 20] },
  sepia: { bg: [251, 240, 217], ink: [70, 50, 30] },
  dark: { bg: [0, 0, 0], ink: [200, 200, 200] },
};

const TEXT = { x0: 0.14, x1: 0.86, y0: 0.12, y1: 0.86, gutter: [0.47, 0.53] };
const LINE_PITCH = 0.03; // of the height
const INK_HEIGHT = 0.6; // share of the pitch that is ink

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed) {
  let s = hash(seed) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function screen(spec = {}) {
  return { w: 960, h: 600, page: "p1", theme: "white", spread: false, overlay: null, toolbar: false, ...spec };
}

function screenUrl(spec) {
  return `data:image/x-fake;base64,${Buffer.from(JSON.stringify(screen(spec))).toString("base64")}`;
}

function parseScreenUrl(url) {
  return JSON.parse(Buffer.from(url.slice(url.indexOf(",") + 1), "base64").toString());
}

// Per line, the word spans [x0, x1] as fractions of the width.
const layouts = new Map();
function wordLayout(seed, spread) {
  const key = `${seed}|${spread}`;
  if (layouts.has(key)) return layouts.get(key);
  const rand = rng(seed);
  const cols = spread ? [[TEXT.x0, TEXT.gutter[0]], [TEXT.gutter[1], TEXT.x1]] : [[TEXT.x0, TEXT.x1]];
  const nLines = Math.floor((TEXT.y1 - TEXT.y0) / LINE_PITCH);
  const lines = [];
  for (let i = 0; i < nLines; i++) {
    const words = [];
    for (const [c0, c1] of cols) {
      // Paragraph starts are indented, and some lines end short.
      let x = c0 + (rand() < 0.2 ? 0.03 : 0);
      const end = rand() < 0.15 ? c0 + (c1 - c0) * (0.3 + rand() * 0.5) : c1;
      while (x < end) {
        const wd = 0.012 + rand() * 0.04;
        words.push([x, Math.min(x + wd, end)]);
        x += wd + 0.007;
      }
    }
    lines.push(words);
  }
  layouts.set(key, lines);
  return lines;
}

// Color of the screen at pixel (x, y).
function renderer(spec) {
  const { bg, ink } = THEMES[spec.theme];
  const text = wordLayout(spec.overlay ? `overlay:${spec.overlay}` : spec.page, spec.spread);
  return (x, y) => {
    const fx = x / spec.w;
    const fy = y / spec.h;
    if (spec.toolbar && fy < 0.06) return fx > 0.3 && fx < 0.7 && fy > 0.02 && fy < 0.04 ? ink : [128, 128, 128];
    if (fy < TEXT.y0 || fy >= TEXT.y1) return bg;
    const pos = (fy - TEXT.y0) / LINE_PITCH;
    const line = Math.floor(pos);
    if (pos - line > INK_HEIGHT || line >= text.length) return bg;
    for (const [w0, w1] of text[line]) if (fx >= w0 && fx < w1) return ink;
    return bg;
  };
}

// Globals for the extension scripts: fetch() of a data URL, createImageBitmap
// and OffscreenCanvas. The canvas remembers its last drawImage and samples
// the source screen when its pixels are read.
function imageGlobals() {
  async function fetchDataUrl(url) {
    const blob = url.startsWith("data:image/x-fake")
      ? { __screen: parseScreenUrl(url) }
      : { __bytes: Buffer.from(url.slice(url.indexOf(",") + 1), "base64") };
    return { ok: true, status: 200, blob: async () => blob };
  }

  async function createImageBitmap(blob) {
    if (blob.__screen) return { width: blob.__screen.w, height: blob.__screen.h, __screen: blob.__screen };
    // A PNG this fake canvas encoded: its JSON says what was drawn.
    const drawn = JSON.parse(blob.__bytes.toString());
    return { width: drawn.width, height: drawn.height, __drawn: drawn };
  }

  class OffscreenCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.draw = null;
      const canvas = this;
      this.ctx = {
        imageSmoothingQuality: "low",
        fillStyle: "#000",
        fillRect() {},
        drawImage(img, ...a) {
          const [sx, sy, sw, sh, dx, dy, dw, dh] =
            a.length === 8 ? a : a.length === 4 ? [0, 0, img.width, img.height, ...a] : [0, 0, img.width, img.height, a[0], a[1], img.width, img.height];
          canvas.draw = { img, sx, sy, sw, sh, dx, dy, dw, dh };
        },
        getImageData(x0, y0, w, h) {
          const data = new Uint8ClampedArray(w * h * 4);
          const d = canvas.draw;
          const render = d?.img.__screen ? renderer(d.img.__screen) : null;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const i = (y * w + x) * 4;
              data[i + 3] = 255;
              if (!render) continue;
              const px = x0 + x + 0.5;
              const py = y0 + y + 0.5;
              if (px < d.dx || py < d.dy || px >= d.dx + d.dw || py >= d.dy + d.dh) continue;
              const c = render(d.sx + ((px - d.dx) * d.sw) / d.dw, d.sy + ((py - d.dy) * d.sh) / d.dh);
              data[i] = c[0];
              data[i + 1] = c[1];
              data[i + 2] = c[2];
            }
          }
          return { width: w, height: h, data };
        },
      };
    }
    getContext() {
      return this.ctx;
    }
    async convertToBlob({ type } = {}) {
      const d = this.draw;
      const json = JSON.stringify({
        type,
        width: this.width,
        height: this.height,
        screen: d?.img.__screen ?? null,
        crop: d && { sx: d.sx, sy: d.sy, sw: d.sw, sh: d.sh },
      });
      return new Blob([json], { type });
    }
  }

  return { fetchDataUrl, createImageBitmap, OffscreenCanvas };
}

// What the fake canvas encoded into an image data URL (e.g. the PNG that
// ocrPage sends to the offscreen document).
function decodeDrawn(dataUrl) {
  return JSON.parse(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64").toString());
}

module.exports = { THEMES, screen, screenUrl, parseScreenUrl, renderer, imageGlobals, decodeDrawn, rng };
