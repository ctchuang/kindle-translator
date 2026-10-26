// Runs extension scripts the way Chrome does: as classic scripts sharing one
// global scope, here a node:vm context. Top-level `function` declarations
// become properties of the context; `const` / `let` don't, so read those with
// `ctx.run("name")`.
//
// The context has its own built-ins (Array, Object…), so values coming out of
// it fail assert.deepStrictEqual's prototype check. Compare `plain(x)`.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");

// Timers run this many times faster than asked, so waits like the 600 ms
// capture spacing or the 1.2 s page-turn debounce don't slow the tests down.
const TIME_SCALE = 50;
// AbortSignal.timeout runs faster still: the 180 s API timeout becomes 0.9 s.
const ABORT_TIMEOUT_SCALE = 200;

function scaled(fn, scale) {
  return (cb, ms = 0, ...args) => fn(cb, Math.max(0, ms / scale), ...args);
}

const FastAbortSignal = {
  any: (signals) => AbortSignal.any(signals),
  abort: (reason) => AbortSignal.abort(reason),
  timeout: (ms) => AbortSignal.timeout(Math.max(1, ms / ABORT_TIMEOUT_SCALE)),
};

function source(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

// A context with the browser-ish globals the scripts use, plus `globals`.
function createContext(globals = {}) {
  const ctx = vm.createContext({
    console,
    setTimeout: scaled(setTimeout, TIME_SCALE),
    setInterval: scaled(setInterval, TIME_SCALE),
    clearTimeout,
    clearInterval,
    queueMicrotask,
    structuredClone,
    AbortController,
    AbortSignal: FastAbortSignal,
    DOMException,
    TextDecoder,
    TextEncoder,
    TextDecoderStream,
    ReadableStream,
    Response,
    Blob,
    URL,
    crypto,
    btoa,
    atob,
    performance,
    ...globals,
  });
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(source(f), ctx, { filename: f });
  };
  // Evaluate code in the scripts' scope, e.g. ctx.run("current").
  Object.defineProperty(ctx, "run", { value: (code) => vm.runInContext(code, ctx), enumerable: false });
  return ctx;
}

// Load `files` (paths relative to the repo root) into a fresh context.
function loadScripts(files, globals) {
  const ctx = createContext(globals);
  for (const f of files) vm.runInContext(source(f), ctx, { filename: f });
  return ctx;
}

// Strip the context's prototypes so deepStrictEqual can compare.
function plain(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

// Wait until `check()` is truthy, polling with real timers.
async function waitFor(check, { timeout = 3000, what = "condition" } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

module.exports = { ROOT, TIME_SCALE, createContext, loadScripts, plain, waitFor, source };
