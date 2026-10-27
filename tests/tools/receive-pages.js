// Receives page data from the extension (options page → 開發者 →
// 允許測試工具觸發「存下頁面資料」) and writes it as <name>.json: the screen
// the reader shows, as content.js keeps it, with the glyph outlines it uses.
// It holds the book's font, so keep it on this computer, out of the repo.
//
//   node tests/tools/receive-pages.js [dir]     (default: ./page-data)
//
// Then, in the Kindle reader tab (DevTools console or a test tool):
//   window.postMessage({ type: "kindle-translator-dev-capture", id: 1, name: "alice-ch1-p1" }, "*")
// and wait for a "kindle-translator-dev-capture-result" message back.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8765;
const dir = path.resolve(process.argv[2] || "page-data");
fs.mkdirSync(dir, { recursive: true });

http
  .createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/page") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const { filename, data } = JSON.parse(Buffer.concat(chunks));
        const base = path.basename(String(filename)).replace(/\.json$/, "");
        if (!/^[\w-]+$/.test(base) || !data?.page) throw new Error("bad page data");
        const json = JSON.stringify(data);
        fs.writeFileSync(path.join(dir, `${base}.json`), json);
        console.log(`${base}.json ${json.length} bytes, positions ${data.page.startPositionId}–${data.page.endPositionId}`);
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      } catch (err) {
        console.error(err.message);
        res.writeHead(400).end();
      }
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`receiving page data on 127.0.0.1:${PORT} → ${dir}`));
