// In-memory stand-in for the parts of the chrome.* API the extension uses.
// Tests reach into `chrome._` to wire up the other side (the page's content
// script, the offscreen document, the active tab) and to inspect what was sent.

const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./load");

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    // Calls every listener; returns their return values.
    dispatch: (...args) => listeners.map((fn) => fn(...args)),
  };
}

// chrome.storage.<area>: values are cloned in and out, like Chrome's
// serialization, and changes fire chrome.storage.onChanged.
function makeArea(name, onChanged, initial = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  const changed = (changes) => {
    if (Object.keys(changes).length) onChanged.dispatch(changes, name);
  };
  const area = {
    data,
    async get(keys) {
      const out = {};
      if (keys == null) {
        for (const [k, v] of data) out[k] = structuredClone(v);
      } else if (typeof keys === "string" || Array.isArray(keys)) {
        for (const k of [keys].flat()) if (data.has(k)) out[k] = structuredClone(data.get(k));
      } else {
        for (const [k, def] of Object.entries(keys)) out[k] = data.has(k) ? structuredClone(data.get(k)) : def;
      }
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data.get(k), newValue: structuredClone(v) };
        data.set(k, structuredClone(v));
      }
      changed(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [keys].flat()) {
        if (!data.has(k)) continue;
        changes[k] = { oldValue: data.get(k) };
        data.delete(k);
      }
      changed(changes);
    },
    async clear() {
      await area.remove([...data.keys()]);
    },
  };
  return area;
}

// A runtime.Port pair: what one side posts, the other side's onMessage gets.
// With `async`, delivery waits a tick as in Chrome, so a listener added right
// after connect() still hears what the other side posted on connect.
function makePortPair(name, async = false) {
  const deliver = async ? (fn) => setTimeout(fn) : (fn) => fn();
  const a = { name, onMessage: makeEvent(), onDisconnect: makeEvent(), sent: [] };
  const b = { name, onMessage: makeEvent(), onDisconnect: makeEvent(), sent: [] };
  a.postMessage = (msg) => {
    a.sent.push(msg);
    const copy = structuredClone(msg);
    deliver(() => b.onMessage.dispatch(copy, b));
  };
  b.postMessage = (msg) => {
    b.sent.push(msg);
    const copy = structuredClone(msg);
    deliver(() => a.onMessage.dispatch(copy, a));
  };
  a.disconnect = () => b.onDisconnect.dispatch(b);
  b.disconnect = () => a.onDisconnect.dispatch(a);
  return [a, b];
}

function createChrome({ sync = {}, session = {}, local = {}, runtimeId = "test-extension-id", asyncPorts = false } = {}) {
  const onChanged = makeEvent();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

  // Hooks the tests fill in.
  const _ = {
    // The active tab chrome.tabs.query returns, or null for none.
    activeTab: { id: 1, windowId: 1, url: "https://read.amazon.com/?asin=B0TESTBOOK", active: true },
    // What captureVisibleTab returns: a data URL, or a function of windowId.
    screen: null,
    captures: 0,
    // (tabId, msg, options) => reply, for chrome.tabs.sendMessage.
    tabMessageHandler: null,
    tabMessages: [],
    // (msg) => reply, for chrome.runtime.sendMessage (the offscreen document).
    runtimeMessageHandler: null,
    runtimeMessages: [],
    contexts: { SIDE_PANEL: 0, OFFSCREEN_DOCUMENT: 0 },
    executed: [],
    offscreenCreated: 0,
    optionsOpened: 0,
    platformInfoCalls: 0,
    // Ports the extension side received from runtime.connect (e.g. the side panel's).
    connectPorts: [],
  };

  const chrome = {
    _,
    storage: {
      onChanged,
      sync: makeArea("sync", onChanged, sync),
      session: makeArea("session", onChanged, session),
      local: makeArea("local", onChanged, local),
    },
    runtime: {
      id: runtimeId,
      onInstalled: makeEvent(),
      onConnect: makeEvent(),
      onMessage: makeEvent(),
      lastError: undefined,
      getManifest: () => structuredClone(manifest),
      getURL: (p) => `chrome-extension://${runtimeId}/${p}`,
      async getContexts({ contextTypes }) {
        return contextTypes.flatMap((t) => Array.from({ length: _.contexts[t] || 0 }, () => ({ contextType: t })));
      },
      async getPlatformInfo() {
        _.platformInfoCalls++;
        return { os: "mac", arch: "arm" };
      },
      async sendMessage(msg) {
        _.runtimeMessages.push(msg);
        if (!_.runtimeMessageHandler) throw new Error("Could not establish connection. Receiving end does not exist.");
        return _.runtimeMessageHandler(structuredClone(msg));
      },
      // From a page (side panel): returns its end; the worker's end goes to onConnect.
      connect({ name }) {
        const [mine, theirs] = makePortPair(name, asyncPorts);
        _.connectPorts.push(theirs);
        chrome.runtime.onConnect.dispatch(theirs);
        return mine;
      },
      openOptionsPage() {
        _.optionsOpened++;
      },
    },
    tabs: {
      async query() {
        return _.activeTab ? [structuredClone(_.activeTab)] : [];
      },
      async get(tabId) {
        return { ..._.activeTab, id: tabId };
      },
      async captureVisibleTab(windowId) {
        _.captures++;
        const s = typeof _.screen === "function" ? _.screen(windowId) : _.screen;
        if (!s) throw new Error("No screen to capture");
        return s;
      },
      async sendMessage(tabId, msg, options) {
        _.tabMessages.push({ tabId, msg: structuredClone(msg), options });
        if (!_.tabMessageHandler) throw new Error("Could not establish connection. Receiving end does not exist.");
        return _.tabMessageHandler(tabId, structuredClone(msg), options);
      },
    },
    scripting: {
      async executeScript(details) {
        _.executed.push(details);
        return [];
      },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    commands: { onCommand: makeEvent() },
    offscreen: {
      async createDocument() {
        _.offscreenCreated++;
        _.contexts.OFFSCREEN_DOCUMENT = 1;
      },
    },
  };
  return chrome;
}

module.exports = { createChrome, makeEvent, makePortPair };
