// Detects page turns in Kindle Cloud Reader and tells the background worker.
// The reader re-renders the page area on every turn, so a debounced
// MutationObserver plus arrow-key / click hints is enough for a prototype.

let timer = null;

function notify(reason) {
  clearTimeout(timer);
  // Wait for the page-turn animation and image rendering to settle.
  timer = setTimeout(() => {
    try {
      chrome.runtime.sendMessage({ type: "pageTurned", reason });
    } catch (_) {
      // Extension was reloaded; this content script is orphaned.
    }
  }, 1200);
}

document.addEventListener(
  "keydown",
  (e) => {
    if (["ArrowLeft", "ArrowRight", "PageUp", "PageDown", " "].includes(e.key)) notify("key");
  },
  true
);

document.addEventListener("click", () => notify("click"), true);

document.addEventListener("wheel", () => notify("wheel"), { capture: true, passive: true });

new MutationObserver((mutations) => {
  // Ignore tiny changes (cursor blink, tooltips); react to real re-renders.
  let significant = 0;
  for (const m of mutations) {
    significant += m.addedNodes.length + m.removedNodes.length;
    if (m.type === "attributes" && (m.attributeName === "src" || m.attributeName === "style")) significant++;
  }
  if (significant >= 2) notify("dom");
}).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["src", "style"],
});
