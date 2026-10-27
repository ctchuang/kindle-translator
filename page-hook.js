// Runs in the reader page's own JavaScript world (manifest: "world": "MAIN",
// "run_at": "document_start") so it can wrap window.fetch before the reader
// uses it. The reader fetches its pages from /renderer/render; a copy of each
// response goes to the content script (content.js), which draws pages from
// it. Nothing else is touched, nothing extra is requested, and any failure
// here leaves the reader's own request as it was.

(() => {
  if (window.__kindleTranslatorHook) return;
  window.__kindleTranslatorHook = true;
  const MSG = "kindle-translator-render";
  const RENDER_RE = /\/renderer\/render(?:[?#]|$)/;
  const original = window.fetch;
  window.fetch = function (input, init) {
    const response = original.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      if (url && RENDER_RE.test(new URL(url, location.href).pathname)) {
        response
          .then((res) => (res.ok ? res.clone().arrayBuffer() : null))
          .then((buf) => {
            if (buf) window.postMessage({ type: MSG, url: new URL(url, location.href).href, buf }, location.origin, [buf]);
          })
          .catch(() => {});
      }
    } catch (_) {
      // Never let the copy get in the way of the reader's request.
    }
    return response;
  };
})();
