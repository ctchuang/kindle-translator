// Receives test screenshots from the extension (options page → 開發者 →
// 允許測試工具觸發「存下截圖」) and writes them to tests/fixtures/:
// <name>.jpg and <name>.json (where the book was drawn).
//
//   node tests/tools/receive-fixtures.js [dir]
//
// Then, in the Kindle reader tab (DevTools console or a test tool):
//   window.postMessage({ type: "kindle-translator-dev-capture", id: 1, name: "alice-ch1-p1" }, "*")
// and wait for a "kindle-translator-dev-capture-result" message back.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8765;
const dir = path.resolve(process.argv[2] || path.join(__dirname, "..", "fixtures"));

http
  .createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/fixture") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const { dataUrl, filename, info } = JSON.parse(Buffer.concat(chunks));
        const base = path.basename(filename).replace(/\.jpg$/, "");
        if (!/^[\w-]+$/.test(base) || !dataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("bad shot");
        const jpg = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
        fs.writeFileSync(path.join(dir, `${base}.jpg`), jpg);
        fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(info, null, 2) + "\n");
        console.log(`${base}.jpg ${jpg.length} bytes, viewport ${info.viewport?.width}×${info.viewport?.height}, dpr ${info.dpr}`);
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      } catch (err) {
        console.error(err.message);
        res.writeHead(400).end();
      }
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`receiving fixtures on 127.0.0.1:${PORT} → ${dir}`));
