# 售票雲端監控 Ticket Cloud Monitor v2

這是一個跑在雲端主機上的售票頁監控器。手機可鎖屏、Safari 可關閉；只要雲端服務持續運作，監控就會繼續。

## 目前支援

- 寬宏 Kham：快速 HTTP 模式，解析票區/空位狀態
- AVEX Shopping：快速 HTTP 模式，優先讀取「庫存量」
- KKTIX：Playwright / Chromium 瀏覽器模式
- 拓元 Tixcraft：Playwright / Chromium 瀏覽器模式
- ibon：Playwright / Chromium 瀏覽器模式
- 其他網站：通用文字「出現 / 消失」模式，HTTP 失敗時可退回瀏覽器模式

## 功能

- 可建立多個監控
- 固定秒數或隨機秒數
- 最低 5 秒
- 可限定監控時段
- 自動辨識網站
- 偵測到符合條件後自動停止
- iPhone ntfy Push 通知，點通知可回售票頁
- HTTP 429、CAPTCHA、排隊、防護頁時停止，不嘗試繞過
- Railway 重啟後會從 JSON 設定恢復原本 running 的監控

## Railway 部署

1. 將此資料夾放到 GitHub repository。
2. Railway → New Project → Deploy from GitHub Repo。
3. 加入環境變數：
   - `ADMIN_PASSWORD=你自己的密碼`
   - `TZ=Asia/Taipei`
   - `DATA_DIR=/app/data`
   - `MIN_SECONDS=5`
4. 建立 Volume 並掛載到 `/app/data`，避免重新部署後設定消失。
5. Networking 產生公開網址。
6. 開網址，Basic Auth 帳號固定 `admin`，密碼為 `ADMIN_PASSWORD`。

Dockerfile 使用 Playwright 官方映像，因此 Railway 不需要另外安裝 Chromium。

## iPhone 通知

1. iPhone 安裝 ntfy。
2. 建立/訂閱一個難猜 Topic，例如 `ticket-8f6f...`。
3. 在監控設定輸入完全相同的 Topic。
4. 按「測試通知」確認可以收到。

## 使用方式

1. 貼售票網址。
2. 設定名稱。
3. 選固定或隨機秒數。
4. 如需要，設定監控時段。
5. 輸入 ntfy Topic。
6. 新增後先按「測試抓取」。
7. 確認結果正確再按「開始」。

對寬宏、KKTIX、AVEX、拓元、ibon，程式會自動判斷站點。通用文字欄位主要給其他網站使用。

## 重要限制

- 售票網站可能隨時改版，站點規則屆時可能需要更新。
- KKTIX、拓元、ibon 等動態頁面可能出現登入、CAPTCHA、排隊或資料中心 IP 限制；程式會停下，不會繞過。
- 秒級輪詢可能觸發網站限制。建議先從 8～15 秒隨機開始，而不是 5 秒固定狂刷。
- 此工具不會自動購票、選位、繞排隊或提交訂單，只負責讀取公開票況與通知。

## 本機開發

需要 Node.js 20+。Playwright 需要 Chromium：

```bash
npm install
npx playwright install chromium
ADMIN_PASSWORD=test123 npm start
```

開啟 `http://localhost:3000`。
