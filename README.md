**繁體中文** | [English](README.en.md)

# Kindle 自動翻譯（Chrome extension）

截取 Kindle Cloud Reader（read.amazon.com 等）目前顯示的頁面，用本機 OCR（Tesseract）辨識文字、DocLayout-YOLO 版面模型找出段落與圖表位置，再交給 Claude Haiku 翻譯、Sonnet 校對成繁體中文。譯文直接蓋在書頁原文的位置上，也同時顯示在 Chrome 側邊欄。

![範例：《Build a Reasoning Model (From Scratch)》雙頁版面，內文和圖說的譯文蓋在原文位置上，圖 1.1、1.2 保留原圖，右側是側邊欄](docs/example.png)

> **目前版本 1.0.1。** 在 Kindle Cloud Reader 的雙頁版面上實測，翻頁後約 10 秒譯文就會蓋上原文。覆蓋層沒出現時，側邊欄狀態列會用紅字顯示原因，底下的執行紀錄可以看到每一步。

## 用視覺模型偵測排版

Kindle Cloud Reader 的書頁是圖片，沒有可以讀的文字和排版資訊，所以擴充功能看的是截圖。光靠 OCR 只知道每一行字在哪裡，分不出哪些行是同一段、哪個是標題，也分不出哪些字其實是圖裡的標籤。

因此 1.0 起，擴充功能會在瀏覽器裡跑一個視覺模型 [DocLayout-YOLO](https://github.com/opendatalab/DocLayout-YOLO) 來偵測排版（layout）。它是專門看文件版面的物件偵測模型，會在書頁上框出這些區塊：

- 段落、標題、頁首頁尾
- 圖、圖說
- 表、表說明、表註
- 公式、公式說明

擴充功能再把 OCR 讀到的每一行放進對應的區塊：

- 同一個區塊的行合成一段，所以分段、標題的判斷跟書的排版一致。
- 圖、表、公式裡的字不翻譯，原圖會露出來，不會被一堆翻譯過的標籤蓋住。
- 圖說、標題各自成框，字級和位置不會跟內文混在一起。

模型用 [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 在本機 GPU 上執行（WebGPU），雙頁約 0.25 秒，截圖不會離開電腦。模型檔 75 MB，第一次翻譯時從 Hugging Face 下載，之後存在瀏覽器裡。這個做法參考了 PDF 翻譯工具 [BabelDOC](https://github.com/funstory-ai/BabelDOC)。

## 安裝

1. 從 [Releases](https://github.com/ctchuang/kindle-translator/releases/latest) 下載 `kindle-translate.zip`。
2. 解壓縮 `kindle-translate.zip`，得到 `kindle-translate` 資料夾。
3. Chrome 網址列輸入 `chrome://extensions`，打開右上角「開發人員模式」。
4. 按「載入未封裝項目」，選 `kindle-translate` 資料夾。
5. 在擴充功能的「詳細資料 → 擴充功能選項」填入 Anthropic API key（console.anthropic.com 建立），按儲存。

## 使用

1. 打開 Kindle Cloud Reader 並開啟一本書。
2. 點工具列上的擴充功能圖示，打開側邊欄。
3. 按「翻譯這一頁」，或按 Alt+T。勾選「翻頁自動翻譯」時，翻頁後約 1 秒會自動翻譯。目前這一頁已經翻好、畫面也沒變時，按鈕會變成「重新翻譯本頁」，按下去會略過快取重新請求。
4. 譯文會蓋在書頁原本的段落上（字級自動縮放、底色配合閱讀器主題）。側邊欄上方的「書頁顯示：譯文｜原文」切換鈕，或書頁右下角的「顯示原文／顯示譯文」小按鈕，或按 Alt+O，都可以隨時切換，切回譯文時會立刻顯示，不用重新翻譯。翻頁或點擊頁面時覆蓋層會先清掉，等新的一頁翻好再出現。
5. 側邊欄最上方是最新一頁的譯文，可以按「複製」。

## 運作方式與注意事項

- 只有側邊欄開著時才會自動翻譯，避免背景偷偷花費 API 額度。
- 頁面以「內文區域」的粗略指紋辨識（不含標題列、進度列、翻頁箭頭；縮小成黑白點陣，大致相同就算同一頁，所以工具列、滑鼠效果不會被當成換頁），同一頁不會重複送出；翻回已翻過的頁面會用快取（關掉瀏覽器後清除）。翻頁後停約 1.2 秒才會開始翻譯，快速連續翻頁時中間的頁面不會送出。翻譯途中換頁的話，那一頁會在背景翻完並存進快取（最多同時一頁，再多就取消最早的），同時馬上開始翻新的一頁；翻回還在背景翻譯的頁面時會等它完成，不會重送。
- 設定頁的「翻譯方式」有三種：
  - **1. 快速**：Tesseract.js 在瀏覽器裡辨識文字和位置（雙頁會先找出中間的空白分成兩欄），同時用 DocLayout-YOLO 版面模型在 GPU 上（WebGPU）找出段落、標題、圖說、圖、表的位置：圖、表、公式裡的文字保留原文，其他依模型的區塊合併成段落，只把文字送給 Claude Haiku 5.5 翻譯；雙頁時左右兩欄同時送出。一頁約 9 秒（OCR 約 3 秒），每頁約 0.1 美分，截圖不會離開電腦。目前只載入英文辨識模型。
  - **2. 精修（預設）**：同 1，Haiku 翻完後再由 Sonnet 5.5 校對，Sonnet 只回傳需要修改的段落，修改內容會列在側邊欄的執行紀錄裡。實測每欄校對 2～3 秒，整頁約 10 秒，每頁約 1 美分。
  - 1、2 偶爾會有某一欄被以版權為由拒絕翻譯，那一欄會自動改用 Opus 5.5 翻譯文字（不再校對），整頁約 15 秒。
  - **3. 看圖**：截圖直接送給 Claude Opus 5.5，由它找段落位置並翻譯，可以處理非英文書。每頁 20 秒以上，effort 預設 low。實測 Sonnet 5.5、Haiku 5.5 看書頁截圖會以版權為由拒絕，所以這個模式只用 Opus。Opus 5.5 被安全分類器擋下時，會依序改用 Opus 5、Opus 4.8 重試。
- 只會連到 api.anthropic.com。API key 存在 Chrome 同步儲存區。
- Opus 模式的截圖會先縮到長邊 2576px 且總像素 3.7MP 以內再送出，超過的話 API 會再縮一次，座標就對不上。
- Claude 偶爾會以版權為由只給摘要。偵測到摘要會自動重新請求一次；仍是摘要就照樣顯示並標示「摘要」，但不存快取。
- 位置以段落為單位，不是逐行對齊；框偶爾會偏一點。OCR 模式的段落以 DocLayout-YOLO 的區塊為準，模型沒框到的行（例如被頁緣切到的一行）才依縮排、行距和短行切分。
- DocLayout-YOLO 模型檔 75 MB，第一次翻譯時從 Hugging Face 下載並校驗，存在瀏覽器裡，之後不再下載；第一頁會等下載完成，側邊欄會顯示進度。需要 WebGPU；模型無法使用時不會改用別的方式，而是在側邊欄顯示紅字錯誤，這頁不翻譯。
- 書頁文字太小時辨識會變差，可以把閱讀器字體調大或視窗放大。
- 這是逐頁截圖翻譯給自己閱讀用，不要拿來大量匯出書本內容，那會違反 Amazon 使用條款。

## 版本紀錄

- **1.1.0**：OCR 只讀 Kindle 畫書頁的範圍。
  - 位置由頁面回報，不再用固定比例。以前高的視窗會切掉章名和第一行，矮的視窗又會讀進標題列；現在不論視窗大小、縮放比例、螢幕解析度都一樣準。
  - 判斷「同一頁」也改看同一個範圍，工具列滑進滑出不再被當成翻頁。
  - 「存下截圖」會另外存一個 `.json`，記錄書頁的位置，給測試用。
  - 設定頁新增「開發者」區塊，可以讓測試工具觸發截圖（預設關閉）。
  - 修正背景程式搶先用空值回覆頁面的訊息。
- **1.0.1**：判斷「同一頁」的門檻從 8% 放寬到 15%，畫面小變動不再被當成翻頁。側邊欄執行紀錄新增「存下截圖」，把目前畫面存成測試用的截圖。模型下載失敗重試時，進度從 0 重新顯示。
- **1.0.0**：用 DocLayout-YOLO 版面模型（WebGPU）判斷段落、標題、圖說、圖、表，取代原本靠縮排、行距、字距猜的規則；圖、表、公式裡的文字保留原文。模型第一次使用時下載（75 MB）並存在瀏覽器裡；無法使用時明確報錯，不改用別的方式。側邊欄新增模型狀態列。
- **0.6.3**：翻譯方式預設改成「2. 精修」（Haiku 翻譯、Sonnet 校對）。
- **0.6.2**：修正譯文常常變回英文、停在英文不回來。
  - 判斷是否同一頁改用粗略指紋（大致相同就算同一頁），工具列、滑鼠效果、JPEG 雜訊不再被當成換頁。
  - 清掉譯文後等畫面真的重畫才截圖，不再截到殘留的譯文、讓 OCR 讀成亂碼。
  - 背景程式閒置被 Chrome 停掉後，第一個翻頁訊息不再被丟掉。
  - 工具列出現或收起時觸發的 resize 不再清掉譯文；重新載入擴充功能後，舊的書頁程式不再干擾。
  - 執行紀錄會顯示每次比對的差異百分比，並自動捲到最新一行，也同步印在 Kindle 分頁的 console。
- **0.6.1**
  - 翻譯途中換頁時，舊的那頁改在背景翻完並存快取，不再取消；翻回去時直接顯示。
  - 重新載入擴充功能後，已開著的 Kindle 分頁會自動接上，不用重新整理。
  - 修正靠左對齊的圖說最後一行偶爾被切成另一段、沒有蓋上譯文。
- **0.6.0**
  - OCR 模式略過圖表，不再把圖裡的標籤翻成一團蓋在圖上；兩行的大標題、靠左對齊的圖說不再被切成好幾段。
  - 新增 Alt+O 快捷鍵切換譯文／原文。
  - 重新載入擴充功能後，書頁上不再殘留舊的按鈕和覆蓋層。
- **0.5.1**
  - 設定頁合併成一個「翻譯方式」選單：1. 快速、2. 精修、3. 看圖。
  - 精修模式會在執行紀錄列出 Sonnet 每一段的修改。
  - 放大右下角的切換按鈕。
- **0.5.0**：新增「Haiku 翻譯、Sonnet 校對」的精修模式。
- **0.4.3**：書頁右下角加回「顯示原文／顯示譯文」按鈕；翻譯模型預設改回 Haiku。
- **0.4.2**：翻譯模型預設改成 Sonnet，可在設定頁改回 Haiku。
- **0.4.1**：側邊欄的「譯文｜原文」切換鈕；修正閱讀器顯示進度列時雙頁分欄失敗。
- **0.4.0**：改用本機 OCR（Tesseract）加 Haiku 翻譯文字；修正閱讀器重繪時譯文短暫閃回原文。

## 檔案

詳細設計見 [docs/design.md](docs/design.md)。

- `manifest.json`：Manifest V3 設定
- `content.js`：在 Kindle 頁面偵測翻頁（按鍵、點擊、DOM 變化），並畫出譯文覆蓋層
- `background.js`：截圖、OCR 前處理、呼叫 Claude API（結構化輸出）、取樣顏色、快取
- `ocr-layout.js`：分欄偵測、把 OCR 的行合併成段落
- `page-sig.js`：頁面指紋與「是否同一頁」的比對
- `offscreen.html/js`：在 offscreen 文件裡執行 Tesseract 和 DocLayout-YOLO（service worker 不能開 Web Worker）
- `layout-model.js`：下載、快取、在 WebGPU 上執行 DocLayout-YOLO
- `sidepanel.html/js`：側邊欄介面
- `options.html/js`：設定頁（API key、翻譯方式、effort、目標語言）
- `vendor/tesseract/`：Tesseract.js 7.0.0、tesseract.js-core 和英文模型（Apache-2.0），全部打包在擴充功能裡，不從 CDN 載入
- `vendor/onnxruntime/`：ONNX Runtime Web 1.30.0 的 WebGPU 版本（MIT）
- `vendor/doclayout/`：DocLayout-YOLO 模型的來源、校驗碼與授權（Apache-2.0）；模型本身不在 repo 裡
- `tests/`：Node 測試（見下一節）

## 開發

測試用 Node 內建的 test runner，需要 Node 22 以上。唯一的套件是解 JPEG 的 `jpeg-js`，第一次先在 repo 根目錄執行 `npm install`。之後：

```bash
npm test                                                  # 全部
node --test tests/background-flow.test.js                 # 一個檔案
node --test --test-name-pattern="cache" "tests/**/*.test.js"  # 名稱符合的測試
node --test --watch "tests/**/*.test.js"                  # 改程式時自動重跑
```

測試把擴充功能的檔案原封不動地載入，周圍的 Chrome API、截圖、OCR、Claude API 和 DOM 都換成假的，所以不需要瀏覽器、API key 或網路，跑一次約 15 秒。`tests/fixtures/` 裡有幾張沒有版權的書的真實截圖（用側邊欄執行紀錄的「存下截圖」存下），用來測頁面指紋、裁切、分欄和顏色。Tesseract 和版面模型的實際輸出不在測試範圍內，要用真實截圖確認。測試的架構見 [docs/design.md](docs/design.md) 第 9 節。

批次製作測試截圖的方法見 [docs/design.md](docs/design.md) 第 9 節。

改動擴充功能後，到 `chrome://extensions` 按擴充功能的重新載入，再重新整理 Kindle 分頁。

## 致謝

- [DocLayout-YOLO](https://github.com/opendatalab/DocLayout-YOLO)（OpenDataLab）：版面偵測模型。使用 [wybxc/DocLayout-YOLO-DocStructBench-onnx](https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx) 的 ONNX 版本（Apache-2.0）。
- [BabelDOC](https://github.com/funstory-ai/BabelDOC)：模型的選擇、前處理與類別定義參考它的做法。
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)（MIT）與 [Tesseract.js](https://github.com/naptha/tesseract.js)（Apache-2.0）。
