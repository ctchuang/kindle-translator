# TODO

## 保留段落裡的彩色字

[文字樣式](docs/text-styles.md)的第一版（2.1.0）只做了斜體、粗體和螢光標記。之後再保留段落裡跟主要字色不同的字（例如藍色的連結）：全部保留，不設門檻，用 `<c1>`、`<c2>` 標記，顏色取文字串的 `textColor`。

## 一個字只有一部分有樣式

例如只有字首是斜體（*reason*ing）。決定整個字都算有樣式。目前字的樣式看的是字的中心點落在哪裡，只有一部分有樣式的字可能沒被標到；之後在對到 OCR 的字時（[text-styles.md](docs/text-styles.md) §3.2）改成只要字有一部分落在範圍裡就算。

## 校對時參考前面的頁：本機實測

2.2.0 已實作（預設關閉），還要在實際的 Kindle Cloud Reader 上比較開和關的品質，並從執行紀錄確認 prompt cache 有命中。待辦清單見 [docs/reference-pages.md](docs/reference-pages.md) §7。
