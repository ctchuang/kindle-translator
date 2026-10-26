// A small fake DOM, just enough for content.js, sidepanel.js and options.js.
// `loadPage` runs scripts in a vm context whose global object is also
// `window`, as in a browser, so bare `innerWidth` and `window.top === window`
// behave.
//
// Layout model (for content.js's fitText): an element's style width/height in
// px is its border-box size, and clientWidth/clientHeight equal it (no
// borders). Text is laid out as full-width glyphs: every character is
// `fontSize` px wide and each line is `lineHeight` tall. "pre" / "nowrap"
// never wraps; anything else wraps at the content width (minus padding).

const vm = require("node:vm");
const { TIME_SCALE, createContext, source } = require("./load");

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

// ---- Events ----

class Event {
  constructor(type, init = {}) {
    Object.assign(this, init);
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.defaultPrevented = false;
    this._stop = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stop = true;
  }
  stopImmediatePropagation() {
    this._stop = true;
  }
}

// Mixed into elements, the document and the window (the vm global).
function eventTarget(obj) {
  const listeners = [];
  Object.defineProperty(obj, "_listeners", { value: listeners, enumerable: false });
  obj.addEventListener = (type, fn, opts) => {
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    if (!listeners.some((l) => l.type === type && l.fn === fn && l.capture === capture)) {
      listeners.push({ type, fn, capture, once: !!opts?.once });
    }
  };
  obj.removeEventListener = (type, fn, opts) => {
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (i >= 0) listeners.splice(i, 1);
  };
  obj.dispatchEvent = (event) => dispatch(obj, event);
  return obj;
}

function invoke(node, event, phase) {
  event.currentTarget = node;
  for (const l of [...node._listeners]) {
    if (l.type !== event.type) continue;
    if (phase === "capture" && !l.capture) continue;
    if (phase === "bubble" && l.capture) continue;
    if (l.once) node.removeEventListener(l.type, l.fn, l.capture);
    l.fn.call(node, event);
  }
  // onclick / onchange… run with the bubbling listeners.
  const handler = node[`on${event.type}`];
  if (phase !== "capture" && typeof handler === "function") handler.call(node, event);
}

// Capture from the window down, the target, then bubble back up.
function dispatch(target, event) {
  if (!(event instanceof Event)) event = Object.assign(new Event(event.type), event);
  event.target = target;
  const path = [];
  for (let n = target; n; n = n.parentNode ?? (n.nodeType === 9 ? n.defaultView : null)) path.push(n);
  for (let i = path.length - 1; i > 0 && !event._stop; i--) invoke(path[i], event, "capture");
  if (!event._stop) {
    // At the target, capture listeners run first, then the rest.
    invoke(target, event, "capture");
    if (!event._stop) invoke(target, event, "bubble");
  }
  if (event.bubbles) for (let i = 1; i < path.length && !event._stop; i++) invoke(path[i], event, "bubble");
  return !event.defaultPrevented;
}

// ---- Nodes ----

class Text {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentNode = null;
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
  remove() {
    this.parentNode?._removeChild(this);
  }
  contains(n) {
    return n === this;
  }
}

class ClassList {
  constructor(el) {
    this.el = el;
  }
  _list() {
    return this.el.className.split(/\s+/).filter(Boolean);
  }
  _set(list) {
    this.el.className = list.join(" ");
  }
  contains(c) {
    return this._list().includes(c);
  }
  add(...cs) {
    this._set([...new Set([...this._list(), ...cs])]);
  }
  remove(...cs) {
    this._set(this._list().filter((c) => !cs.includes(c)));
  }
  toggle(c, force) {
    const on = force ?? !this.contains(c);
    if (on) this.add(c);
    else this.remove(c);
    return on;
  }
}

function px(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

class Element {
  constructor(tagName, doc) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.classList = new ClassList(this);
    this.hidden = false;
    this.title = "";
    this.scrollTop = 0;
    if (this.localName === "input") {
      this.checked = false;
      this.type = "text";
      this._value = "";
    }
    eventTarget(this);
  }

  // -- attributes --
  get id() {
    return this.attributes.get("id") ?? "";
  }
  set id(v) {
    this.attributes.set("id", String(v));
  }
  get className() {
    return this.attributes.get("class") ?? "";
  }
  set className(v) {
    this.attributes.set("class", String(v));
  }
  setAttribute(name, value) {
    name = name.toLowerCase();
    value = String(value);
    this.attributes.set(name, value);
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    if (name === "hidden") this.hidden = true;
    if (name === "checked") this.checked = true;
    if (name === "type" && this.localName === "input") this.type = value;
    if (name === "value" && this.localName === "input") this._value = value;
    if (name === "title") this.title = value;
  }
  getAttribute(name) {
    const v = this.attributes.get(name.toLowerCase());
    return v === undefined ? null : v;
  }
  hasAttribute(name) {
    return this.attributes.has(name.toLowerCase());
  }
  removeAttribute(name) {
    this.attributes.delete(name.toLowerCase());
  }

  // -- form controls --
  get value() {
    if (this.localName === "select") return this.options[this.selectedIndex]?.value ?? "";
    if (this.localName === "option") return this.getAttribute("value") ?? this.textContent;
    return this._value ?? "";
  }
  set value(v) {
    v = String(v);
    // Like a real <select>: a value with no matching option selects nothing.
    if (this.localName === "select") this._selectedIndex = this.options.findIndex((o) => o.value === v);
    else this._value = v;
  }
  get options() {
    return this.querySelectorAll("option");
  }
  get selectedIndex() {
    if (this._selectedIndex === undefined) return this.options.length ? 0 : -1;
    return this._selectedIndex;
  }
  set selectedIndex(i) {
    this._selectedIndex = i;
  }

  // -- tree --
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get childElementCount() {
    return this.children.length;
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get parentElement() {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.nodeType === 9;
  }
  _adopt(node) {
    if (typeof node === "string") node = new Text(node);
    node.parentNode?._removeChild(node);
    node.parentNode = this;
    return node;
  }
  _removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
  }
  append(...nodes) {
    for (const n of nodes) this.childNodes.push(this._adopt(n));
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  prepend(...nodes) {
    this.childNodes.unshift(...nodes.map((n) => this._adopt(n)));
  }
  replaceChildren(...nodes) {
    for (const n of [...this.childNodes]) this._removeChild(n);
    this.append(...nodes);
  }
  remove() {
    this.parentNode?._removeChild(this);
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(v) {
    this.replaceChildren();
    if (v !== "" && v != null) this.append(String(v));
  }
  get innerHTML() {
    return this.childNodes.map(serialize).join("");
  }
  set innerHTML(html) {
    this.replaceChildren();
    parseInto(this, String(html), this.ownerDocument);
  }
  click() {
    return dispatch(this, new Event("click"));
  }

  // -- queries --
  _descendants() {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    const groups = sel.split(",").map((s) => s.trim());
    return this._descendants().filter((el) => groups.some((g) => matchesSelector(el, g, this)));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  matches(sel) {
    return sel.split(",").some((g) => matchesSelector(this, g.trim(), null));
  }
  closest(sel) {
    for (let n = this; n?.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n;
    return null;
  }

  // -- layout (see the model at the top of the file) --
  get clientWidth() {
    return px(this.style.width);
  }
  get clientHeight() {
    return px(this.style.height);
  }
  _textSize() {
    const text = this.textContent;
    const font = px(this.style.fontSize);
    if (!text || !font) return { width: 0, height: 0 };
    const pad = px(this.style.padding);
    const lh = String(this.style.lineHeight || "1.2");
    const lineH = lh.endsWith("px") ? px(lh) : px(lh) * font;
    const ws = this.style.whiteSpace || "normal";
    const avail = Math.max(0, this.clientWidth - 2 * pad);
    const paragraphs = text.split("\n").map((p) => [...p].length);
    let lines;
    let width;
    if (ws === "pre" || ws === "nowrap") {
      lines = paragraphs.length;
      width = Math.max(...paragraphs) * font;
    } else {
      // At least one glyph per line, even when it overflows sideways.
      const perLine = Math.max(1, Math.floor(avail / font));
      lines = paragraphs.reduce((s, n) => s + Math.max(1, Math.ceil(n / perLine)), 0);
      width = Math.min(Math.max(...paragraphs), perLine) * font;
    }
    return { width: width + 2 * pad, height: lines * lineH + 2 * pad };
  }
  get scrollWidth() {
    return Math.max(this.clientWidth, this._textSize().width);
  }
  get scrollHeight() {
    return Math.max(this.clientHeight, this._textSize().height);
  }
  getBoundingClientRect() {
    const left = px(this.style.left);
    const top = px(this.style.top);
    return { left, top, x: left, y: top, width: this.clientWidth, height: this.clientHeight, right: left + this.clientWidth, bottom: top + this.clientHeight };
  }
}

function serialize(n) {
  if (n.nodeType === 3) return n.data;
  const attrs = [...n.attributes].map(([k, v]) => ` ${k}="${v}"`).join("");
  return VOID.has(n.localName) ? `<${n.localName}${attrs} />` : `<${n.localName}${attrs}>${n.innerHTML}</${n.localName}>`;
}

// ---- Selectors: tag, #id, .class, [attr] / [attr="v"], joined by spaces ----

function parseCompound(s) {
  const m = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]|(\*)/g;
  let t;
  while ((t = re.exec(s))) {
    if (t[1]) m.tag = t[1].toLowerCase();
    else if (t[2]) m.id = t[2];
    else if (t[3]) m.classes.push(t[3]);
    else if (t[4]) m.attrs.push([t[4].toLowerCase(), t[5]]);
  }
  return m;
}

function matchesCompound(el, m) {
  if (m.tag && el.localName !== m.tag) return false;
  if (m.id && el.id !== m.id) return false;
  if (m.classes.some((c) => !el.classList.contains(c))) return false;
  return m.attrs.every(([k, v]) => (v === undefined ? el.hasAttribute(k) : el.getAttribute(k) === v));
}

// Descendant combinators only; ancestors are searched up to (not past) `scope`.
function matchesSelector(el, sel, scope) {
  const parts = sel.split(/\s+/).filter(Boolean).map(parseCompound);
  if (!matchesCompound(el, parts.at(-1))) return false;
  let n = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (n && n !== scope && !(n.nodeType === 1 && matchesCompound(n, parts[i]))) n = n.parentNode;
    if (!n || n === scope) return false;
    n = n.parentNode;
  }
  return true;
}

// ---- HTML parsing (enough for the extension's own pages) ----

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) => s.replace(/&(\w+);/g, (all, name) => ENTITIES[name] ?? all);

function parseInto(parent, html, doc) {
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=\/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/gi;
  const stack = [parent];
  let t;
  while ((t = re.exec(html))) {
    const top = stack.at(-1);
    if (t[4] !== undefined) top.append(decode(t[4]));
    else if (t[1]) {
      const name = t[1].toLowerCase();
      const i = stack.findLastIndex((el) => el.localName === name);
      if (i > 0) stack.length = i;
    } else if (t[2]) {
      const name = t[2].toLowerCase();
      const el = doc.createElement(name);
      const attrRe = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = attrRe.exec(t[3] || ""))) el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ""));
      top.append(el);
      // Scripts are loaded by the test, and styles don't matter here.
      if (name === "script" || name === "style") {
        const end = html.toLowerCase().indexOf(`</${name}`, re.lastIndex);
        re.lastIndex = end < 0 ? html.length : html.indexOf(">", end) + 1;
      } else if (!VOID.has(name)) stack.push(el);
    }
  }
}

function createDocument(html = "<html><head></head><body></body></html>") {
  const doc = { nodeType: 9, parentNode: null, defaultView: null };
  eventTarget(doc);
  doc.createElement = (tag) => new Element(tag, doc);
  doc.createTextNode = (s) => new Text(s);
  const holder = new Element("#root", doc);
  parseInto(holder, html, doc);
  let htmlEl = holder.children.find((c) => c.localName === "html");
  if (!htmlEl) {
    htmlEl = new Element("html", doc);
    const body = new Element("body", doc);
    body.append(...holder.childNodes);
    htmlEl.append(body);
  }
  htmlEl.parentNode = doc;
  doc.documentElement = htmlEl;
  doc.childNodes = [htmlEl];
  doc.contains = (n) => n === doc || htmlEl.contains(n);
  Object.defineProperty(doc, "head", { get: () => htmlEl.querySelector("head") });
  Object.defineProperty(doc, "body", { get: () => htmlEl.querySelector("body") });
  doc.getElementById = (id) => (htmlEl.id === id ? htmlEl : htmlEl._descendants().find((el) => el.id === id) ?? null);
  doc.querySelectorAll = (sel) => [htmlEl, ...htmlEl._descendants()].filter((el) => sel.split(",").some((g) => matchesSelector(el, g.trim(), doc)));
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] ?? null;
  return doc;
}

// ---- A page: document + window (the vm global) + scripts ----

// MutationObservers never fire on their own: tests describe the mutations
// with `page.mutate(records)`.
function makeMutationObserver(registry) {
  return class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
    }
    observe(target, options) {
      this.targets.push({ target, options });
      if (!registry.includes(this)) registry.push(this);
    }
    disconnect() {
      const i = registry.indexOf(this);
      if (i >= 0) registry.splice(i, 1);
      this.targets = [];
    }
    takeRecords() {
      return [];
    }
  };
}

// Load `files` into a page. `html` is a repo file name ("sidepanel.html") or
// markup. `top` is another page's window, to make this page an iframe.
function loadPage(files, { chrome, html, innerWidth = 1000, innerHeight = 800, top, globals = {} } = {}) {
  const markup = html && /\.html$/.test(html) ? source(html) : html;
  const document = createDocument(markup);
  const observers = [];
  const frames = [];
  const timers = new Set();
  const track = (handle) => (timers.add(handle), handle);
  const ctx = createContext({
    chrome,
    document,
    innerWidth,
    innerHeight,
    Event,
    MutationObserver: makeMutationObserver(observers),
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame: () => {},
    // Same speed-up as load.js, but remembered so `close()` can stop them.
    setTimeout: (cb, ms = 0, ...args) => track(setTimeout(cb, Math.max(0, ms / TIME_SCALE), ...args)),
    setInterval: (cb, ms = 0, ...args) => track(setInterval(cb, Math.max(1, ms / TIME_SCALE), ...args)),
    ...globals,
  });
  ctx.window = ctx;
  ctx.top = top ?? ctx;
  ctx.parent = ctx.top;
  document.defaultView = ctx;
  eventTarget(ctx);
  // Delivered as a task, like the real thing.
  // The sender is taken to be this window itself (a page script or content
  // script posting to its own window); a frame posting to its top window
  // shows up as the top window too, which no script here tells apart.
  ctx.postMessage = (data) => {
    const clone = structuredClone(data);
    // `window` as the scripts see it: vm's global proxy, not the sandbox object.
    const source = vm.runInContext("window", ctx);
    setTimeout(() => dispatch(ctx, new Event("message", { data: clone, source, bubbles: false })), 0);
  };
  ctx.location ??= { origin: "https://read.amazon.com", href: "https://read.amazon.com/?asin=B0TESTBOOK" };
  for (const f of files) vm.runInContext(source(f), ctx, { filename: f });

  return {
    ctx,
    window: ctx,
    document,
    $: (id) => document.getElementById(id),
    observers,
    // Run one animation frame's callbacks (those queued during it wait for the next).
    frame() {
      for (const cb of frames.splice(0)) cb(performance.now());
    },
    pendingFrames: () => frames.length,
    // Deliver mutation records to every observer.
    mutate(records) {
      for (const o of [...observers]) o.callback(records, o);
    },
    // Fire an event at `target` (an element, the document or the window).
    fire(target, type, init = {}) {
      return dispatch(target, new Event(type, init));
    },
    resize(width, height) {
      ctx.innerWidth = width;
      ctx.innerHeight = height;
      return dispatch(ctx, new Event("resize", { bubbles: false }));
    },
    // Stop the page's timers so the test process can exit.
    close() {
      for (const h of timers) clearTimeout(h);
      timers.clear();
    },
  };
}

module.exports = { Event, Element, Text, createDocument, dispatch, loadPage };
