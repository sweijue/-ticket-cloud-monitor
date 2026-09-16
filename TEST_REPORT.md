# V4.0.2 單一通用腳本測試報告

## 目的
- 未建立／未登記的網站不顯示監控面板。
- Ticket Plus、Tixcraft、一般網站共用 `universal-linked.user.js`。
- 管理頁可直接把新監控登記到通用腳本，不需要到目標頁貼配對碼。
- 保留 V4.0.1 Railway 啟動修正。
- 通用腳本支援 iframe 內的整頁摘要與指定區域選取，避免 Ticket Plus 類頁面需要另一支腳本。

## 已執行檢查
1. `node --check server.js`：通過。
2. `node --check public/app.js`：通過。
3. `node --check public/universal-linked.user.js`：通過。
4. `node --check public/ticketplus-linked.user.js`：通過（V4.0.2 停用相容層）。
5. `node --check public/tixcraft-linked.user.js`：通過（V4.0.2 停用相容層）。
6. VM 測試：未登記的 `https://example.com/product/1` 不建立任何監控 UI，也不啟動輪詢：通過。
7. VM 測試：Railway 管理頁只建立隱藏 bridge，不顯示目標網站監控面板：通過。
8. VM 測試：管理頁 one-click register 訊息可把明確建立的監控 URL 寫入通用腳本 registry：通過。
9. 檢查 `server.js`：V4.0.1 的 `join('\\n')` 啟動修正仍保留。
10. 檢查 iframe bridge：子 frame 僅在 top page 要求時回傳 page/region snapshot；未登記頁不會顯示面板。

## 行為
- 通用 userscript 仍需要 `@match http://*/*` / `https://*/*`，原因是瀏覽器必須先允許它在未來可能新增的網站執行。
- 但 V4.0.2 在 top page 會先查本機 registry；沒有管理頁登記紀錄就直接 `return`，不建立按鈕、不建立面板、不開始本機監控。
- iframe 中只有無 UI 的 bridge，用來支援 iframe 內的內容；沒有 top page 指令時不做監控。
- Ticket Plus / Tixcraft 專屬 userscript 已改成 no-op 相容層，功能移到 universal script。

## 既有監控遷移
舊 Ticket Plus / Tixcraft 配對 token 存在各自專屬 userscript 的儲存空間，無法安全地由另一支 userscript 直接讀取。因此既有監控需要在管理頁按一次「登記本機」重新產生 scoped token；監控資料本身不會刪除。
