// Fake Messages API for fetch("https://api.anthropic.com/v1/messages").
// Records every request and answers with a streamed (SSE) response built
// from what the test's handler returns.
//
// handler(req) gets { kind: "translate" | "review" | "vision", body, headers,
// items (the JSON array at the end of the prompt), n (call number) } and
// returns a reply:
//   { json }                     the structured answer (default per kind)
//   { model }                    model reported back (default: the requested one)
//   { stop_reason, stop_details }
//   { content }                  raw content blocks instead of json
//   { status, error }            a plain-JSON HTTP error
//   { streamError }              an `error` event mid-stream
//   { hang: true }               never answers; rejects when the signal aborts
//   { stallBody: true }          headers arrive, then the body never ends
//   { usage }
// Return undefined to get the default for that kind.

function kindOf(body) {
  const props = body.output_config?.format?.schema?.properties || {};
  if (props.translations) return "translate";
  if (props.corrections) return "review";
  if (props.blocks) return "vision";
  return "unknown";
}

// The prompts end with a blank line and the JSON input.
function itemsOf(body) {
  const text = body.messages[0].content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const at = text.lastIndexOf("\n\n");
  try {
    return JSON.parse(text.slice(at + 2));
  } catch (_) {
    return null;
  }
}

function defaultJson(req) {
  if (req.kind === "translate") {
    return { translations: req.items.map((p) => ({ id: p.id, text: `譯：${p.text}` })), notes: "", summarized: false };
  }
  if (req.kind === "review") return { corrections: [], notes: "" };
  if (req.kind === "vision") return { blocks: [], notes: "", summarized: false };
  return {};
}

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

// Split text so a block arrives over several deltas, and the SSE over
// several reads, as on the wire.
function chunks(str, n) {
  const size = Math.max(1, Math.ceil(str.length / n));
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out.length ? out : [""];
}

function streamResponse(events, { stall = false, signal } = {}) {
  const parts = chunks(sse(events), 3);
  const body = new ReadableStream({
    async pull(controller) {
      if (parts.length) controller.enqueue(new TextEncoder().encode(parts.shift()));
      else if (!stall) controller.close();
      else await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function eventsFor(reply, model) {
  const content =
    reply.content ?? [{ type: "text", text: JSON.stringify(reply.json) }];
  const events = [{ type: "message_start", message: { model, usage: { input_tokens: 100, ...reply.usage?.start } } }];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const t of chunks(block.text, 2)) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } });
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });
  if (reply.streamError) events.push({ type: "error", error: reply.streamError });
  events.push({
    type: "message_delta",
    delta: { stop_reason: reply.stop_reason ?? "end_turn", ...(reply.stop_details && { stop_details: reply.stop_details }) },
    usage: { output_tokens: 50, ...reply.usage?.end },
  });
  events.push({ type: "message_stop" });
  return events;
}

function createClaude(handler = () => undefined) {
  const calls = [];
  const api = {
    calls,
    handler,
    // Requests of one kind ("translate", "review", "vision").
    of: (kind) => calls.filter((c) => c.kind === kind),
    async fetch(url, init = {}) {
      if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(init.body);
      const req = { url, body, headers: init.headers, kind: kindOf(body), n: calls.length, signal: init.signal };
      req.items = itemsOf(body);
      calls.push(req);
      init.signal?.throwIfAborted();
      const reply = { ...(await api.handler(req)) };
      if (reply.hang) {
        return new Promise((_, reject) => {
          const abort = () => reject(init.signal.reason);
          if (init.signal.aborted) abort();
          else init.signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (reply.status && reply.status !== 200) {
        return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: reply.error || "boom" } }), {
          status: reply.status,
          statusText: "Error",
          headers: { "content-type": "application/json" },
        });
      }
      if (!reply.content && !reply.json) reply.json = defaultJson(req);
      return streamResponse(eventsFor(reply, reply.model ?? body.model), { stall: reply.stallBody, signal: init.signal });
    },
  };
  return api;
}

module.exports = { createClaude, kindOf, itemsOf, sse };
