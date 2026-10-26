[繁體中文](README.md) | **English**

# Kindle Auto-Translate (Chrome extension)

Captures the page currently shown in Kindle Cloud Reader (read.amazon.com and others), reads the text with local OCR (Tesseract) and finds paragraphs and figures with the DocLayout-YOLO layout model, and has Claude Haiku translate it into Traditional Chinese, with Sonnet reviewing the translation. The translation is drawn directly over the original text on the page, and also shown in Chrome's side panel.

![Example: a two-page spread of Build a Reasoning Model (From Scratch), with the body text and captions translated in place and figures 1.1 and 1.2 left as they are, and the side panel on the right](docs/example.png)

> **Current version 1.0.0.** Tested on Kindle Cloud Reader's two-page layout: the translation covers the original text about 10 seconds after a page turn. When the overlay doesn't appear, the side panel's status line shows the reason in red, and the log below it shows each step.

The extension's interface is in Chinese; the labels quoted below are followed by their English meaning. The target language can be changed in the options page.

## Detecting the layout with a vision model

Kindle Cloud Reader shows pages as images, with no text or layout to read, so the extension works from screenshots. OCR alone only says where each line of text is: it can't tell which lines form a paragraph, which line is a heading, or which words are actually labels inside a figure.

So from 1.0 the extension runs a vision model, [DocLayout-YOLO](https://github.com/opendatalab/DocLayout-YOLO), in the browser to detect the layout. It's an object-detection model trained on document pages, and it draws boxes around:

- paragraphs, headings, headers and footers
- figures and figure captions
- tables, table captions and table footnotes
- formulas and formula captions

The extension then puts each OCR line into the box it falls in:

- Lines in the same box become one paragraph, so paragraphs and headings follow the book's own layout.
- Text inside figures, tables and formulas isn't translated, so the original figure shows instead of being covered with translated labels.
- Captions and headings get boxes of their own, so their size and position don't mix with the body text.

The model runs on your GPU through [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (WebGPU), in about 0.25 seconds for a two-page spread, and the screenshot never leaves your computer. The model file is 75 MB; it's downloaded from Hugging Face on the first translation and kept in the browser. The approach follows the PDF translator [BabelDOC](https://github.com/funstory-ai/BabelDOC).

## Install

1. Download `kindle-translate.zip` from [Releases](https://github.com/ctchuang/kindle-translator/releases/latest).
2. Unzip `kindle-translate.zip` to get the `kindle-translate` folder.
3. Open `chrome://extensions` and turn on "Developer mode" in the top right.
4. Click "Load unpacked" and choose the `kindle-translate` folder.
5. In the extension's "Details → Extension options", enter an Anthropic API key (create one at console.anthropic.com) and save.

## Usage

1. Open Kindle Cloud Reader and open a book.
2. Click the extension's icon in the toolbar to open the side panel.
3. Click 「翻譯這一頁」 (translate this page) or press Alt+T. With 「翻頁自動翻譯」 (translate on page turn) checked, a page is translated about 1 second after you turn to it. When the current page is already translated and the screen hasn't changed, the button becomes 「重新翻譯本頁」 (retranslate this page) and skips the cache.
4. The translation covers the book's paragraphs in place (font size fitted to each box, colors matched to the reader theme). The side panel's 「書頁顯示：譯文｜原文」 (page shows: translation | original) switch, or the small 「顯示原文／顯示譯文」 (show original / show translation) button in the page's bottom-right corner, or Alt+O, toggles between them at any time; switching back to the translation is instant, with no new request. Turning or clicking the page clears the overlay until the new page is translated.
5. The newest page's translation is at the top of the side panel, with a 「複製」 (copy) button.

## How it works and caveats

- Pages are only translated automatically while the side panel is open, so no API credit is spent in the background.
- A page is identified by a coarse fingerprint of its text area in the screenshot (excluding the title bar, progress bar and page arrows; shrunk to black and white and matched approximately, so the toolbar or hover effects don't count as a page turn), so the same page is never sent twice; going back to a translated page uses the cache (cleared when the browser closes). Translation starts about 1.2 seconds after the last page turn, so pages flipped past quickly are never sent. If you turn the page mid-translation, that page finishes in the background and goes into the cache (one page at most; beyond that the oldest is cancelled) while the new page starts right away; turning back to a page still translating in the background waits for it instead of sending it again.
- The options page's 「翻譯方式」 (translation mode) has three choices:
  - **1. Fast**: Tesseract.js reads the text and its position in the browser (a two-page spread is first split into columns at the blank gutter), while the DocLayout-YOLO layout model finds paragraphs, headings, captions, figures and tables on the GPU (WebGPU): text inside figures, tables and formulas stays in the original, the rest is grouped into paragraphs by the model's blocks, and only the text is sent to Claude Haiku 5.5. On a two-page spread both columns are sent in parallel. About 9 seconds per page (OCR about 3) and about 0.1 US cent; the screenshot never leaves your computer. Only the English OCR model is bundled for now.
  - **2. Polished (default)**: as 1, then Sonnet 5.5 reviews Haiku's translation, returning only the paragraphs it changes; the changes are listed in the side panel's log. In testing the review took 2–3 seconds per column, about 10 seconds for the page, at about 1 cent per page.
  - In 1 and 2 a column is occasionally declined on copyright grounds; that column is then translated as text by Opus 5.5 instead (without a review), about 15 seconds for the page.
  - **3. Read the image**: the screenshot goes straight to Claude Opus 5.5, which finds the paragraphs and translates them, and can handle books in other languages. 20+ seconds per page, effort defaults to low. In testing, Sonnet 5.5 and Haiku 5.5 declined book-page screenshots on copyright grounds, so this mode uses Opus only. When a safety classifier declines Opus 5.5, the request is retried on Opus 5, then Opus 4.8.
- The only server contacted is api.anthropic.com. The API key is kept in Chrome sync storage.
- In Opus mode the screenshot is scaled to at most 2576 px on the long edge and 3.7 MP in total before sending; anything larger gets scaled again by the API and the coordinates no longer line up.
- Claude occasionally returns a summary instead of a translation, citing copyright. A summary triggers one automatic retry; if it is still a summary it is shown and labelled 「摘要」 (summary), but not cached.
- Positions are per paragraph, not per line, and boxes are occasionally a little off. In OCR mode paragraphs follow DocLayout-YOLO's blocks; only lines the model doesn't cover (such as a line cut off at the page edge) are split by indentation, line spacing and short lines.
- The DocLayout-YOLO model file is 75 MB. It's downloaded from Hugging Face on the first translation, verified, and kept in the browser; the first page waits for the download, with progress in the side panel. WebGPU is required. If the model can't run there is no fallback: the side panel shows the error in red and the page isn't translated.
- Recognition gets worse when the book text is small; enlarge the reader font or the window.
- This translates page by page for your own reading. Don't use it to export book content in bulk; that violates Amazon's terms of use.

## Release notes

- **1.0.0**: the DocLayout-YOLO layout model (WebGPU) now finds paragraphs, headings, captions, figures and tables, replacing the guesswork from indentation, line spacing and word gaps; text inside figures, tables and formulas stays in the original. The model is downloaded on first use (75 MB) and kept in the browser; if it can't run, the extension reports an error instead of falling back. The side panel shows the model's status.
- **0.6.3**: the default translation mode is now 2. Polished (Haiku translates, Sonnet reviews).
- **0.6.2**: fixed the translation often flipping back to English, sometimes for good.
  - Pages are recognized by a coarse fingerprint matched approximately, so the toolbar, hover effects and JPEG noise no longer count as a page turn.
  - After hiding the overlay, the screenshot waits for the page to actually repaint, so OCR no longer reads leftover translation as garbage.
  - The first page-turn message after Chrome stops the idle background worker is no longer dropped.
  - Resize events fired by the toolbar no longer hide the overlay; after reloading the extension, the old page scripts no longer interfere.
  - The log shows the difference percentage of each comparison, scrolls to the newest line, and is mirrored to the Kindle tab's console.
- **0.6.1**
  - Turning the page mid-translation no longer cancels it: that page finishes in the background and is cached, so turning back shows it at once.
  - After reloading the extension, Kindle tabs already open reconnect without a refresh.
  - Fixed the last line of a ragged-right caption occasionally splitting off and staying untranslated.
- **0.6.0**
  - OCR mode skips figures instead of covering them with jumbled translated labels; two-line headings and ragged-right captions are no longer split into several blocks.
  - New Alt+O shortcut toggles translation / original.
  - Reloading the extension no longer leaves the old button and overlay on the page.
- **0.5.1**
  - The options page has one 「翻譯方式」 (translation mode) setting: 1. Fast, 2. Polished, 3. Read the image.
  - Polished mode lists each of Sonnet's changes in the log.
  - Larger toggle button in the bottom-right corner.
- **0.5.0**: new Polished mode, with Haiku translating and Sonnet reviewing.
- **0.4.3**: the 「顯示原文／顯示譯文」 (show original / translation) button is back in the page's bottom-right corner; Haiku is the default model again.
- **0.4.2**: Sonnet became the default translation model, with Haiku selectable.
- **0.4.1**: 「譯文｜原文」 (translation | original) switch in the side panel; fixed two-page column detection while the reader shows its progress slider.
- **0.4.0**: switched to local OCR (Tesseract) with Haiku translating the text; fixed the translation briefly flashing back to the original when the reader re-renders.

## Files

The detailed design (in Chinese) is in [docs/design.md](docs/design.md).

- `manifest.json`: Manifest V3 configuration
- `content.js`: detects page turns on the Kindle page (keys, clicks, DOM changes) and draws the translation overlay
- `background.js`: capture, OCR preprocessing, Claude API calls (structured outputs), color sampling, cache
- `ocr-layout.js`: column detection and grouping OCR lines into paragraphs
- `page-sig.js`: page fingerprints and the "same page?" comparison
- `offscreen.html/js`: runs Tesseract and DocLayout-YOLO in an offscreen document (a service worker can't start a Web Worker)
- `layout-model.js`: downloads, caches and runs DocLayout-YOLO on WebGPU
- `sidepanel.html/js`: side panel UI
- `options.html/js`: options page (API key, translation mode, effort, target language)
- `vendor/tesseract/`: Tesseract.js 7.0.0, tesseract.js-core and the English model (Apache-2.0), all bundled in the extension rather than loaded from a CDN
- `vendor/onnxruntime/`: the WebGPU build of ONNX Runtime Web 1.30.0 (MIT)
- `vendor/doclayout/`: source, checksum and license (Apache-2.0) of the DocLayout-YOLO model; the model itself isn't in the repo
- `tests/`: Node tests (see the next section)

## Development

The tests use Node's built-in test runner and need no packages, only Node 22 or later. From the repo root:

```bash
npm test                                                  # everything
node --test tests/background-flow.test.js                 # one file
node --test --test-name-pattern="cache" "tests/**/*.test.js"  # tests whose name matches
node --test --watch "tests/**/*.test.js"                  # rerun on every change
```

The tests load the extension's files unchanged and replace everything around them (Chrome APIs, screenshots, OCR, the Claude API, the DOM) with fakes, so they need no browser, API key or network, and take about 15 seconds. What Tesseract and the layout model actually output isn't covered; check that with real screenshots. How the tests are built is in section 9 of [docs/design.md](docs/design.md) (in Chinese).

After changing the extension, reload it on `chrome://extensions`, then reload the Kindle tab.

## Credits

- [DocLayout-YOLO](https://github.com/opendatalab/DocLayout-YOLO) (OpenDataLab): the layout detection model, used through the ONNX export [wybxc/DocLayout-YOLO-DocStructBench-onnx](https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx) (Apache-2.0).
- [BabelDOC](https://github.com/funstory-ai/BabelDOC): the choice of model, its preprocessing and class list follow BabelDOC.
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT) and [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0).
