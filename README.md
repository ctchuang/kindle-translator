# Kindle 自動翻譯（Chrome extension 原型）

截取 Kindle Cloud Reader（read.amazon.com 等）目前顯示的頁面，送給 Claude 辨識內文並翻譯成繁體中文，結果顯示在 Chrome 側邊欄。

## 安裝

1. 解壓縮 `kindle-translate.zip`，得到 `kindle-translate` 資料夾。
2. Chrome 網址列輸入 `chrome://extensions`，打開右上角「開發人員模式」。
3. 按「載入未封裝項目」，選 `kindle-translate` 資料夾。
4. 在擴充功能的「詳細資料 → 擴充功能選項」填入 Anthropic API key（console.anthropic.com 建立），按儲存。

## 使用

1. 打開 Kindle Cloud Reader 並開啟一本書。
2. 點工具列上的擴充功能圖示，打開側邊欄。
3. 按「翻譯這一頁」，或按 Alt+T。勾選「翻頁自動翻譯」時，翻頁後約 1 秒會自動翻譯。
4. 最新一頁的譯文顯示在最上方，可以按「複製」。

## 運作方式與注意事項

- 只有側邊欄開著時才會自動翻譯，避免背景偷偷花費 API 額度。
- 同一張畫面（截圖雜湊相同）不會重複送出；翻回已翻過的頁面會用快取（關掉瀏覽器後清除）。
- 預設模型 Claude Opus 5.5、effort low。想省錢可以在設定改成 Sonnet 5.5 或 Haiku 5.5。
- 截圖只會送往 api.anthropic.com。API key 存在 Chrome 同步儲存區。
- 書頁文字太小時辨識會變差，可以把閱讀器字體調大或視窗放大。
- 這是逐頁截圖翻譯給自己閱讀用，不要拿來大量匯出書本內容，那會違反 Amazon 使用條款。

## 檔案

- `manifest.json`：Manifest V3 設定
- `content.js`：在 Kindle 頁面偵測翻頁（按鍵、點擊、DOM 變化）
- `background.js`：截圖、呼叫 Claude API、快取
- `sidepanel.html/js`：側邊欄介面
- `options.html/js`：設定頁（API key、模型、effort、目標語言）
