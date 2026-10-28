// Text with inline style marks, as sent to and returned by Claude: <i>…</i>
// for italics, <b>…</b> for bold, <h1>…</h1>, <h2>… for highlights (each
// number one highlight colour). Marks nest but never cross. Shared by the
// service worker (building sources, checking translations), the content
// script (drawing the overlay) and the Node tests. See docs/text-styles.md.

const MARK_RE = /<(\/?)(i|b|h[1-9][0-9]?)>/g;

// Outermost first: highlights, then bold, then italics.
function styleRank(s) {
  return s[0] === "h" ? Number(s.slice(1)) : s === "b" ? 1000 : 1001;
}

function sortStyles(styles) {
  return [...new Set(styles)].sort((a, b) => styleRank(a) - styleRank(b));
}

// Words ({ text, styles }) as one marked-up string: a run of words with the
// same style shares one pair of marks, and spaces fall inside a mark only
// when the words on both sides have it.
function tagWords(words) {
  let out = "";
  let open = [];
  words.forEach((w, i) => {
    const want = sortStyles(w.styles || []);
    let keep = 0;
    while (keep < open.length && keep < want.length && open[keep] === want[keep]) keep++;
    for (let k = open.length - 1; k >= keep; k--) out += `</${open[k]}>`;
    if (i > 0) out += " ";
    for (let k = keep; k < want.length; k++) out += `<${want[k]}>`;
    open = want;
    out += w.text;
  });
  for (let k = open.length - 1; k >= 0; k--) out += `</${open[k]}>`;
  return out;
}

// The marks' names in `text`.
function markNames(text) {
  return new Set([...String(text).matchAll(MARK_RE)].map((m) => m[2]));
}

function hasMarks(text) {
  return markNames(text).size > 0;
}

// `text` as segments { text, styles } (styles outermost first), or null when
// its marks don't pair up or cross.
function parseMarked(text) {
  const segments = [];
  const stack = [];
  let last = 0;
  for (const m of String(text).matchAll(MARK_RE)) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), styles: [...stack] });
    last = m.index + m[0].length;
    if (!m[1]) stack.push(m[2]);
    else if (stack.at(-1) === m[2]) stack.pop();
    else return null;
  }
  if (stack.length) return null;
  if (last < text.length) segments.push({ text: text.slice(last), styles: [] });
  return segments.filter((s) => s.text);
}

function stripMarks(text) {
  return String(text).replace(MARK_RE, "");
}

// A translation's marks are usable when they pair up, never cross, and use
// only names its source has. Returns the text, or the text without marks.
function checkMarks(text, source) {
  if (!hasMarks(text)) return { text, ok: true };
  const allowed = markNames(source);
  const names = markNames(text);
  if (parseMarked(text) && [...names].every((n) => allowed.has(n))) return { text, ok: true };
  return { text: stripMarks(text), ok: false };
}

// Where to cut `chars` into parts sized by `weights` (say, the lines a
// paragraph has in each column): at a space or punctuation near each share.
function cutPoints(chars, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  const cuts = [];
  if (weights.length < 2 || !total) return cuts;
  let from = 0;
  let acc = 0;
  for (let i = 0; i < weights.length - 1; i++) {
    acc += weights[i];
    const target = Math.round((chars.length * acc) / total);
    let cut = target;
    // Look a few characters either way for a natural break.
    for (let d = 0; d <= 8; d++) {
      if (isBreak(chars[target + d - 1])) {
        cut = target + d;
        break;
      }
      if (target - d > from && isBreak(chars[target - d - 1])) {
        cut = target - d;
        break;
      }
    }
    cut = Math.min(chars.length, Math.max(from, cut));
    cuts.push(cut);
    from = cut;
  }
  return cuts;
}

function isBreak(ch) {
  return ch !== undefined && /[\s，。、；：！？」』）,.;:!?)]/.test(ch);
}

// Split plain `text` into parts sized by `weights`, cut at a natural break.
function splitText(text, weights) {
  if (weights.length < 2 || !weights.reduce((s, w) => s + w, 0)) return [text, ...weights.slice(1).map(() => "")];
  const chars = [...text];
  const bounds = [0, ...cutPoints(chars, weights), chars.length];
  return bounds.slice(1).map((end, i) => chars.slice(bounds[i], end).join("").trim());
}

// The same for marked text: each part as segments { text, styles }, marks
// carried across a cut on both sides. Text whose marks are broken is split
// as plain text.
function splitMarked(text, weights) {
  const segments = parseMarked(text) ?? [{ text: stripMarks(text), styles: [] }];
  const chars = segments.flatMap((s) => [...s.text].map((ch) => ({ ch, styles: s.styles })));
  const n = Math.max(1, weights.length);
  const bounds = weights.reduce((s, w) => s + w, 0) && n > 1 ? [0, ...cutPoints(chars.map((c) => c.ch), weights), chars.length] : [0, chars.length, ...Array(n - 1).fill(chars.length)];
  return bounds.slice(1).map((end, i) => {
    let part = chars.slice(bounds[i], end);
    while (part.length && /\s/.test(part[0].ch)) part = part.slice(1);
    while (part.length && /\s/.test(part.at(-1).ch)) part = part.slice(0, -1);
    const out = [];
    for (const c of part) {
      const prev = out.at(-1);
      if (prev && prev.styles.join() === c.styles.join()) prev.text += c.ch;
      else out.push({ text: c.ch, styles: c.styles });
    }
    return out;
  });
}

if (typeof module !== "undefined") {
  module.exports = { MARK_RE, sortStyles, tagWords, markNames, hasMarks, parseMarked, stripMarks, checkMarks, cutPoints, splitText, splitMarked };
}
