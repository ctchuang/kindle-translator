// callClaude and readStream against the fake Messages API.

const test = require("node:test");
const assert = require("node:assert/strict");
const { plain } = require("./helpers/load");
const { startExtension } = require("./helpers/extension");

const SCHEMA = { type: "object", properties: { translations: { type: "array" } } };

function call(ext, opts = {}, settings = { apiKey: "sk-ant-test" }) {
  return ext.ctx.callClaude(settings, {
    model: "claude-haiku-5-5",
    effort: "low",
    schema: SCHEMA,
    content: [{ type: "text", text: "prompt\n\n[]" }],
    signal: new AbortController().signal,
    ...opts,
  });
}

test("sends a streamed, structured request with the browser-access header", async () => {
  const ext = startExtension({ panel: false });
  await call(ext, { thinking: { type: "disabled" } });
  const [req] = ext.claude.calls;
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.headers["x-api-key"], "sk-ant-test");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.equal(req.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(req.headers["anthropic-beta"], undefined);
  assert.deepEqual(req.body, {
    model: "claude-haiku-5-5",
    max_tokens: 16000,
    stream: true,
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: [{ type: "text", text: "prompt\n\n[]" }] }],
  });
});

test("no thinking field unless one is given", async () => {
  const ext = startExtension({ panel: false });
  await call(ext);
  assert.equal("thinking" in ext.claude.calls[0].body, false);
});

test("fallbacks add the beta header and the fallback list", async () => {
  const ext = startExtension({ panel: false });
  const FALLBACK = plain(ext.ctx.run("FALLBACK"));
  await call(ext, { fallbacks: ext.ctx.run("FALLBACK") });
  const [req] = ext.claude.calls;
  assert.equal(req.headers["anthropic-beta"], FALLBACK.beta);
  assert.deepEqual(req.body.fallbacks, FALLBACK.fallbacks);
});

test("returns the parsed JSON and the model that answered", async () => {
  const ext = startExtension({ panel: false, claude: () => ({ json: { translations: [{ id: 0, text: "嗨" }] }, model: "claude-opus-5" }) });
  const out = plain(await call(ext));
  assert.deepEqual(out, { translations: [{ id: 0, text: "嗨" }], model: "claude-opus-5" });
});

test("reassembles text split over many deltas and reads", async () => {
  const long = { translations: Array.from({ length: 50 }, (_, id) => ({ id, text: `段落 ${id} `.repeat(20) })) };
  const ext = startExtension({ panel: false, claude: () => ({ json: long }) });
  assert.deepEqual(plain(await call(ext)).translations, long.translations);
});

test("a fallback block mid-stream is logged and the continuation parsed", async () => {
  const ext = startExtension({
    claude: () => ({
      model: "claude-opus-5",
      content: [{ type: "text", text: '{"translations":[{"id":0,' }, { type: "fallback" }, { type: "text", text: '{"translations":[]}' }],
    }),
  });
  assert.deepEqual(plain(await call(ext)), { translations: [], model: "claude-opus-5" });
  await ext.tick();
  assert.ok(ext.hasLog(/此段被拒，改由備援模型接手/));
});

test("logs usage from the stream", async () => {
  const ext = startExtension({ claude: () => ({ usage: { start: { input_tokens: 1234 }, end: { output_tokens: 56 } } }) });
  await call(ext);
  await ext.tick();
  assert.ok(ext.hasLog(/tokens 輸入 1234 \/ 輸出 56/));
});

test("a log tag prefixes every line of a call", async () => {
  const ext = startExtension();
  await call(ext, { tag: "[1/2] " });
  await ext.tick();
  const own = ext.logs().filter((l) => /API|串流|回應/.test(l));
  assert.ok(own.length >= 3);
  for (const l of own) assert.match(l, /^\[1\/2\] /);
});

for (const [status, re] of [
  [401, /API key 無效（401）/],
  [429, /請求太頻繁或額度不足（429）/],
  [500, /Claude API 錯誤 500：kaput/],
  [529, /Claude API 錯誤 529：kaput/],
]) {
  test(`HTTP ${status} becomes a readable error`, async () => {
    const ext = startExtension({ panel: false, claude: () => ({ status, error: "kaput" }) });
    await assert.rejects(call(ext), re);
  });
}

test("a refusal is explained", async () => {
  const ext = startExtension({ panel: false, claude: () => ({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }) });
  await assert.rejects(call(ext), /Claude 拒絕處理這一頁。\n類別：網路安全（cyber）/);
});

test("max_tokens is reported as a truncated page", async () => {
  const ext = startExtension({ panel: false, claude: () => ({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"tr' }] }) });
  await assert.rejects(call(ext), /輸出被截斷（max_tokens）/);
});

test("unparsable JSON is reported", async () => {
  const ext = startExtension({ panel: false, claude: () => ({ content: [{ type: "text", text: "not json" }] }) });
  await assert.rejects(call(ext), /無法解析 Claude 回傳的 JSON/);
});

test("an error event in the stream is reported as is", async () => {
  const ext = startExtension({ panel: false, claude: () => ({ streamError: { type: "overloaded_error", message: "Overloaded" } }) });
  await assert.rejects(call(ext), /Claude API 串流錯誤：Overloaded/);
});

test("a network failure says the API can't be reached", async () => {
  const ext = startExtension({
    panel: false,
    claude: () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(call(ext), /連不上 Claude API：Failed to fetch/);
});

test("a request with no response times out", async () => {
  const ext = startExtension({ panel: false, claude: () => ({ hang: true }) });
  await assert.rejects(call(ext), /等候 Claude 回應超過 180 秒，已中止。/);
});

test("a body that stops arriving times out too", async () => {
  const ext = startExtension({ panel: false, claude: () => ({ stallBody: true }) });
  await assert.rejects(call(ext), /等候 Claude 回應超過 180 秒/);
});

test("cancelling the job aborts the request with an AbortError", async () => {
  const ext = startExtension({ panel: false, claude: () => ({ hang: true }) });
  const controller = new AbortController();
  const p = call(ext, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(p, { name: "AbortError" });
});

test("cancelling mid-stream aborts too", async () => {
  const ext = startExtension({ panel: false, claude: () => ({ stallBody: true }) });
  const controller = new AbortController();
  const p = call(ext, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(p, { name: "AbortError" });
});

test("an already cancelled job sends nothing", async () => {
  const ext = startExtension({ panel: false });
  await assert.rejects(call(ext, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(ext.claude.calls.length, 0);
});
