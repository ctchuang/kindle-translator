[繁體中文](README.md) | **English**

# Kindle Auto-Translate (Chrome extension)

[![Tests](https://github.com/ctchuang/kindle-translator/actions/workflows/test.yml/badge.svg)](https://github.com/ctchuang/kindle-translator/actions/workflows/test.yml)

Reads Kindle Cloud Reader's own page data (read.amazon.com and others) to know which page is on screen and which words form a paragraph, reads the text with local OCR (Tesseract), and has Claude Haiku translate it into Traditional Chinese, with Sonnet reviewing the translation. The translation is drawn directly over the original text on the page, and also shown in Chrome's side panel. While you read a page, the next one is translated ahead, so it's there as soon as you turn to it.

![Example: a two-page spread of Build a Reasoning Model (From Scratch), with the body text and captions translated in place and figures 1.1 and 1.2 left as they are, and the side panel on the right](docs/example.png)

> Reading on page by page, from the second page the translation is there as soon as you turn; the first page, or a page jumped or turned back to that wasn't translated, takes 10–15 seconds. When the overlay doesn't appear, the side panel's status line shows the reason in red, and the log below it shows each step.

The extension's interface is in Chinese; the labels quoted below are followed by their English meaning. The target language can be changed in the options page.

## Using the reader's own page data

Kindle Cloud Reader shows book pages as images, but before drawing them it fetches page data from Amazon: where each line of text goes, its font, colour and paragraph, where the illustrations are, and the glyph outlines. From 2.0 the extension listens in on that data (it never requests anything from Amazon itself) and uses it for three things:

- **Knowing which page is on screen**: it draws the candidate pages from the data and compares them pixel by pixel with the image the reader shows; the one identical outside the illustrations is the page. The toolbar, the cursor or a menu popping up are never taken for a page turn.
- **Knowing which words form a paragraph, what's a heading, where the illustrations are**: straight from the book's own layout, no guessing. Text inside illustrations isn't translated, so the original picture shows.
- **Giving OCR a clean page**: no toolbar, cursor or leftover translation. The glyphs in the data are numbered, not text, so Tesseract still reads the words.

Translations are kept per paragraph, by the paragraph's position in the book, whatever the font size or window size: after changing either, paragraphs already read aren't translated again.

1.x did all this with screenshots, a coarse screen fingerprint and the DocLayout-YOLO layout model (WebGPU, 75 MB); 2.0 replaces all of it and no longer needs WebGPU or a model download.

## Install

1. Download `kindle-translate.zip` from [Releases](https://github.com/ctchuang/kindle-translator/releases/latest).
2. Unzip `kindle-translate.zip` to get the `kindle-translate` folder.
3. Open `chrome://extensions` and turn on "Developer mode" in the top right.
4. Click "Load unpacked" and choose the `kindle-translate` folder.
5. In the extension's "Details → Extension options", enter an Anthropic API key (create one at console.anthropic.com) and save.

## Usage

1. Open Kindle Cloud Reader and open a book.
2. Click the extension's icon in the toolbar to open the side panel.
3. Click 「翻譯這一頁」 (translate this page) or press Alt+T. With 「翻頁自動翻譯」 (translate on page turn) checked, a page not yet translated is translated after you've stayed on it about 1 second; a translated one shows at once. When the current page's translation is on screen, the button becomes 「重新翻譯本頁」 (retranslate this page) and skips the cache.
4. The translation covers the book's paragraphs in place (font size fitted to each box, colors matched to the reader theme). The side panel's 「書頁顯示：譯文｜原文」 (page shows: translation | original) switch, or the small 「顯示原文／顯示譯文」 (show original / show translation) button in the page's bottom-right corner, or Alt+O, toggles between them at any time; switching back to the translation is instant, with no new request. Turning the page clears the overlay until the new page is translated.
5. The newest page's translation is at the top of the side panel, with a 「複製」 (copy) button.

## How it works and caveats

- Pages are only translated automatically while the side panel is open, so no API credit is spent in the background.
- In a tab where the book was opened before the extension was loaded (or reloaded), the page on screen is only recognised once the reader fetches its next batch of page data; the side panel says so, and reloading the Kindle tab is quickest.
- Translation starts about 1.2 seconds after the last page turn, so pages flipped past quickly are never sent. If you turn the page mid-translation, that page finishes in the background and goes into the cache (one page at most; beyond that the oldest is cancelled) while the new page starts right away; turning back to a page still translating waits for it instead of sending it again. The cache is cleared when the browser closes.
- **Translate the next page ahead** (options page, on by default): about 2 seconds after the current page's translation is drawn, the next page is translated. Reading on page by page this costs nothing extra; when you stop reading, jump or turn back, pages translated ahead but never read are still billed. Modes 1 and 2 only.
- **Refer to earlier pages when reviewing** (options page, experimental, off by default): in Polished mode, Sonnet's review also gets the paragraphs of the same book you've read before the current page (original and final translation), to keep names, terms and tone consistent. It also keeps a list of each book's names (original → translation), compiled by Sonnet's review, and every later translation and review follows it, however many pages back a name was first seen; a name already listed keeps its translation. Once on, the paragraphs drawn on the page (original and translation) and the name list are kept in Chrome's local storage on this computer, paragraphs for a week and names for 30 days; the options page can delete them in one go. The reference is capped at 16,000 tokens by default (about 4–5 two-page screens) and uses prompt caching: about 1.3 US cents more per page while reading on, about 4 cents for the first page after a break of more than 5 minutes. Only what comes before the current page is sent, never what you haven't read yet.
- The options page's 「翻譯方式」 (translation mode) has three choices:
  - **1. Fast**: Tesseract.js reads each column's text in the browser, the reader's page data splits it into paragraphs, and only the text is sent to Claude Haiku 5.5. On a two-page spread both columns are sent in parallel. About 0.1 US cent per page; the page image never leaves your computer. Only the English OCR model is bundled for now.
  - **2. Polished (default)**: as 1, then Sonnet 5.5 reviews Haiku's translation, returning only the paragraphs it changes; the changes are listed in the side panel's log. About 1 cent per page.
  - In 1 and 2 a column is occasionally declined on copyright grounds; that column is then translated as text by Opus 5.5 instead (without a review).
  - **3. Read the image**: the screenshot goes straight to Claude Opus 5.5, which finds the paragraphs and translates them, and can handle books in other languages. 20+ seconds per page, effort defaults to low, no translating ahead. In testing, Sonnet 5.5 and Haiku 5.5 declined book-page screenshots on copyright grounds, so this mode uses Opus only. When a safety classifier declines Opus 5.5, the request is retried on Opus 5, then Opus 4.8. The screenshot is scaled to at most 2576 px on the long edge and 3.7 MP in total before sending; anything larger gets scaled again by the API and the coordinates no longer line up.
- The only server contacted is api.anthropic.com. The API key is kept in Chrome sync storage. The reader's page data is used inside the page to recognise and draw the current and next page, and is never sent anywhere.
- Claude occasionally returns a summary instead of a translation, citing copyright. A summary triggers one automatic retry; if it is still a summary it is shown and labelled 「摘要」 (summary), but not cached.
- Positions are per paragraph, not per line; a paragraph running from the left page into the right one gets its translation split in two by line count.
- Italics in the original are set in a kai face in the translation, bold words stay bold, and the page's highlights mark the matching words of the translation in the same colour. Not in vision mode.
- The translation boxes cover the original text under them. To add a highlight, switch to the original first (the bottom-right button or Alt+O), select the text and highlight it, then switch back to the translation; that paragraph is translated again with the highlight.
- The extension depends on Kindle Cloud Reader's unpublished page data format; if Amazon changes it, pages won't be recognised and the side panel will say so.
- This translates page by page for your own reading. Don't use it to export book content in bulk; that violates Amazon's terms of use.

## Release notes

- **2.3.1**: when Claude answers a page with a summary, the names its review lists no longer go into the name list (a summary isn't kept, like the paragraph cache); when a retry brings a translation, only that try's names are kept.
- **2.3.0**: a list of names per book.
  - With "refer to earlier pages when reviewing" on, each book gets a list of names (original → translation), compiled by Sonnet's review; every later translation (including a column Opus took over) and review follows it, however many pages back a name was first seen; a column Opus took over is then reviewed by Sonnet too. A name already listed keeps its translation; each is kept for 30 days after it was last seen and can be deleted from the options page.
  - Fixed every page failing after about 30 pages read in a row (Chrome's session storage was full): when it's full, the older half of the cache goes.
- **2.2.0**: the review can refer to earlier pages.
  - New: refer to earlier pages when reviewing (experimental, off by default). Sonnet's review sees the paragraphs of the same book read before, to keep names, terms and tone consistent. They're kept on this computer for a week and can be deleted from the options page.
  - Polished mode now reviews the whole page once both columns are translated, instead of each column separately.
  - The log shows prompt-cache reads and writes.
- **2.1.0**: keeps the original's text styles and highlights.
  - Italic words are set in a kai face in the translation; bold words within a paragraph stay bold.
  - The page's highlights mark the matching words of the translation in the same colour; adding or removing one translates just that paragraph again.
- **2.0.2**:
  - Fixed pages with shaded boxes or links (as in technical books) not being recognised: the shaded boxes are drawn from the page data, and box edges and link underlines are left out of the comparison.
  - The translation no longer covers the reader's toolbar and settings panel.
- **2.0.1**: fixes to 2.0.0.
  - Pressing 「翻譯這一頁」 (translate this page) while the page is being translated now waits for it instead of cancelling and paying again.
  - Paragraphs Claude leaves blank as noise are cached too, so turning back or translating ahead doesn't ask for them again.
  - Flipping quickly no longer draws or posts a page already turned past, nor shows a red warning.
  - An empty page-data response from the reader no longer causes an error; the log's count of screens compared counts only those actually compared.
- **2.0.0**: uses the reader's own page data, and translates the next page ahead.
  - Listens in on the page data the reader fetches, draws the page from it and compares it pixel by pixel with the screen, so the page on screen is known exactly; no more screenshot fingerprints, and the toolbar or cursor no longer count as a page turn.
  - Paragraphs, headings and illustrations come from the page data, replacing the DocLayout-YOLO layout model: no WebGPU needed, and no 75 MB download.
  - OCR reads a clean page drawn from the data; the translation boxes sit exactly where the text is, in the reader theme's colours.
  - Translations are cached per paragraph, so changing the font size or window size, or turning back, doesn't translate paragraphs already read again; a page turned away from mid-translation isn't wasted either.
  - New: translate the next page ahead (on by default).
  - The side panel's 存下截圖 (save screenshot) became 存下頁面資料 (save page data), for debugging.
- **1.1.0**: OCR reads only the area where Kindle draws the book page.
  - The page reports where that is, instead of a fixed share of the screen, which cut off the chapter heading and first line in tall windows and took in the title bar in short ones. It now works the same at any window size, zoom or screen resolution.
  - The same-page check looks at the same area, so the toolbar sliding in and out no longer counts as a page turn.
  - 存下截圖 also saves a `.json` with where the page was drawn, for tests.
  - The options page has a new developer section that lets a test tool trigger screenshots (off by default).
  - Fixed the background worker answering the page's messages with an empty reply first.
- **1.0.1**: the same-page threshold is loosened from 8% to 15%, so small changes on screen no longer count as a page turn. The side panel's log has a new 存下截圖 button that saves the current screen as a test screenshot. Retrying a failed model download now restarts its progress from 0.
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
- `page-hook.js`: wraps `fetch` in the Kindle page's own world and copies the reader's page data to the content script
- `page-render.js`: unpacks the page data, draws pages from it, compares pixels, finds paragraphs and columns
- `content.js`: keeps the page data on the Kindle page, recognises the page on screen, and draws the translation overlay
- `background.js`: decides which page to translate, Claude API calls (structured outputs), the paragraph cache, translating ahead, the vision mode's screenshot
- `ocr-layout.js`: puts OCR lines and words into paragraphs, with each word's style
- `styled-text.js`: handles translations with italics, bold and highlights
- `context-pages.js`: picks the earlier paragraphs the review refers to, and keeps the list of names
- `offscreen.html/js`: runs Tesseract in an offscreen document (a service worker can't start a Web Worker)
- `sidepanel.html/js`: side panel UI
- `options.html/js`: options page (API key, translation mode, translate ahead, refer to earlier pages, effort, target language)
- `vendor/tesseract/`: Tesseract.js 7.0.0, tesseract.js-core and the English model (Apache-2.0), all bundled in the extension rather than loaded from a CDN
- `tests/`: Node tests (see the next section)

## Development

The tests use Node's built-in test runner and need Node 22 or later; there are no packages to install:

```bash
npm test                                                  # everything
node --test tests/background-flow.test.js                 # one file
node --test --test-name-pattern="cache" "tests/**/*.test.js"  # tests whose name matches
node --test --watch "tests/**/*.test.js"                  # rerun on every change
```

The tests load the extension's files unchanged and replace everything around them (Chrome APIs, the Kindle page, OCR, the Claude API, the DOM) with fakes, so they need no browser, API key or network, and take about 20 seconds. A synthetic book stands in for Kindle's page data (Amazon's fonts can't go into the repo), and a fake canvas that really fills pixels lets the pixel-by-pixel page recognition be tested too. What Tesseract actually reads and how the reader really draws aren't covered; check those on Kindle Cloud Reader itself. How the tests are built is in section 11 of [docs/design.md](docs/design.md) (in Chinese).

GitHub Actions runs every test on Node 22 and 24 for each push and pull request (`.github/workflows/test.yml`).

After changing the extension, reload it on `chrome://extensions`, then reload the Kindle tab.

## Credits

- [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0).
- 1.x detected layouts with [DocLayout-YOLO](https://github.com/opendatalab/DocLayout-YOLO) (OpenDataLab) on [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT), following [BabelDOC](https://github.com/funstory-ai/BabelDOC).
