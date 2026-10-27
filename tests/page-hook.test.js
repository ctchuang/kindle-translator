// page-hook.js: wraps the reader page's fetch and copies /renderer/render
// responses to the content script, without changing what the reader gets.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, waitFor } = require("./helpers/load");

function setup({ respond } = {}) {
  const calls = [];
  const posted = [];
  const ctx = loadScripts([], {
    location: { href: "https://read.amazon.com/?asin=B0X", origin: "https://read.amazon.com" },
    URL,
    Response,
  });
  ctx.window = ctx;
  ctx.fetch = function (input, init) {
    calls.push({ input, init, self: this });
    return respond ? respond(input, init) : Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  };
  const original = ctx.fetch;
  ctx.postMessage = (data, origin, transfer) => posted.push({ data, origin, transfer });
  ctx.importScripts("page-hook.js");
  return { ctx, calls, posted, original };
}

const RENDER = "https://read.amazon.com/renderer/render?version=3.0&asin=B0X&numPage=6";

test("replaces fetch, once even if injected twice", () => {
  const s = setup();
  assert.notEqual(s.ctx.fetch, s.original);
  const wrapped = s.ctx.fetch;
  s.ctx.importScripts("page-hook.js");
  assert.equal(s.ctx.fetch, wrapped);
  assert.equal(s.ctx.__kindleTranslatorHook, true);
});

test("a render response is copied to the page as an ArrayBuffer, transferred", async () => {
  const s = setup();
  const res = await s.ctx.fetch(RENDER, { credentials: "include" });
  await waitFor(() => s.posted.length, { what: "posted copy" });
  const [{ data, origin, transfer }] = s.posted;
  assert.equal(data.type, "kindle-translator-render");
  assert.equal(data.url, RENDER);
  assert.deepEqual([...new Uint8Array(data.buf)], [1, 2, 3]);
  assert.equal(origin, "https://read.amazon.com");
  assert.equal(transfer[0], data.buf);
  // The reader still reads its own response, untouched.
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
});

test("the reader's arguments and `this` pass through unchanged", async () => {
  const s = setup();
  const init = { method: "GET", headers: { a: "b" } };
  await s.ctx.fetch(RENDER, init);
  assert.equal(s.calls[0].input, RENDER);
  assert.equal(s.calls[0].init, init);
});

test("relative URLs, URL objects and Requests are recognised", async () => {
  const s = setup();
  await s.ctx.fetch("/renderer/render?asin=B0X");
  await s.ctx.fetch(new URL(RENDER));
  await s.ctx.fetch({ url: RENDER });
  await waitFor(() => s.posted.length === 3, { what: "three copies" });
  assert.equal(s.posted[0].data.url, "https://read.amazon.com/renderer/render?asin=B0X");
});

test("other requests aren't copied", async () => {
  const s = setup();
  for (const url of [
    "https://read.amazon.com/renderer/wordCount",
    "https://read.amazon.com/reader/api/csrf/getToken",
    "https://read.amazon.com/renderer/renderer?x",
    "https://cdn.example.com/b/fullbook/resource/rsrc1",
    "https://read.amazon.com/other?next=/renderer/render",
  ]) {
    await s.ctx.fetch(url);
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.posted.length, 0);
  assert.equal(s.calls.length, 5);
});

test("a failed render response isn't copied", async () => {
  const s = setup({ respond: () => Promise.resolve(new Response("nope", { status: 500 })) });
  const res = await s.ctx.fetch(RENDER);
  assert.equal(res.status, 500);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.posted.length, 0);
});

test("a rejected fetch rejects for the reader as before, and nothing is posted", async () => {
  const s = setup({ respond: () => Promise.reject(new TypeError("Failed to fetch")) });
  await assert.rejects(s.ctx.fetch(RENDER), /Failed to fetch/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.posted.length, 0);
});

test("a body that can't be read for the copy doesn't affect the reader", async () => {
  const s = setup({
    respond: () => {
      const res = new Response(new Uint8Array([9]));
      res.clone = () => {
        throw new Error("clone failed");
      };
      return Promise.resolve(res);
    },
  });
  const res = await s.ctx.fetch(RENDER);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [9]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.posted.length, 0);
});

test("an input that can't be read as a URL is passed through", async () => {
  const s = setup();
  await s.ctx.fetch(undefined);
  await s.ctx.fetch("http://[bad");
  assert.equal(s.calls.length, 2);
  assert.equal(s.posted.length, 0);
});
