// Page identity by a coarse fingerprint instead of an exact pixel hash.
// The reader's toolbar sliding in, hover effects and anti-aliasing change a
// few pixels without changing the page; an exact hash called that a page turn.
// The fingerprint is the text area shrunk to SIG_WIDTH pixels wide and reduced
// to ink / no ink; two screens are the same page when few ink pixels differ.
// A different page never lines its words up the same way.
// Loaded by the service worker with importScripts and by Node tests; no DOM
// or chrome APIs.

const SIG_WIDTH = 240;
const INK_CONTRAST = 28; // luminance difference from the background that counts as ink
const SAME_PAGE_DIFF = 0.15; // differing pixels, as a share of the ink

// Fingerprint of a grayscale image ({ width, height, data }, one luminance
// byte per pixel, already SIG_WIDTH wide) as "WxH:base64 bits".
function pageSignature({ width, height, data }) {
  const bg = medianLuma(data);
  const bits = new Uint8Array(Math.ceil((width * height) / 8));
  for (let i = 0; i < width * height; i++) if (Math.abs(data[i] - bg) > INK_CONTRAST) bits[i >> 3] |= 1 << (i & 7);
  let bin = "";
  for (const b of bits) bin += String.fromCharCode(b);
  return `${width}x${height}:${btoa(bin)}`;
}

// Share of ink pixels that differ between two fingerprints (0 = identical),
// or 1 when they can't be compared (missing, or a different window size).
function pageDiff(a, b) {
  if (!a || !b) return 1;
  const [dimA, bitsA] = a.split(":");
  const [dimB, bitsB] = b.split(":");
  if (dimA !== dimB) return 1;
  const x = atob(bitsA);
  const y = atob(bitsB);
  let diff = 0;
  let inkA = 0;
  let inkB = 0;
  for (let i = 0; i < x.length; i++) {
    const p = x.charCodeAt(i);
    const q = y.charCodeAt(i);
    diff += popcount(p ^ q);
    inkA += popcount(p);
    inkB += popcount(q);
  }
  // A nearly blank page: compare against a floor so a few specks don't count.
  return diff / Math.max(inkA, inkB, 200);
}

function samePage(a, b) {
  return pageDiff(a, b) <= SAME_PAGE_DIFF;
}

function popcount(v) {
  let n = 0;
  for (; v; v &= v - 1) n++;
  return n;
}

function medianLuma(data) {
  const hist = new Uint32Array(256);
  for (const v of data) hist[v]++;
  for (let v = 0, seen = 0; v < 256; v++) if ((seen += hist[v]) >= data.length / 2) return v;
  return 255;
}

if (typeof module !== "undefined") module.exports = { SIG_WIDTH, pageSignature, pageDiff, samePage };
