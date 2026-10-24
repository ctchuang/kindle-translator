# Kindle 自動翻譯（Chrome extension 原型）

截取 Kindle Cloud Reader（read.amazon.com 等）目前顯示的頁面，用本機 OCR（Tesseract）辨識每段文字與位置，再交給 Claude Haiku 翻譯成繁體中文。譯文直接蓋在書頁原文的位置上，也同時顯示在 Chrome 側邊欄。

> **狀態：不穩定（flaky）。** 譯文覆蓋層還在除錯中，在實際的 Kindle 頁面上可能完全疊不上去，或位置偏移。側邊欄的譯文比較可靠。覆蓋層沒出現時，側邊欄狀態列會用紅字顯示原因。

## 安裝

1. 解壓縮 `kindle-translate.zip`，得到 `kindle-translate` 資料夾。
2. Chrome 網址列輸入 `chrome://extensions`，打開右上角「開發人員模式」。
3. 按「載入未封裝項目」，選 `kindle-translate` 資料夾。
4. 在擴充功能的「詳細資料 → 擴充功能選項」填入 Anthropic API key（console.anthropic.com 建立），按儲存。

## 使用

1. 打開 Kindle Cloud Reader 並開啟一本書。
2. 點工具列上的擴充功能圖示，打開側邊欄。
3. 按「翻譯這一頁」，或按 Alt+T。勾選「翻頁自動翻譯」時，翻頁後約 1 秒會自動翻譯。目前這一頁已經翻好、畫面也沒變時，按鈕會變成「重新翻譯本頁」，按下去會略過快取重新請求。
4. 譯文會蓋在書頁原本的段落上（字級自動縮放、底色配合閱讀器主題）。側邊欄的「譯文蓋在書頁上」開關可以隨時切換原文／譯文。翻頁或點擊頁面時覆蓋層會先清掉，等新的一頁翻好再出現。
5. 側邊欄最上方是最新一頁的譯文，可以按「複製」。

## 運作方式與注意事項

- 只有側邊欄開著時才會自動翻譯，避免背景偷偷花費 API 額度。
- 頁面以「內文區域」的截圖雜湊辨識（不含標題列、進度列、翻頁箭頭），同一頁不會重複送出；翻回已翻過的頁面會用快取（關掉瀏覽器後清除）。翻譯途中畫面內容變了，會取消進行中的請求，改翻新的一頁。
- 設定頁可以選兩種方式：
  - **本機 OCR ＋ Haiku（預設）**：Tesseract.js 在瀏覽器裡辨識文字和位置（雙頁會先找出中間的空白分成兩欄），合併成段落後只把文字送給 Claude Haiku 5.5 翻譯；雙頁時左右兩欄同時送出。一頁約 9 秒（OCR 約 3 秒），截圖不會離開電腦。目前只載入英文辨識模型。Haiku 偶爾會以版權為由拒絕翻譯某一欄，那一欄會自動改用 Opus 5.5 翻譯文字，整頁約 15 秒。
  - **Opus 看截圖**：截圖直接送給 Claude Opus 5.5，由它找段落位置並翻譯。每頁 20 秒以上，effort 預設 low。實測 Sonnet 5.5、Haiku 5.5 看書頁截圖會以版權為由拒絕，所以這個模式只用 Opus。Opus 5.5 被安全分類器擋下時，會依序改用 Opus 5、Opus 4.8 重試。
- 只會連到 api.anthropic.com。API key 存在 Chrome 同步儲存區。
- Opus 模式的截圖會先縮到長邊 2576px 且總像素 3.7MP 以內再送出，超過的話 API 會再縮一次，座標就對不上。
- Claude 偶爾會以版權為由只給摘要。偵測到摘要會自動重新請求一次；仍是摘要就照樣顯示並標示「摘要」，但不存快取。
- 位置以段落為單位，不是逐行對齊；框偶爾會偏一點。OCR 模式的段落是依縮排、行距和短行切分，偶爾會把兩段合併或一段拆開。
- 書頁文字太小時辨識會變差，可以把閱讀器字體調大或視窗放大。
- 這是逐頁截圖翻譯給自己閱讀用，不要拿來大量匯出書本內容，那會違反 Amazon 使用條款。

## 檔案

- `manifest.json`：Manifest V3 設定
- `content.js`：在 Kindle 頁面偵測翻頁（按鍵、點擊、DOM 變化），並畫出譯文覆蓋層
- `background.js`：截圖、OCR 前處理、呼叫 Claude API（結構化輸出）、取樣顏色、快取
- `ocr-layout.js`：分欄偵測、把 OCR 的行合併成段落
- `offscreen.html/js`：在 offscreen 文件裡執行 Tesseract（service worker 不能開 Web Worker）
- `vendor/tesseract/`：Tesseract.js 7.0.0、tesseract.js-core 和英文模型（Apache-2.0），全部打包在擴充功能裡，不從 CDN 載入
- `sidepanel.html/js`：側邊欄介面
- `options.html/js`：設定頁（API key、辨識方式、effort、目標語言）
