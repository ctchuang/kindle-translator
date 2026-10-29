// Reference pages for the review: paragraphs of the same book translated
// before the page under review, so Sonnet can keep names, terms and tone in
// line with what the reader has already seen; and the book's list of names
// and their translations (docs/reference-pages.md).
// Paragraphs are kept by their position range in the book, like the
// paragraph cache, so they're the same in any layout.
// Loaded by the service worker with importScripts; no DOM or chrome APIs.

// Kept this long after they were last shown.
const REF_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
// Per book, so one long read can't fill the extension's storage.
const REF_MAX_PARAS = 2000;
// The reference goes to the API in blocks of about this many tokens. Prompt
// caching matches at block boundaries, so blocks already sent must stay the
// same as the set grows: only the last one is still filling up.
const REF_BLOCK_TOKENS = 1000;
// JSON keys and quotes around each paragraph.
const REF_PARA_OVERHEAD = 8;

// Rough token count, on the high side: a CJK character is about one token,
// other text about 3.5 characters a token.
function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of text || "") {
    if (/[⺀-鿿豈-﫿＀-￯]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3.5);
}

function paraTokens(p) {
  return estimateTokens(p.source) + estimateTokens(p.text) + REF_PARA_OVERHEAD;
}

// `stored` ({ start, end, source, text, savedAt }, by start) with `added`
// put in: a stored paragraph that overlaps an added one is replaced (cut at
// another page edge, or translated again). Drops paragraphs older than
// REF_MAX_AGE_MS, then the oldest past REF_MAX_PARAS.
function mergeParas(stored, added, now) {
  const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;
  let out = (stored || []).filter((p) => now - p.savedAt <= REF_MAX_AGE_MS && !added.some((a) => overlaps(a, p)));
  out = out.concat(added.map((p) => ({ start: p.start, end: p.end, source: p.source, text: p.text, savedAt: now })));
  if (out.length > REF_MAX_PARAS) {
    const keep = new Set([...out].sort((a, b) => b.savedAt - a.savedAt).slice(0, REF_MAX_PARAS));
    out = out.filter((p) => keep.has(p));
  }
  return out.sort((a, b) => a.start - b.start);
}

// The paragraphs to send with the page starting at position `at`, and where
// the reference set starts from now on.
//
// Only paragraphs before the page count: never what the reader hasn't
// reached. The set starts at `refStart` and grows as the reader goes on, so
// its beginning, the cached prefix, stays put. Past `maxTokens` the oldest
// are dropped down to half, all at once, rather than one per page. A new set
// (no `refStart`, or the reader went back before it) takes the nearest
// paragraphs up to half of `maxTokens`, leaving room to grow.
//
// Returns { paras (by position), refStart, tokens, reset, trimmed }.
function pickReference(paras, at, refStart, maxTokens) {
  const before = (paras || []).filter((p) => p.end < at).sort((a, b) => a.start - b.start);
  let set = refStart == null || refStart >= at ? [] : before.filter((p) => p.start >= refStart);
  const out = { reset: false, trimmed: false };
  if (!set.length) {
    out.reset = true;
    set = nearest(before, maxTokens / 2);
  } else if (sumTokens(set) > maxTokens) {
    out.trimmed = true;
    while (set.length && sumTokens(set) > maxTokens / 2) set = set.slice(1);
  }
  return { ...out, paras: set, refStart: set.length ? set[0].start : null, tokens: sumTokens(set) };
}

// The last paragraphs of `list` that fit in `budget` tokens, in order.
function nearest(list, budget) {
  let used = 0;
  let i = list.length;
  while (i > 0 && used + paraTokens(list[i - 1]) <= budget) used += paraTokens(list[--i]);
  return list.slice(i);
}

function sumTokens(list) {
  return list.reduce((n, p) => n + paraTokens(p), 0);
}

// The set cut into blocks of about REF_BLOCK_TOKENS, closing a block once it
// reaches that size. Each block is one paragraph per line, { source, text }
// as JSON. `full`: whether the block is closed (it won't change as the set
// grows).
function referenceBlocks(paras) {
  const blocks = [];
  let lines = [];
  let tokens = 0;
  for (const p of paras) {
    lines.push(JSON.stringify({ source: p.source, text: p.text }));
    tokens += paraTokens(p);
    if (tokens >= REF_BLOCK_TOKENS) {
      blocks.push({ text: lines.join("\n"), full: true });
      lines = [];
      tokens = 0;
    }
  }
  if (lines.length) blocks.push({ text: lines.join("\n"), full: false });
  return blocks;
}

// ---- Name list ----

// The book's names as the review settled them, source → translation, so a
// name keeps one translation however far back it was first seen. Kept 30
// days after a name was last on a reviewed page.
const NAMES_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
// Per book; past it the names seen longest ago go.
const NAMES_MAX = 500;

// `stored` ({ [source]: { text, savedAt } }) with the names the review
// found on a page ([{ source, text }]). Only single names are kept: a full
// name is split into its given name and surname (splitNames), so the list
// can't hold "Wiggin → 懷金" and "Ender Wiggin → 安德・維金" side by side; a
// full name listed before (2.3.0's first build kept them) is dropped. A
// name already listed keeps its translation, so the first one sticks; a
// different one comes back in `conflicts`. Returns { names, added,
// conflicts }.
function mergeNames(stored, found, now) {
  const names = {};
  for (const [source, n] of Object.entries(stored || {})) if (!/\s/.test(source) && now - n.savedAt <= NAMES_MAX_AGE_MS) names[source] = n;
  const added = [];
  const conflicts = [];
  for (const { source, text } of splitNames(found)) {
    if (!source || !text || source.length > 60 || text.length > 30) continue;
    const had = names[source];
    if (had) {
      if (had.text !== text) conflicts.push({ source, text, kept: had.text });
      names[source] = { text: had.text, savedAt: now };
    } else {
      names[source] = { text, savedAt: now };
      added.push({ source, text });
    }
  }
  const keys = Object.keys(names);
  if (keys.length > NAMES_MAX) {
    keys.sort((a, b) => names[a].savedAt - names[b].savedAt);
    for (const k of keys.slice(0, keys.length - NAMES_MAX)) delete names[k];
  }
  return { names, added, conflicts };
}

// Names as single words: "Mazer Rackham" → "梅澤·拉克姆" gives Mazer → 梅澤
// and Rackham → 拉克姆. A name whose two sides don't split into as many
// parts (a title: "Mr. Wiggin" → "威金先生") is dropped. A possessive 's
// is dropped too.
function splitNames(found) {
  const out = [];
  for (const f of found || []) {
    const source = String(f?.source ?? "").trim().replace(/['’]s$/, "");
    const text = String(f?.text ?? "").trim();
    const words = source.split(/\s+/).filter(Boolean);
    if (words.length <= 1) {
      out.push({ source, text });
      continue;
    }
    const parts = text.split(/[\s・·•‧．]+/).filter(Boolean);
    if (parts.length === words.length) words.forEach((w, i) => out.push({ source: w, text: parts[i] }));
  }
  return out;
}

// The listed names that appear, as whole words, in any of `texts`, as
// [{ source, text }] by source.
function namesIn(names, texts) {
  const all = texts.join("\n");
  return Object.keys(names || {})
    .filter((source) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(source)}(?![\\p{L}\\p{N}])`, "u").test(all))
    .sort()
    .map((source) => ({ source, text: names[source].text }));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (typeof module !== "undefined") {
  module.exports = { REF_MAX_AGE_MS, REF_MAX_PARAS, REF_BLOCK_TOKENS, NAMES_MAX_AGE_MS, NAMES_MAX, estimateTokens, paraTokens, mergeParas, pickReference, referenceBlocks, mergeNames, namesIn };
}
