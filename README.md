# LINE 記帳機器人 MVP

Cloudflare Workers + TypeScript 的 LINE 記帳機器人。文字與收據照片只會先建立 KV 草稿；只有使用者按下與 `draft_id` 綁定的 Flex Message「確認寫入」postback，才會建立 D1 正式批次並追加 Google Sheet。

## 已實作

- 多行文字、多筆支出與收據照片的 Gemini JSON 解析
- 金額算式由後端安全計算（`+ - * /`、括號），不使用 `eval`
- 台灣日期、完整分類清單、咖啡／請貝／全聯飲用組合等分類規則
- KV 24 小時待確認草稿、文字修改、重新預覽與取消
- LINE 簽章驗證、Webhook event 去重、確認／取消 postback
- D1 批次與支出資料、Google Sheet 寫入狀態、部分失敗與不明確回應狀態
- Google Sheet 使用 metadata 找到既有工作表，再用 `values.append` 只寫 A:E；每位 LINE 使用者會在第一次使用時綁定一個專屬分頁，新使用者自動建立 `user_xxxxxx` 分頁
- 今日總開銷、最近三個日曆日逐日開銷；查詢以 D1 中「D1 與 Sheet 都完成」的資料為準
- 可在 LINE 傳送「同步最近三天」，把 Google Sheet 最近三個日曆日的資料同步回 D1；同步以工作表列號去重，不會刪除 D1 既有資料

### 多使用者 Sheet 分頁

`user_sheet_tabs` 會保存 LINE user ID 與 Google Sheet 分頁 GID 的對照。既有使用者沿用 `GOOGLE_SHEET_GID` 指定的分頁；新使用者收到 LINE `follow` 事件時會自動建立專屬分頁，若沒有收到 `follow`，則第一次正式記帳、查詢或同步時建立。所有使用者仍共用同一個 D1 database，但查詢會依 `line_user_id` 隔離。

## 必要服務設定

1. 建立 Cloudflare D1 database 與 KV namespace，將 ID 填入 `wrangler.toml`。
2. 在 Google Cloud 建立 service account，啟用 Google Sheets API，並把既有試算表分享給 service account email（Editor）。
3. 設定 LINE Messaging API channel 的 webhook URL：`https://<worker-domain>/webhook`。
4. 本機開發可使用 `.env`：

```sh
cp .env.example .env
# 編輯 .env，填入 LINE、Gemini 與 Google service account 值
```

不要同時建立 `.dev.vars`；Wrangler 本機開發時二選一。`.env` 已加入 `.gitignore`，不可提交。

5. 正式 Cloudflare Worker 使用 Secrets：

```sh
wrangler secret put LINE_CHANNEL_SECRET
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
wrangler secret put GEMINI_API_KEY
wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
```

`GOOGLE_SERVICE_ACCOUNT_JSON` 是完整 service account JSON；不要提交到 repository。`GOOGLE_SHEET_ID`、`GOOGLE_SHEET_GID` 與 Gemini model 可在 `wrangler.toml` 的 vars 調整。`wrangler.toml` 的 `[secrets].required` 會協助檢查必要的正式環境 secrets 是否已設定。

## 本機開發與部署

```sh
npm install
npx wrangler d1 migrations apply line-accounting --local
npm run typecheck
npm test
npm run dev
```

建立遠端資源後，把 `wrangler.toml` 的 placeholder 換成實際 ID，再執行：

```sh
npx wrangler d1 migrations apply line-accounting --remote
npm run deploy
```

## 雙寫入與恢復語意

D1 先建立唯一 `draft_id`／`batch_id` 與每筆 `expense_records`，接著追加 Google Sheet。兩邊都成功後，batch 才會是 `completed`，查詢也只統計這些資料。Google API 明確拒絕時標記 `failed`，可用同一個確認按鈕重試；若網路逾時等無法判斷追加是否已成功，標記 `unknown`，不會無條件再次追加，以避免工作表只有 A:E、沒有識別碼欄位時產生重複記帳。

這個設計不宣稱 D1 與 Google Sheet 具備跨系統交易；`sheet_response_json`、`sheet_status`、`sheet_updated_range` 與 batch 狀態是核對與恢復所需的紀錄。正式環境仍建議監控 `commit_batches` 中的 `failed`／`unknown` 資料。
